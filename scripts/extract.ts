/**
 * The projection pass.
 *
 * Same shape as every other derivation here: versioned, incremental,
 * resumable, and driven off a column that `upsertItem` clears when content
 * changes. What differs is that this one spends money per item, so the
 * deterministic half is separated out and made inspectable before the
 * expensive half runs.
 *
 * That separation is the reason `--dry-run` exists and is not a nicety. On a
 * mailbox that is mostly marketing, the number of items a real run would read
 * is the single most useful thing to know before starting, and it is free to
 * compute.
 */
import {
  looksLikePurchase,
  PURCHASE_SCHEMA_VERSION,
  PURCHASE_SYSTEM,
  verifyPurchase,
} from "../projections/purchase.js";
import { attachmentTextFor } from "../store/attachments.js";
import {
  dropProjectionsFor,
  dropStaleProjections,
  projectionForItem,
  saveProjection,
} from "../store/projections.js";
import { recoverJson } from "../reasoning/json.js";
import { isSharedSender, isTransfer } from "../projections/merchants.js";
import { purchaseRejection } from "../projections/purchase.js";
import { forgetCached, nextTierAbove, route } from "../reasoning/router.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";
import { TIERS } from "../reasoning/tasks.js";
import type { Tier } from "../reasoning/tasks.js";
import type { CompletionRequest } from "../reasoning/provider.js";
import type { RouteResult } from "../reasoning/router.js";
import type { PurchaseVerdict } from "../projections/purchase.js";

/** Bump to re-extract everything. */
export const PROJECTION_VERSION = 1;

/** How much of an item is shown to the extractor. Receipts put the total early. */
const MAX_SOURCE_CHARS = 6_000;

/**
 * Only sources that can contain a receipt.
 *
 * A text message is not a receipt, and queueing 35,000 of them for a projection
 * that reads email was not merely wasteful: `Remaining` reported 23,705 items
 * after a pass that had actually finished, because the predicate marks a
 * bounded pool per run and a quarter of the store could never leave the queue.
 * A finished job looked like one percent progress.
 *
 * The same reasoning as the relationship graph, one layer down: the unit of
 * work should be the things the pass can possibly say something about.
 */
const MAIL_ONLY = `
  JOIN streams s ON s.id = i.stream_id
  WHERE i.kind = 'message' AND i.deleted_at IS NULL
    AND s.connector_id NOT IN ('imessage')`;

interface CandidateRow {
  readonly id: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly author: string | null;
  readonly occurred_at: number;
}

export interface Candidate {
  readonly id: string;
  readonly title: string | null;
  readonly author: string | null;
  readonly occurredAt: number;
}

/**
 * Items that look like a purchase, without spending anything.
 *
 * Scans a bounded pool rather than the whole mailbox per call, because the
 * predicate is cheap but not free and a caller usually wants a page of results
 * rather than a census.
 */
export interface CandidateFunnel {
  /** Mail items in the store at all, before any filtering. */
  readonly mailItems: number;
  /** Of those, how many this projection version has not yet judged. */
  readonly unjudged: number;
  /** How many of the unjudged were actually inspected this pass. */
  readonly inspected: number;
  readonly passed: number;
  readonly rejected: Readonly<Record<string, number>>;
  /** How many inspected items carried extracted attachment text. */
  readonly withAttachmentText: number;
  /** Senders rejected as untrusted, most frequent first. Usually the answer. */
  readonly topUntrustedSenders: readonly { readonly sender: string; readonly count: number }[];
}

/**
 * Where the candidates went.
 *
 * `looksLikePurchase` has four sequential gates that all return the same
 * `false`, so an empty purchases store gives no clue which one is responsible:
 * no mail at all, everything already judged, marketing filter too broad, sender
 * trust rejecting real merchants, or receipts arriving as PDFs whose text was
 * never extracted. Those need entirely different fixes and looked identical.
 *
 * Reads nothing it does not already read and spends nothing.
 */
