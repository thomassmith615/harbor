/**
 * Detectors.
 *
 * Two, and the restraint is the point. Every detector added makes the product
 * slightly worse unless it earns its place, because the scarce resource is not
 * compute, it is the user's willingness to keep reading the brief.
 *
 * The economic claim underneath the whole engine: an unclosed loop is a SQL
 * query, not an AI capability. No model finds the candidate. A model is only
 * involved in phrasing the result, and only if you ask for that. This is what
 * makes it affordable to run continuously over an entire mailbox forever, and
 * it is the cost ladder from the architecture doc showing up in the flagship
 * feature rather than in a routing layer.
 *
 * A calendar-conflict detector was considered and cut: Google already tells you
 * about double-bookings, and re-telling you is exactly the kind of thing that
 * trains someone to stop reading.
 */
import { usefulFrom } from "../kernel/time.js";
import { getItem } from "../store/items.js";
import { threadItemIds } from "../store/relationships.js";
import { cosine, fromBlob } from "./embed/index.js";
import {
  bumpDetector,
  interestEmbeddings,
  recordObservation,
  setObservationState,
  openObservations,
} from "../store/signals.js";
import type { DB } from "../kernel/db.js";
import type { Embedder } from "./embed/index.js";
import type { Observation } from "../store/signals.js";

import { detectRecurringSubjects } from "./detectors-topics.js";
import { detectDuePurchases } from "./detectors-purchases.js";
import {
  detectCommitmentsBeforeEvents,
  detectDueCommitments,
  detectLapsedCommitments,
} from "./detectors-commitments.js";

export interface DetectorContext {
  readonly principalId: string;
  readonly timezone: string;
  readonly now: number;
  readonly embedder?: Embedder | undefined;
}

export interface DetectorResult {
  readonly detectorId: string;
  readonly examined: number;
  readonly created: number;
  readonly resolved: number;
}

/** How long an inbound message sits unanswered before it counts. */
const UNCLOSED_AFTER_HOURS = 36;
/** How far back to look. Without this, a large mailbox yields years of dead threads. */
const UNCLOSED_WINDOW_DAYS = 45;
/** An unanswered message stops being actionable eventually. */
const UNCLOSED_EXPIRY_DAYS = 21;

interface LoopRow {
  readonly item_id: string;
  readonly thread_id: string | null;
  readonly title: string | null;
  readonly author: string | null;
  readonly occurred_at: number;
  readonly entity_id: string;
  readonly display_name: string;
  readonly prior_outbound: number;
}

/**
 * Inbound messages with no outbound reply in the same thread.
 *
 * Three filters do the heavy lifting, and each exists because of a specific
 * false positive:
 *
 *   sender is a person, not an org  Newsletters are not unanswered questions.
 *   you have replied to them before Cold outreach from strangers is not a
 *                                   dropped ball, unless an interest says it is.
 *   inside a recent window          A mailbox has years of dead threads and
 *                                   none of them are actionable today.
 */
