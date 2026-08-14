/**
 * What Harbor knows about the person, as opposed to what happened to them.
 *
 * Everything else in the store is an event or something derived from one. This
 * holds standing facts: a dietary restriction, which airport somebody flies
 * from, that a particular name is a landlord rather than a friend. They change
 * rarely, apply to almost every question, and are the reason a system that has
 * been used for a year answers better than one used for a week.
 *
 * The whole design is about trust rather than storage.
 *
 * A fact is `proposed` until the person says otherwise. Only `confirmed` facts
 * are ever shown to a model or used to shape an answer. Harbor is allowed to
 * notice things; it is not allowed to decide them. That asymmetry is the
 * difference between a system whose mistakes surface as a question and one
 * whose mistakes surface as months of subtly wrong behaviour nobody can trace.
 *
 * `rejected` is permanent. Somebody who has said "no, that is wrong" should not
 * have to say it again every time the same conversation is re-read.
 */
import { createHash } from "node:crypto";
import type { DB } from "../kernel/db.js";

export type FactState = "proposed" | "confirmed" | "rejected";

/**
 * Deliberately few, and deliberately coarse.
 *
 * A taxonomy invented up front is a taxonomy that fits nothing. These are the
 * distinctions that change how a fact gets used: a preference shapes
 * suggestions, a constraint rules things out, a relationship disambiguates a
 * name, and a routine predicts when something will happen.
 */
export type FactKind = "preference" | "constraint" | "relationship" | "routine" | "detail";

export interface Fact {
  readonly id: string;
  readonly kind: FactKind;
  readonly statement: string;
  readonly state: FactState;
  readonly confidence: number;
  readonly origin: string;
  readonly sourceItem: string | null;
  readonly sourceEpisode: string | null;
  readonly quote: string | null;
  readonly firstSeenAt: number;
  readonly decidedAt: number | null;
}

interface FactRow {
  readonly id: string;
  readonly kind: string;
  readonly statement: string;
  readonly state: string;
  readonly confidence: number;
  readonly origin: string;
  readonly source_item: string | null;
  readonly source_episode: string | null;
  readonly quote: string | null;
  readonly first_seen_at: number;
  readonly decided_at: number | null;
}

function hydrate(row: FactRow): Fact {
  return {
    id: row.id,
    kind: row.kind as FactKind,
    statement: row.statement,
    state: row.state as FactState,
    confidence: row.confidence,
    origin: row.origin,
    sourceItem: row.source_item,
    sourceEpisode: row.source_episode,
    quote: row.quote,
    firstSeenAt: row.first_seen_at,
    decidedAt: row.decided_at,
  };
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "and", "or", "of", "in", "on", "at", "with",
  "is", "are", "was", "were", "be", "been", "my", "our", "his", "her", "their",
  "i", "we", "you", "it", "this", "that", "does", "do", "not", "no",
]);

/**
 * A comparable form, so the same fact stated twice does not become two facts.
 *
 * Negation words are kept deliberately. "eats pork" and "does not eat pork"
 * must never collapse into one row, and a stopword list that strips "not" is
 * how that happens.
 */
export function normalizeFact(statement: string): string {
  const words = statement
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));

  return [...new Set(words)].sort().join(" ");
}

export interface FactInput {
  readonly principalId: string;
  readonly kind: FactKind;
  readonly statement: string;
  readonly state: FactState;
  readonly confidence: number;
  readonly origin: string;
  readonly sourceItem?: string | null;
  readonly sourceEpisode?: string | null;
  readonly quote?: string | null;
}

export interface RecordFactOutcome {
  readonly id: string;
  readonly created: boolean;
  readonly state: FactState;
}

/**
 * Files a fact, without ever overriding a decision the person already made.
 *
 * The conflict clause is the important part. Re-reading the same conversation
 * next month must not resurrect something that was rejected, and must not
 * quietly downgrade something that was confirmed back to proposed.
 */