export function purchaseFunnel(db: DB, pool = 4_000): CandidateFunnel {
  const mailItems = (
    db.prepare(`SELECT COUNT(*) AS n FROM items i ${MAIL_ONLY}`).get() as { n: number }
  ).n;

  const unjudged = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i ${MAIL_ONLY}
           AND (i.projection_version IS NULL OR i.projection_version <> @version)`,
      )
      .get({ version: PROJECTION_VERSION }) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT i.id, i.title, SUBSTR(i.body, 1, 6000) AS body, i.author, i.occurred_at
       FROM items i ${MAIL_ONLY}
         AND (i.projection_version IS NULL OR i.projection_version <> @version)
       ORDER BY i.occurred_at DESC
       LIMIT @pool`,
    )
    .all({ version: PROJECTION_VERSION, pool }) as CandidateRow[];

  const rejected: Record<string, number> = {};
  const untrusted = new Map<string, number>();
  let passed = 0;
  let withAttachmentText = 0;

  for (const row of rows) {
    const attachmentText = attachmentTextFor(db, row.id);

    if (attachmentText !== null && attachmentText.trim().length > 0) {
      withAttachmentText += 1;
    }

    const reason = purchaseRejection({
      title: row.title,
      body: row.body,
      author: row.author,
      attachmentText,
    });

    if (reason === null) {
      passed += 1;
      continue;
    }

    rejected[reason] = (rejected[reason] ?? 0) + 1;

    if (reason === "untrusted_sender" && row.author !== null) {
      const domain = row.author.includes("@") ? row.author.slice(row.author.indexOf("@")) : row.author;
      untrusted.set(domain, (untrusted.get(domain) ?? 0) + 1);
    }
  }

  return {
    mailItems,
    unjudged,
    inspected: rows.length,
    passed,
    rejected,
    withAttachmentText,
    topUntrustedSenders: [...untrusted.entries()]
      .map(([sender, count]) => ({ sender, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  };
}

export function purchaseCandidates(
  db: DB,
  limit: number,
  pool = 4_000,
): readonly Candidate[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.title, SUBSTR(i.body, 1, 6000) AS body, i.author, i.occurred_at
       FROM items i ${MAIL_ONLY}
         AND (i.projection_version IS NULL OR i.projection_version <> @version)
       ORDER BY i.occurred_at DESC
       LIMIT @pool`,
    )
    .all({ version: PROJECTION_VERSION, pool }) as CandidateRow[];

  const found: Candidate[] = [];

  for (const row of rows) {
    const attachmentText = attachmentTextFor(db, row.id);

    if (!looksLikePurchase({ title: row.title, body: row.body, author: row.author, attachmentText })) {
      continue;
    }

    found.push({
      id: row.id,
      title: row.title,
      author: row.author,
      occurredAt: row.occurred_at,
    });

    if (found.length >= limit) {
      break;
    }
  }

  return found;
}

/**
 * Marks items the predicate rejected.
 *
 * Separate from extraction because "this is not a receipt" is a complete
 * answer, not a skipped one. Without it every run would re-scan the entire
 * mailbox to reach the same conclusion.
 */
/**
 * When a purchase happened, sceptically.
 *
 * A receipt states a date and the email carrying it has one, and the stated
 * date was trusted absolutely. Small models guess years: a June receipt came
 * back dated 2024, which is not wrong by a little, it is outside every window
 * anything asks about. Seventeen purchases were extracted and three appeared in
 * a ninety-day report, because the rest had been quietly filed two years ago.
 *
 * A receipt arrives when the purchase happens, near enough. So the stated date
 * is used when it is close to the message that carried it, and the message's
 * own date otherwise. Both are facts; the arrival date is the one that cannot
 * be hallucinated.
 *
 * Asymmetric on purpose. A receipt can plausibly arrive a few days after the
 * purchase and cannot plausibly arrive months before it, so a date in the
 * future relative to the email is rejected much harder than one in the past.
 */
const STATED_BEFORE_MS = 30 * 86_400_000;
const STATED_AFTER_MS = 2 * 86_400_000;

export function purchaseDate(stated: number | null, arrived: number): number {
  if (stated === null) {
    return arrived;
  }

  const drift = stated - arrived;

  if (drift < -STATED_BEFORE_MS || drift > STATED_AFTER_MS) {
    return arrived;
  }

  return stated;
}

/**
 * How many times an email is re-read before Harbor stops trying.
 *
 * Fourteen items failed on every pass, several of them marketing pages that
 * will never contain a total, at roughly six seconds each. The queue never
 * drained and every future run paid the same cost for the same answer.
 *
 * Three, because the model is not deterministic and a second attempt genuinely
 * does sometimes succeed: a real run recovered twelve items on a retry. Three
 * failures is a message that cannot be read rather than a call that went badly.
 */
const MAX_ATTEMPTS = 3;

/**
 * Failed attempts, kept as a projection of their own.
 *
 * In the projections table rather than a new column, because it is versioned
 * the same way: when extraction rules change, the count is dropped along with
 * everything else and an item that used to be unreadable gets another chance
 * under the new rules.
 */
function recordFailure(db: DB, principalId: string, itemId: string, at: number): number {
  const existing = projectionForItem(db, itemId, "extraction_failure");
  const attempts = Number(existing?.payload["attempts"] ?? 0) + 1;

  saveProjection(db, {
    principalId,
    itemId,
    type: "extraction_failure",
    schemaVersion: PURCHASE_SCHEMA_VERSION,
    occurredAt: at,
    merchant: null,
    currency: null,
    totalCents: null,
    reference: null,
    payload: { attempts },
    confidence: 1,
    model: null,
  });

  if (attempts >= MAX_ATTEMPTS) {
    // Out of the queue. The email is still in the store and still searchable;
    // Harbor has simply stopped paying to re-read it.
    db.prepare(`UPDATE items SET projection_version = ? WHERE id = ?`).run(
      PROJECTION_VERSION,
      itemId,
    );
  }

  return attempts;
}

/**
 * Whether anything other than this one email says the purchase happened.
 *
 * The question the sender check could not answer. A real merchant leaves a
 * trail: an order confirmation, then a shipping notice, then a delivery notice,
 * often a review request weeks later, and for anything you actually chose,
 * usually a reply or a conversation somewhere. A single email claiming a
 * seven-hundred-dollar phone, from a sender who has never written before or
 * since, is the shape of a scam or a mistake, and it is exactly the shape the
 * envelope test passes: the domain was Shopify's own, which every Shopify store
 * shares.
 *
 * Corroboration is counted rather than judged. Two or more messages from the
 * same sender, or any message you sent them, is enough. Below that, a large
 * purchase is recorded and kept out of the spending total until you say
 * otherwise, which is the same stance the fact layer already takes: Harbor may
 * notice, it may not decide.
 *
 * Only applied above a threshold. A twelve-dollar lunch that arrives once from
 * a restaurant's ordering platform is not worth doubting, and a rule that
 * doubts everything is one nobody reads.
 */
const CORROBORATION_THRESHOLD_CENTS = 15_000;

/**
 * Which shelf a verified purchase belongs on.
 *
 * Three: money that moved rather than was spent, a large purchase nothing else
 * in the store corroborates, and everything else.
 */
function purchaseType(
  db: DB,
  purchase: { merchant: string | null; totalCents: number | null },
  author: string | null,
): string {
  if (isTransfer(purchase.merchant)) {
    return "transfer";
  }

  const large = (purchase.totalCents ?? 0) >= CORROBORATION_THRESHOLD_CENTS;

  if (large && isSharedSender(author) && !corroborated(db, author)) {
    return "purchase_unconfirmed";
  }

  return "purchase";
}

function corroborated(db: DB, author: string | null): boolean {
  if (author === null) {
    return false;
  }

  const address = (/<([^<>]+)>/.exec(author)?.[1] ?? author).trim().toLowerCase();

  if (address.length === 0) {
    return false;
  }

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items
       WHERE deleted_at IS NULL AND LOWER(author) LIKE '%' || ? || '%'`,
    )
    .get(address) as { n: number };

  if (row.n > 1) {
    return true;
  }

  // Or you wrote to them, which is the strongest signal there is.
  const replied = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items i, json_each(i.participants)
       WHERE i.direction = 'outbound' AND i.deleted_at IS NULL
         AND LOWER(json_each.value) = ?`,
    )
    .get(address) as { n: number };

  return replied.n > 0;
}

function markUninteresting(db: DB, pool: number): number {
  const rows = db
    .prepare(
      `SELECT i.id, i.title, SUBSTR(i.body, 1, 6000) AS body, i.author
       FROM items i ${MAIL_ONLY}
         AND (i.projection_version IS NULL OR i.projection_version <> @version)
       ORDER BY i.occurred_at DESC
       LIMIT @pool`,
    )
    .all({ version: PROJECTION_VERSION, pool }) as CandidateRow[];

  const mark = db.prepare(`UPDATE items SET projection_version = ? WHERE id = ?`);
  let marked = 0;

  const work = db.transaction(() => {
    for (const row of rows) {
      const attachmentText = attachmentTextFor(db, row.id);

      if (!looksLikePurchase({ title: row.title, body: row.body, author: row.author, attachmentText })) {
        // An email that used to produce a purchase and no longer qualifies is
        // the case with no replacement row. The scam receipts were exactly
        // this: still in the table, and re-read for free every pass by the
        // predicate that had already rejected them.
        dropProjectionsFor(db, row.id, "purchase");
        dropProjectionsFor(db, row.id, "transfer");

        mark.run(PROJECTION_VERSION, row.id);
        marked += 1;
      }
    }
  });

  work();

  return marked;
}

export interface ExtractReport {
  readonly considered: number;
  readonly read: number;
  readonly written: number;
  readonly notPurchases: number;
  readonly rejected: readonly string[];
  readonly skippedFree: number;
  readonly costMicros: number;
  readonly model: string | null;
  readonly tier: string | null;
  readonly remaining: number;
  /** What had to be stripped from model output, by kind. */
  readonly repairs: readonly { readonly kind: string; readonly count: number }[];
  /** Items retried one tier up after the cheap answer failed. */
  readonly escalated: number;
  /** Of those, how many the better model actually got right. */
  readonly rescued: number;
  readonly durationMs: number;
}

export interface ExtractOptions {
  readonly principalId?: string;
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
}

export async function extractPurchases(
  db: DB,
  options: ExtractOptions = {},
): Promise<ExtractReport> {
  const started = Date.now();
  const principalId = options.principalId ?? DEFAULT_PRINCIPAL;
  const budget = options.limit ?? 50;

  // Old rules first.
  //
  // A projection outlives the reasoning that produced it, and a rule that says
  // "this is not a purchase" writes nothing, so it cannot overwrite anything.
  // Without this, an invoice scam and $1,650 of brokerage transfers survived
  // two full passes under rules that had already rejected them.
  const stale =
    dropStaleProjections(db, "purchase", PURCHASE_SCHEMA_VERSION) +
    dropStaleProjections(db, "transfer", PURCHASE_SCHEMA_VERSION) +
    dropStaleProjections(db, "extraction_failure", PURCHASE_SCHEMA_VERSION) +
    dropStaleProjections(db, "purchase_unconfirmed", PURCHASE_SCHEMA_VERSION);

  if (stale > 0) {
    options.onNote?.(
      `${String(stale)} purchases from an older set of rules removed; they will be re-read`,
    );
  }

  const skippedFree = markUninteresting(db, 4_000);

  if (skippedFree > 0) {
    options.onNote?.(`${String(skippedFree)} items were not receipts, decided for free`);
  }

  const candidates = purchaseCandidates(db, budget);

  let read = 0;
  let written = 0;
  let notPurchases = 0;
  let cost = 0;
  let model: string | null = null;
  let tier: string | null = null;
  const rejected: string[] = [];
  const repairs = new Map<string, number>();

  let escalated = 0;
  let rescued = 0;

  /**
   * How far escalation is allowed to climb.
   *
   * A receipt is not worth the premium tier, and a fifty item backlog reaching
   * it would produce a real bill that nobody chose. Extraction is a volume
   * task; the ceiling is what keeps it cheap.
   */
  const CEILING: Tier = "cloud_cheap";

  /**
   * The same request, one tier up.
   *
   * Escalation as an outcome rather than a prediction. Guessing which receipts
   * are hard is difficult; noticing that a cheap answer failed verification is
   * trivial, and by then the evidence is in hand. On a real mailbox the free
   * local tier failed 26 of 50 items, so this is the difference between half
   * the receipts and nearly all of them, at a cost measured in cents.
   *
   * The cached failure is forgotten first, or the retry replays the answer that
   * just failed and the escalation is theatre.
   */
  const retryHigher = async (
    from: Tier,
    request: CompletionRequest,
    source: string,
  ): Promise<{ readonly verdict: PurchaseVerdict; readonly routed: RouteResult } | null> => {
    // Climb rather than take one step.
    //
    // The declared floor is `local_small`, and the tier immediately above it is
    // `local_large`, which is another local model and costs nothing. A single
    // retry therefore never reaches the cloud at all, which would make this
    // change free and almost useless. Climbing means the free option is tried
    // first and cents are spent only when it also fails.
    //
    // Stops at CEILING. A grocery receipt does not justify the premium tier,
    // and letting a bulk pass reach it would turn a fifty item backlog into a
    // real bill without anyone choosing that.
    let from_ = from;

    while (true) {
      const up = nextTierAbove(from_);

      if (up === null || TIERS.indexOf(up) > TIERS.indexOf(CEILING)) {
        return null;
      }

      from_ = up;

      // Or the retry replays the answer that just failed and the escalation is
      // theatre.
      forgetCached(db, "extract.structured", request, PROJECTION_VERSION);

      let routed;

      try {
        routed = await route(db, "extract.structured", request, {
          principalId,
          pipelineVersion: PROJECTION_VERSION,
          minTier: up,
        });
      } catch {
        continue;
      }

      escalated += 1;

      // A tier that cannot serve this task resolves to the same one again, and
      // running it twice is pure waste.
      if (routed.tier === from) {
        continue;
      }

      const text = routed.result.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");

      const recovery = recoverJson(text);

      if (recovery.error !== null) {
        continue;
      }

      const verdict = verifyPurchase(recovery.value, source);

      // A rejection here is not the end: the next tier up may still get it
      // right, and the caller decides what to do when the climb runs out.
      if (verdict.rejected !== null && TIERS.indexOf(routed.tier) < TIERS.indexOf(CEILING)) {
        continue;
      }

      return { verdict, routed };
    }
  };

  for (const candidate of candidates) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const row = db
      .prepare(`SELECT title, body, author, occurred_at FROM items WHERE id = ?`)
      .get(candidate.id) as
      | { title: string | null; body: string | null; author: string | null; occurred_at: number }
      | undefined;

    if (row === undefined) {
      continue;
    }

    const attachmentText = attachmentTextFor(db, candidate.id);

    const source = [
      row.title ?? "",
      row.author === null ? "" : `From: ${row.author}`,
      row.body ?? "",
      attachmentText ?? "",
    ]
      .join("\n")
      .slice(0, MAX_SOURCE_CHARS);

    const request = {
      system: PURCHASE_SYSTEM,
      messages: [{ role: "user" as const, content: source }],
      // A long itinerary with a dozen line items overruns the default and the
      // reply stops mid-object. It reads as "no JSON object in the response",
      // which sounds like a model that cannot follow instructions and is
      // actually one that ran out of room.
      maxTokens: 4_096,
    };

    let routed;

    try {
      routed = await route(db, "extract.structured", request, {
        principalId,
        pipelineVersion: PROJECTION_VERSION,
      });
    } catch (error) {
      // One item failing is not the pass failing. The item stays pending and
      // is retried next run, the same contract the derive pass now honours.
      options.onNote?.(`extraction failed for ${candidate.id}: ${String(error)}`);
      continue;
    }

    read += 1;
    cost += routed.costMicros;
    model = routed.result.model;
    tier = routed.tier;

    const text = routed.result.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");

    const recovery = recoverJson(text);

    let verdict: PurchaseVerdict | null = null;
    let verdictModel = routed.result.model;

    if (recovery.error !== null) {
      // A model that answered in prose rather than JSON is not a model that
      // read the email and declined. Try once, higher, before giving up.
      const better = await retryHigher(routed.tier, request, source);

      if (better !== null) {
        verdict = better.verdict;
        verdictModel = better.routed.result.model;
        cost += better.routed.costMicros;

        // Counted here too, and it was not. A rescue on the unparseable-output
        // path is every bit as much a rescue as one on the verification path,
        // and leaving it out produced "Escalated 1, 0 rescued" on a run that
        // wrote a purchase, which reads as escalation having achieved nothing.
        if (better.verdict.rejected === null) {
          rescued += 1;
        }
      } else {
        // So the retry is a retry. A cached answer that could not be parsed is a
        // cached failure, and replaying it makes re-running the pass pointless.
        forgetCached(db, "extract.structured", request, PROJECTION_VERSION);
        dropProjectionsFor(db, candidate.id, "purchase");
        dropProjectionsFor(db, candidate.id, "transfer");
        const attempts = recordFailure(db, principalId, candidate.id, candidate.occurredAt);
        rejected.push(
          `${candidate.id}: ${recovery.error}${attempts >= MAX_ATTEMPTS ? " (giving up)" : ""}`,
        );
        options.onProgress?.(read, candidates.length);
        continue;
      }
    }

    // Counted rather than logged per item, because on a reasoning model this is
    // every response and the note would drown the output. A high count means
    // the model is fighting the prompt, which is worth knowing and is not an
    // error.
    for (const repair of recovery.repaired) {
      repairs.set(repair, (repairs.get(repair) ?? 0) + 1);
    }

    verdict ??= verifyPurchase(recovery.value, source);

    if (verdict.purchase === null) {
      // Parsed, and then failed checking. Same reasoning: a cached answer that
      // did not survive verification is not worth replaying.
      forgetCached(db, "extract.structured", request, PROJECTION_VERSION);
    }

    if (verdict.rejected !== null) {
      // A hallucinated total is the signature failure of a small model, and it
      // is exactly the case a better one gets right. Only escalate if we have
      // not already: a second failure is a real rejection, not a cheap one.
      const better =
        verdictModel === routed.result.model
          ? await retryHigher(routed.tier, request, source)
          : null;

      if (better !== null && better.verdict.rejected === null) {
        cost += better.routed.costMicros;
        verdict = better.verdict;
        verdictModel = better.routed.result.model;
        rescued += 1;
      } else {
        if (better !== null) {
          cost += better.routed.costMicros;
        }

        const attempts = recordFailure(db, principalId, candidate.id, candidate.occurredAt);
        rejected.push(
          `${candidate.id}: ${verdict.rejected ?? "rejected"}` +
            (attempts >= MAX_ATTEMPTS ? " (giving up)" : ""),
        );
        options.onProgress?.(read, candidates.length);
        continue;
      }
    }

    if (verdict.purchase === null) {
      // The model read it and said it is not a purchase. That is an answer, so
      // the item is marked and never read again.
      notPurchases += 1;
      db.prepare(`UPDATE items SET projection_version = ? WHERE id = ?`).run(
        PROJECTION_VERSION,
        candidate.id,
      );
      options.onProgress?.(read, candidates.length);
      continue;
    }

    const purchase = verdict.purchase;

    dropProjectionsFor(db, candidate.id, "extraction_failure");
    dropProjectionsFor(db, candidate.id, "purchase_unconfirmed");

    saveProjection(db, {
      principalId,
      itemId: candidate.id,
      // Money that moved is not money spent.
      //
      // A brokerage transfer, a card payment, and a peer-to-peer send are all
      // real and none of them are purchases. On a real report they were $2,600
      // of a $4,885 total, which makes every other number in it meaningless.
      // Recorded under their own type rather than discarded: "$1,522 to
      // Robinhood on June 15" is worth keeping, it just is not spending.
      type: purchaseType(db, verdict.purchase, row.author),
      schemaVersion: PURCHASE_SCHEMA_VERSION,
      // The stated date when there is one, otherwise when the mail arrived. A
      // receipt usually arrives the same day, and a wrong date is worse than an
      // approximate one for anything that groups by month.
      occurredAt: purchaseDate(purchase.occurred, row.occurred_at),
      merchant: purchase.merchant,
      currency: purchase.currency,
      totalCents: purchase.totalCents,
      reference: purchase.reference,
      payload: {
        merchant: purchase.merchant,
        total: purchase.totalCents === null ? null : purchase.totalCents / 100,
        currency: purchase.currency,
        reference: purchase.reference,
      },
      confidence: purchase.confidence,
      // The model that actually produced the accepted answer, which after an
      // escalation is not the one the router first picked. Recording the cheap
      // model here would make the provenance a lie.
      model: verdictModel,
      lines: purchase.lines,
    });

    db.prepare(`UPDATE items SET projection_version = ? WHERE id = ?`).run(
      PROJECTION_VERSION,
      candidate.id,
    );

    // The reported model follows the accepted answer, not the router's first
    // pick. A run that escalated and succeeded used to report the cheap model
    // it had abandoned, which is the same provenance lie the projection row
    // was already fixed to avoid.
    model = verdictModel;

    written += 1;
    options.onProgress?.(read, candidates.length);
  }

  const remaining = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i ${MAIL_ONLY}
           AND (i.projection_version IS NULL OR i.projection_version <> @version)`,
      )
      .get({ version: PROJECTION_VERSION }) as { n: number }
  ).n;

  return {
    considered: candidates.length,
    read,
    written,
    notPurchases,
    rejected,
    skippedFree,
    costMicros: cost,
    model,
    tier,
    remaining,
    repairs: [...repairs.entries()].map(([kind, count]) => ({ kind, count })),
    escalated,
    rescued,
    durationMs: Date.now() - started,
  };
}
