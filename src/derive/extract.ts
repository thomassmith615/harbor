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
import { saveProjection } from "../store/projections.js";
import { recoverJson } from "../reasoning/json.js";
import { isTransfer } from "../projections/merchants.js";
import { route } from "../reasoning/router.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";

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

    let routed;

    try {
      routed = await route(
        db,
        "extract.structured",
        { system: PURCHASE_SYSTEM, messages: [{ role: "user", content: source }] },
        { principalId, pipelineVersion: PROJECTION_VERSION },
      );
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

    if (recovery.error !== null) {
      rejected.push(`${candidate.id}: ${recovery.error}`);
      options.onProgress?.(read, candidates.length);
      continue;
    }

    // Counted rather than logged per item, because on a reasoning model this is
    // every response and the note would drown the output. A high count means
    // the model is fighting the prompt, which is worth knowing and is not an
    // error.
    for (const repair of recovery.repaired) {
      repairs.set(repair, (repairs.get(repair) ?? 0) + 1);
    }

    const verdict = verifyPurchase(recovery.value, source);

    if (verdict.rejected !== null) {
      rejected.push(`${candidate.id}: ${verdict.rejected}`);
      options.onProgress?.(read, candidates.length);
      continue;
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
      type: isTransfer(verdict.purchase.merchant) ? "transfer" : "purchase",
      schemaVersion: PURCHASE_SCHEMA_VERSION,
      // The stated date when there is one, otherwise when the mail arrived. A
      // receipt usually arrives the same day, and a wrong date is worse than an
      // approximate one for anything that groups by month.
      occurredAt: purchase.occurred ?? row.occurred_at,
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
      model: routed.result.model,
      lines: purchase.lines,
    });

    db.prepare(`UPDATE items SET projection_version = ? WHERE id = ?`).run(
      PROJECTION_VERSION,
      candidate.id,
    );

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
    durationMs: Date.now() - started,
  };
}