export function recordFact(db: DB, input: FactInput): RecordFactOutcome {
  const normalized = normalizeFact(input.statement);

  if (normalized.length === 0) {
    return { id: "", created: false, state: "rejected" };
  }

  const id = `ft_${createHash("sha256")
    .update(`${input.principalId}|${normalized}`)
    .digest("hex")
    .slice(0, 16)}`;

  const existing = db.prepare(`SELECT state FROM facts WHERE id = ?`).get(id) as
    | { state: string }
    | undefined;

  if (existing !== undefined) {
    // A decision, once made, stands. Only the evidence is refreshed.
    db.prepare(
      `UPDATE facts SET confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?`,
    ).run(input.confidence, Date.now(), id);

    return { id, created: false, state: existing.state as FactState };
  }

  const now = Date.now();

  db.prepare(
    `INSERT INTO facts
       (id, principal_id, kind, statement, normalized, state, confidence, origin,
        source_item, source_episode, quote, first_seen_at, decided_at, updated_at)
     VALUES (@id, @principal, @kind, @statement, @normalized, @state, @confidence, @origin,
             @sourceItem, @sourceEpisode, @quote, @now, @decidedAt, @now)`,
  ).run({
    id,
    principal: input.principalId,
    kind: input.kind,
    statement: input.statement,
    normalized,
    state: input.state,
    confidence: input.confidence,
    origin: input.origin,
    sourceItem: input.sourceItem ?? null,
    sourceEpisode: input.sourceEpisode ?? null,
    quote: input.quote ?? null,
    // A fact the person stated themselves is decided the moment it is written.
    decidedAt: input.state === "confirmed" ? now : null,
    now,
  });

  return { id, created: true, state: input.state };
}

export function decideFact(db: DB, id: string, state: FactState): boolean {
  const changed = db
    .prepare(`UPDATE facts SET state = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
    .run(state, Date.now(), Date.now(), id).changes;

  return changed > 0;
}

export function forgetFact(db: DB, id: string): boolean {
  return db.prepare(`DELETE FROM facts WHERE id = ?`).run(id).changes > 0;
}

export function listFacts(
  db: DB,
  principalId: string,
  state?: FactState,
  limit = 100,
): readonly Fact[] {
  const rows =
    state === undefined
      ? (db
          .prepare(
            `SELECT * FROM facts WHERE principal_id = ? ORDER BY state, kind, first_seen_at LIMIT ?`,
          )
          .all(principalId, limit) as FactRow[])
      : (db
          .prepare(
            `SELECT * FROM facts WHERE principal_id = ? AND state = ?
             ORDER BY kind, first_seen_at LIMIT ?`,
          )
          .all(principalId, state, limit) as FactRow[]);

  return rows.map(hydrate);
}

export function getFact(db: DB, id: string): Fact | null {
  const row = db.prepare(`SELECT * FROM facts WHERE id = ?`).get(id) as FactRow | undefined;

  return row === undefined ? null : hydrate(row);
}

/**
 * The confirmed facts, as lines a model can be given.
 *
 * Bounded hard. This text is prepended to every question, so it is a standing
 * tax on every request in both cost and attention, and forty lines of trivia
 * makes a model worse rather than better. When there are more confirmed facts
 * than fit, constraints win: getting a dietary restriction wrong matters more
 * than forgetting a preferred airline.
 */
export function factsForPrompt(db: DB, principalId: string, limit = 20): readonly string[] {
  const rows = db
    .prepare(
      `SELECT kind, statement FROM facts
       WHERE principal_id = ? AND state = 'confirmed'
       ORDER BY CASE kind
                  WHEN 'constraint' THEN 0
                  WHEN 'relationship' THEN 1
                  WHEN 'preference' THEN 2
                  WHEN 'routine' THEN 3
                  ELSE 4 END,
                confidence DESC
       LIMIT ?`,
    )
    .all(principalId, limit) as { kind: string; statement: string }[];

  return rows.map((row) => `(${row.kind}) ${row.statement}`);
}

export function countFacts(db: DB, principalId: string): {
  readonly confirmed: number;
  readonly proposed: number;
  readonly rejected: number;
} {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN state = 'proposed' THEN 1 ELSE 0 END) AS proposed,
         SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM facts WHERE principal_id = ?`,
    )
    .get(principalId) as {
    confirmed: number | null;
    proposed: number | null;
    rejected: number | null;
  };

  return {
    confirmed: row.confirmed ?? 0,
    proposed: row.proposed ?? 0,
    rejected: row.rejected ?? 0,
  };
}