export function detectUnclosedLoops(db: DB, context: DetectorContext): DetectorResult {
  const detectorId = "unclosed_loop";
  const cutoff = context.now - UNCLOSED_AFTER_HOURS * 3_600_000;
  const floor = context.now - UNCLOSED_WINDOW_DAYS * 86_400_000;

  const rows = db
    .prepare(
      `SELECT
         i.id AS item_id, i.thread_id, i.title, i.author, i.occurred_at,
         e.id AS entity_id, e.display_name,
         (SELECT COUNT(*) FROM item_entities ie2
            JOIN items o2 ON o2.id = ie2.item_id
          WHERE ie2.entity_id = e.id AND o2.direction = 'outbound'
            AND o2.deleted_at IS NULL) AS prior_outbound
       FROM items i
       JOIN accounts a ON a.id = i.account_id
       JOIN item_entities ie ON ie.item_id = i.id AND ie.role = 'author'
       JOIN entities e ON e.id = ie.entity_id
       WHERE i.kind = 'message'
         AND i.direction = 'inbound'
         AND i.deleted_at IS NULL
         AND i.occurred_at < @cutoff
         AND i.occurred_at > @floor
         AND a.custodian_person_id = @principal
         AND e.kind = 'person'
         AND e.merged_into IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM items o
           WHERE o.thread_id = i.thread_id
             AND o.direction = 'outbound'
             AND o.deleted_at IS NULL
             AND o.occurred_at > i.occurred_at
         )
         -- Only the newest inbound message per thread. A five-message thread is
         -- one dropped ball, not five.
         AND i.occurred_at = (
           SELECT MAX(n.occurred_at) FROM items n
           WHERE n.thread_id = i.thread_id AND n.direction = 'inbound'
             AND n.deleted_at IS NULL
         )
       ORDER BY i.occurred_at DESC
       LIMIT 500`,
    )
    .all({ principal: context.principalId, cutoff, floor }) as LoopRow[];

  const interests = matchableInterests(db, context);

  let created = 0;

  for (const row of rows) {
    const match = interests === null ? null : bestInterest(db, interests, row.item_id);

    // Cold outreach only counts when something the user said they care about
    // makes it count.
    if (row.prior_outbound === 0 && match === null) {
      continue;
    }

    const ageDays = (context.now - row.occurred_at) / 86_400_000;

    // Deterministic and deliberately legible: base, plus a little for age, plus
    // a real bump for an established correspondent or a matched interest.
    let salience = 0.35;
    salience += Math.min(ageDays / 14, 1) * 0.15;
    salience += row.prior_outbound > 0 ? 0.2 : 0;
    salience += match === null ? 0 : 0.25 * match.score;

    const created_ = recordObservation(db, {
      principalId: context.principalId,
      detectorId,
      dedupKey: `unclosed:${row.thread_id ?? row.item_id}`,
      title: `${row.display_name} is waiting on a reply`,
      detail:
        `"${row.title ?? "(no subject)"}" arrived ${describeAge(ageDays)} and nothing has gone back.` +
        (match === null ? "" : ` Relates to: ${match.statement}.`),
      salience: Math.min(salience, 1),
      evidence: [row.item_id],
      interestId: match?.interestId ?? null,
      // Detected now, said at a moment a person can act on it.
      earliestUsefulAt: usefulFrom(context.now, context.timezone),
      expiresAt: row.occurred_at + UNCLOSED_EXPIRY_DAYS * 86_400_000,
    });

    if (created_) {
      created += 1;
    }
  }

  const resolved = resolveClosedLoops(db, detectorId);

  return { detectorId, examined: rows.length, created, resolved };
}

/**
 * Closes observations whose situation went away.
 *
 * Without this the engine nags forever about a thread you answered an hour
 * after the last run, which is the fastest possible way to lose someone's
 * attention permanently.
 */
function resolveClosedLoops(db: DB, detectorId: string): number {
  let resolved = 0;

  for (const observation of openObservations(db, detectorId)) {
    const itemId = observation.evidence[0];

    if (itemId === undefined) {
      continue;
    }

    const replied = db
      .prepare(
        `SELECT 1 AS found FROM items o
         JOIN items i ON i.id = @itemId
         WHERE o.thread_id = i.thread_id
           AND o.direction = 'outbound'
           AND o.deleted_at IS NULL
           AND o.occurred_at > i.occurred_at
         LIMIT 1`,
      )
      .get({ itemId }) as { found: number } | undefined;

    if (replied !== undefined) {
      setObservationState(db, observation.id, "acted");
      bumpDetector(db, detectorId, "acted");
      resolved += 1;
    }
  }

  return resolved;
}

interface MatchableInterest {
  readonly interestId: string;
  readonly statement: string;
  readonly vector: Float32Array;
}

function matchableInterests(
  db: DB,
  context: DetectorContext,
): readonly MatchableInterest[] | null {
  if (context.embedder === undefined) {
    return null;
  }

  const rows = interestEmbeddings(db, context.principalId, context.embedder.model);

  if (rows.length === 0) {
    return null;
  }

  return rows.map((row) => ({
    interestId: row.interest.id,
    statement: row.interest.statement,
    vector: fromBlob(row.vector),
  }));
}

/** Similarity between an item's first chunk and the closest active interest. */
function bestInterest(
  db: DB,
  interests: readonly MatchableInterest[],
  itemId: string,
): { readonly interestId: string; readonly statement: string; readonly score: number } | null {
  const row = db
    .prepare(
      `SELECT e.vector AS vector FROM chunks c
       JOIN embeddings e ON e.chunk_id = c.id
       WHERE c.item_id = ? ORDER BY c.ordinal LIMIT 1`,
    )
    .get(itemId) as { vector: Buffer } | undefined;

  if (row === undefined) {
    return null;
  }

  const vector = fromBlob(row.vector);
  let best: { interestId: string; statement: string; score: number } | null = null;

  for (const interest of interests) {
    if (interest.vector.length !== vector.length) {
      continue;
    }

    const score = cosine(vector, interest.vector);

    if (best === null || score > best.score) {
      best = { interestId: interest.interestId, statement: interest.statement, score };
    }
  }

  return best === null || best.score < INTEREST_THRESHOLD ? null : best;
}

/**
 * Similarity below which a match is noise.
 *
 * Set high on purpose. A loose threshold produces a brief full of tenuously
 * related mail, and the user has no way to tell that the threshold is the
 * problem rather than the idea.
 */
const INTEREST_THRESHOLD = 0.55;
const INTEREST_WINDOW_DAYS = 10;
const INTEREST_EXPIRY_DAYS = 14;

/**
 * Recent items that match something the user said they are working on.
 *
 * This is the detector that makes the recruiter example work: the standing
 * interest is what turns "a recruiter emailed you" from a true statement into
 * a relevant one.
 */
export function detectInterestMatches(db: DB, context: DetectorContext): DetectorResult {
  const detectorId = "interest_match";
  const interests = matchableInterests(db, context);

  if (interests === null) {
    return { detectorId, examined: 0, created: 0, resolved: 0 };
  }

  const floor = context.now - INTEREST_WINDOW_DAYS * 86_400_000;

  const rows = db
    .prepare(
      `SELECT i.id AS item_id, i.title, i.kind, i.occurred_at, i.direction
       FROM items i
       JOIN accounts a ON a.id = i.account_id
       WHERE i.deleted_at IS NULL
         AND i.occurred_at > @floor
         AND i.occurred_at <= @now
         AND i.direction IS NOT 'outbound'
         AND a.custodian_person_id = @principal
       ORDER BY i.occurred_at DESC
       LIMIT 400`,
    )
    .all({ principal: context.principalId, floor, now: context.now }) as {
    item_id: string;
    title: string | null;
    kind: string;
    occurred_at: number;
  }[];

  let created = 0;

  for (const row of rows) {
    const match = bestInterest(db, interests, row.item_id);

    if (match === null) {
      continue;
    }

    const wrote = recordObservation(db, {
      principalId: context.principalId,
      detectorId,
      dedupKey: `interest:${match.interestId}:${row.item_id}`,
      title: `Relevant to "${match.statement}"`,
      detail: `${row.kind === "event" ? "Event" : "Message"}: "${row.title ?? "(no subject)"}"`,
      salience: Math.min(0.3 + match.score * 0.6, 1),
      evidence: [row.item_id],
      interestId: match.interestId,
      earliestUsefulAt: usefulFrom(context.now, context.timezone),
      expiresAt: row.occurred_at + INTEREST_EXPIRY_DAYS * 86_400_000,
    });

    if (wrote) {
      created += 1;
    }
  }

  return { detectorId, examined: rows.length, created, resolved: 0 };
}

function describeAge(days: number): string {
  if (days < 2) {
    return "yesterday";
  }
  if (days < 8) {
    return `${String(Math.round(days))} days ago`;
  }
  if (days < 15) {
    return "over a week ago";
  }
  return `${String(Math.round(days / 7))} weeks ago`;
}

export type Detector = (db: DB, context: DetectorContext) => DetectorResult;

/**
 * A commitment on the calendar with a conversation that never closed.
 *
 * The first detector that reads the relationship graph rather than one source,
 * and the reason the graph exists. A meeting tomorrow is not worth mentioning;
 * every calendar shows you that. A meeting tomorrow that was arranged in a
 * thread where the last word was someone else's, and you never replied, is a
 * thing you would want to know and no single application can see it.
 */
function detectUpcomingLooseEnds(db: DB, context: DetectorContext): DetectorResult {
  const detectorId = "upcoming_loose_end";
  const soon = context.now + 3 * 86_400_000;

  const rows = db
    .prepare(
      `SELECT DISTINCT t.id AS thread, t.title AS title, t.ends_at AS ends
       FROM threads t
       JOIN thread_nodes tn ON tn.thread_id = t.id
       JOIN items i ON i.id = tn.node_id AND tn.node_kind = 'item'
       WHERE t.principal_id = @principal
         AND t.source_count >= 2
         AND i.kind = 'event'
         AND i.occurred_at BETWEEN @now AND @soon
         AND i.deleted_at IS NULL
       ORDER BY i.occurred_at
       LIMIT 20`,
    )
    .all({ principal: context.principalId, now: context.now, soon }) as {
    thread: string;
    title: string | null;
    ends: number | null;
  }[];

  let created = 0;

  for (const row of rows) {
    const items = threadItemIds(db, row.thread)
      .map((id) => getItem(db, id))
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const messages = items
      .filter((item) => item.kind === "message")
      .sort((a, b) => b.occurredAt - a.occurredAt);

    const latest = messages[0];

    // The last thing said was theirs, and it was said a while ago. If the last
    // word was yours, there is nothing outstanding.
    if (latest === undefined || latest.direction !== "inbound") {
      continue;
    }

    if (context.now - latest.occurredAt < 24 * 3_600_000) {
      continue;
    }

    const event = items.find((item) => item.kind === "event");

    if (event === undefined) {
      continue;
    }

    const recorded = recordObservation(db, {
      principalId: context.principalId,
      detectorId,
      dedupKey: `loose:${row.thread}`,
      title: `${event.title ?? "Something"} is coming up and the thread about it went quiet`,
      detail:
        `The last word was theirs, ${describeAge(Math.round((context.now - latest.occurredAt) / 86_400_000))}: ` +
        // A text's title is the handle it came from, which says nothing. The
        // body is the message.
        `"${quoteOf(latest)}". ` +
        `Pieces of this are in ${String(new Set(items.map((item) => item.kind)).size)} places.`,
      salience: 0.8,
      // Every item in the situation, so "why did you think that" is answerable
      // with the whole picture rather than the one message that triggered it.
      evidence: items.slice(0, 6).map((item) => item.id),
      interestId: null,
      earliestUsefulAt: usefulFrom(context.now, context.timezone),
      expiresAt: event.occurredAt + 86_400_000,
    });

    if (recorded) {
      created += 1;
    }
  }

  return { detectorId, examined: rows.length, created, resolved: 0 };
}

/**
 * A line worth quoting back.
 *
 * For mail the subject is the summary. For a text the "title" is the phone
 * number it arrived from, so quoting it tells the reader nothing at all.
 */
function quoteOf(item: { title: string | null; snippet: string | null; body: string | null }): string {
  const title = item.title ?? "";
  const looksLikeHandle = /^\+?\d[\d\s()-]{6,}$/.test(title.trim());

  if (!looksLikeHandle && title.length > 0) {
    return title.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  // Whichever actually says something. A snippet is usually the better summary
  // and is occasionally a stub.
  const snippet = (item.snippet ?? "").replace(/\s+/g, " ").trim();
  const body = (item.body ?? "").replace(/\s+/g, " ").trim();
  const text = snippet.length >= 12 ? snippet : body.length > 0 ? body : snippet;

  return text.length === 0 ? title : text.slice(0, 80);
}

export const DETECTORS: readonly { readonly id: string; readonly run: Detector }[] = [
  { id: "unclosed_loop", run: detectUnclosedLoops },
  { id: "interest_match", run: detectInterestMatches },
  { id: "upcoming_loose_end", run: detectUpcomingLooseEnds },
  // Detectors that read commitments rather than items. Kept in their own file
  // because they reason about a state that persisted rather than a moment that
  // happened, which is a different question with different failure modes.
  { id: "commitment_due", run: detectDueCommitments },
  { id: "commitment_before_event", run: detectCommitmentsBeforeEvents },
  { id: "commitment_lapsed", run: detectLapsedCommitments },
  // The one detector that reasons about a pattern over time rather than a
  // state: a subject recurring across conversations, and mail that touches it.
  { id: "recurring_subject", run: detectRecurringSubjects },

  // Restocking. The one detector that reads the purchase history rather than
  // the mailbox, and the closest thing here to the product as it was
  // described: Harbor keeps the receipts and eventually says you are probably
  // out of something.
  { id: "purchase_due", run: detectDuePurchases },
];

export type { Observation };
