/**
 * Commitments.
 *
 * Harbor's first claim of its own. Everything else in the store is a record of
 * what a source said; a commitment is Harbor's assembled view of one
 * unresolved thing in a person's life, built from however many sources
 * mentioned it.
 *
 * The identity problem is the whole difficulty. "buy a ski rack" said in a text
 * on Tuesday, "Buy a ski rack" written into Reminders on Wednesday, and a
 * shipping confirmation on Friday are one commitment, and nothing in the data
 * says so. Matching is therefore conservative and legible: normalized content
 * words, an owner that has to agree, and a time window. When it is unsure it
 * makes two commitments rather than one, because a wrongly merged pair is much
 * harder to notice than a duplicate.
 */
import { createHash } from "node:crypto";
import type { DB } from "../kernel/db.js";

export type CommitmentOwner = "me" | "them" | "shared";

/**
 * Where a commitment is in its life.
 *
 * `stated` is the interesting one: somebody said this would happen and nothing
 * has formalized it. `scheduled` means a calendar entry now covers it.
 * `lapsed` is a claim Harbor makes only from the passage of time, and never
 * means "you failed to do this", only "nothing since suggests it happened".
 */
export type CommitmentState = "stated" | "scheduled" | "done" | "lapsed" | "cancelled";

export type EvidenceRole = "stated" | "tracked" | "scheduled" | "confirmed" | "closed";

export interface Commitment {
  readonly id: string;
  readonly title: string;
  readonly normalized: string;
  readonly owner: CommitmentOwner;
  readonly counterparty: string | null;
  readonly state: CommitmentState;
  readonly dueAt: number | null;
  readonly occursAt: number | null;
  readonly confidence: number;
  readonly origin: string;
  readonly recurring: boolean;
  readonly firstSeenAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  readonly closedReason: string | null;
}

interface CommitmentRow {
  readonly id: string;
  readonly title: string;
  readonly normalized: string;
  readonly owner: string;
  readonly counterparty: string | null;
  readonly state: string;
  readonly due_at: number | null;
  readonly occurs_at: number | null;
  readonly confidence: number;
  readonly origin: string;
  readonly recurring: number;
  readonly first_seen_at: number;
  readonly updated_at: number;
  readonly closed_at: number | null;
  readonly closed_reason: string | null;
}

function hydrate(row: CommitmentRow): Commitment {
  return {
    id: row.id,
    title: row.title,
    normalized: row.normalized,
    owner: row.owner as CommitmentOwner,
    counterparty: row.counterparty,
    state: row.state as CommitmentState,
    dueAt: row.due_at,
    occursAt: row.occurs_at,
    confidence: row.confidence,
    origin: row.origin,
    recurring: row.recurring === 1,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closedReason: row.closed_reason,
  };
}

/**
 * Words carrying no identifying weight.
 *
 * Short enough to stay honest. A long stopword list starts removing the words
 * that distinguish two commitments from each other, and "call the dentist" and
 * "call the landlord" have to stay different.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "and", "or", "of", "in", "on", "at", "with",
  "my", "our", "your", "i", "we", "you", "it", "this", "that", "need", "needs",
  "should", "will", "gonna", "going", "want", "wanna", "have", "has", "get",
  "got", "be", "am", "is", "are", "do", "does", "make", "about", "some", "any",
]);

/**
 * A comparable form of a commitment's text.
 *
 * Content words, lowercased, deduplicated, sorted. Sorting is what makes "ski
 * rack buy" and "buy a ski rack" the same string, which matters because the
 * same intention is phrased differently in a text message and in a reminder.
 */
export function normalize(title: string): string {
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));

  return [...new Set(words)].sort().join(" ");
}

/** Jaccard overlap of two normalized forms. */
export function similarity(left: string, right: string): number {
  const a = new Set(left.split(" ").filter((word) => word.length > 0));
  const b = new Set(right.split(" ").filter((word) => word.length > 0));

  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const word of a) {
    if (b.has(word)) {
      shared += 1;
    }
  }

  return shared / (a.size + b.size - shared);
}

/**
 * How similar two commitments must be to be treated as one.
 *
 * Set high. The failure modes are not symmetric: a duplicate commitment is
 * visible in a list and annoying, while a wrongly merged pair silently hides
 * one of two real obligations and carries the wrong evidence.
 */
const MERGE_THRESHOLD = 0.6;

/** How far apart in time two mentions may be and still be the same commitment. */
const MERGE_WINDOW_MS = 60 * 86_400_000;

export interface CommitmentInput {
  readonly principalId: string;
  readonly title: string;
  readonly owner: CommitmentOwner;
  readonly counterparty?: string | null;
  readonly state: CommitmentState;
  readonly dueAt?: number | null;
  readonly occursAt?: number | null;
  readonly confidence: number;
  readonly origin: string;
  /** When the thing that produced this happened, for the merge window. */
  readonly anchorAt: number;
  /** True when the source says this repeats. Changes how it is keyed and aged. */
  readonly recurring?: boolean;
}

export interface EvidenceInput {
  readonly itemId?: string | null;
  readonly episodeId?: string | null;
  readonly role: EvidenceRole;
  readonly note: string;
  readonly occurredAt: number;
}

/**
 * An open commitment this one should join, if there is one.
 *
 * Closed commitments are deliberately not candidates. Saying "buy a ski rack"
 * again three months after buying one is a new commitment, not a resurrection
 * of the old.
 */
export function findMatch(db: DB, input: CommitmentInput): Commitment | null {
  const normalized = normalize(input.title);

  if (normalized.length === 0) {
    return null;
  }

  const rows = db
    .prepare(
      `SELECT * FROM commitments
       WHERE principal_id = @principal
         AND state IN ('stated', 'scheduled')
         AND owner = @owner
         AND ABS(COALESCE(due_at, occurs_at, first_seen_at) - @anchor) <= @window`,
    )
    .all({
      principal: input.principalId,
      owner: input.owner,
      anchor: input.anchorAt,
      window: MERGE_WINDOW_MS,
    }) as CommitmentRow[];

  let best: { row: CommitmentRow; score: number } | null = null;

  for (const row of rows) {
    const score = similarity(normalized, row.normalized);

    if (score >= MERGE_THRESHOLD && (best === null || score > best.score)) {
      best = { row, score };
    }
  }

  return best === null ? null : hydrate(best.row);
}

function commitmentId(
  principalId: string,
  normalized: string,
  anchor: number,
  recurring: boolean,
): string {
  // The anchor is bucketed to a day so that re-running extraction over the same
  // item produces the same id, while the same words months apart do not
  // collapse into one row.
  //
  // A recurring commitment drops the anchor entirely, which is the whole fix:
  // "rent" every month is one intention with a schedule, and keying it by date
  // produced a separate obligation for every month it had ever been due.
  const key = recurring
    ? `${principalId}|${normalized}|recurring`
    : `${principalId}|${normalized}|${String(Math.floor(anchor / 86_400_000))}`;

  return `cm_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export interface RecordOutcome {
  readonly id: string;
  readonly created: boolean;
  readonly merged: boolean;
}

/**
 * Writes a commitment, joining an existing one when the evidence is about the
 * same thing.
 *
 * Idempotent. Running extraction twice over the same conversation attaches the
 * same evidence rows and changes nothing, which is what lets the pass be
 * resumable and re-runnable like every other derivation here.
 */
export function recordCommitment(
  db: DB,
  input: CommitmentInput,
  evidence: EvidenceInput,
  extractVersion: number,
): RecordOutcome {
  const normalized = normalize(input.title);
  const existing = findMatch(db, input);
  const now = Date.now();

  if (existing !== null) {
    const write = db.transaction(() => {
      // A due date from a reminder beats no due date from a conversation, and
      // a stated commitment that acquires a calendar entry becomes scheduled.
      // Nothing here ever lowers a state; closing is the transitions pass's
      // job and needs evidence of its own.
      db.prepare(
        `UPDATE commitments SET
           -- A recurring commitment tracks its next occurrence, so a later
           -- instance moves the date forward. Without this it kept whichever
           -- instance happened to be seen first, which is usually the oldest
           -- and always the least useful.
           due_at = CASE
             WHEN @recurring = 1 THEN MAX(COALESCE(@dueAt, 0), COALESCE(due_at, 0))
             ELSE COALESCE(@dueAt, due_at) END,
           occurs_at = COALESCE(@occursAt, occurs_at),
           counterparty = COALESCE(counterparty, @counterparty),
           confidence = MAX(confidence, @confidence),
           state = CASE
             WHEN state = 'stated' AND @state = 'scheduled' THEN 'scheduled'
             ELSE state END,
           recurring = MAX(recurring, @recurring),
           updated_at = @now
         WHERE id = @id`,
      ).run({
        id: existing.id,
        dueAt: input.dueAt ?? null,
        occursAt: input.occursAt ?? null,
        counterparty: input.counterparty ?? null,
        confidence: input.confidence,
        state: input.state,
        recurring: input.recurring === true ? 1 : 0,
        now,
      });

      attachEvidence(db, existing.id, evidence);
    });

    write();

    return { id: existing.id, created: false, merged: true };
  }

  const recurring = input.recurring === true;
  const id = commitmentId(input.principalId, normalized, input.anchorAt, recurring);

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO commitments
         (id, principal_id, title, normalized, owner, counterparty, state, due_at, occurs_at,
          confidence, origin, recurring, extract_version, first_seen_at, updated_at)
       VALUES (@id, @principal, @title, @normalized, @owner, @counterparty, @state, @dueAt,
               @occursAt, @confidence, @origin, @recurring, @version, @now, @now)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         -- A recurring commitment tracks its next occurrence rather than its
         -- first. An ordinary one keeps the date it already had.
         due_at = CASE
           WHEN excluded.recurring = 1 THEN MAX(COALESCE(excluded.due_at, 0), COALESCE(commitments.due_at, 0))
           ELSE COALESCE(excluded.due_at, commitments.due_at) END,
         occurs_at = COALESCE(excluded.occurs_at, commitments.occurs_at),
         confidence = MAX(commitments.confidence, excluded.confidence),
         extract_version = excluded.extract_version,
         updated_at = excluded.updated_at`,
    ).run({
      id,
      principal: input.principalId,
      title: input.title,
      normalized,
      owner: input.owner,
      counterparty: input.counterparty ?? null,
      state: input.state,
      dueAt: input.dueAt ?? null,
      occursAt: input.occursAt ?? null,
      confidence: input.confidence,
      origin: input.origin,
      recurring: recurring ? 1 : 0,
      version: extractVersion,
      now,
    });

    attachEvidence(db, id, evidence);
  });

  write();

  return { id, created: true, merged: false };
}

export function attachEvidence(db: DB, commitmentId_: string, evidence: EvidenceInput): void {
  const source = evidence.itemId ?? evidence.episodeId ?? "";

  const id = `ev_${createHash("sha256")
    .update(`${commitmentId_}|${evidence.role}|${source}`)
    .digest("hex")
    .slice(0, 16)}`;

  db.prepare(
    `INSERT INTO commitment_evidence
       (id, commitment_id, item_id, episode_id, role, note, occurred_at)
     VALUES (@id, @commitment, @itemId, @episodeId, @role, @note, @occurredAt)
     ON CONFLICT (id) DO UPDATE SET note = excluded.note`,
  ).run({
    id,
    commitment: commitmentId_,
    itemId: evidence.itemId ?? null,
    episodeId: evidence.episodeId ?? null,
    role: evidence.role,
    note: evidence.note,
    occurredAt: evidence.occurredAt,
  });
}

export function closeCommitment(
  db: DB,
  id: string,
  state: CommitmentState,
  reason: string,
): void {
  db.prepare(
    `UPDATE commitments SET state = ?, closed_at = ?, closed_reason = ?, updated_at = ?
     WHERE id = ?`,
  ).run(state, Date.now(), reason, Date.now(), id);
}

export function setState(db: DB, id: string, state: CommitmentState): void {
  db.prepare(`UPDATE commitments SET state = ?, updated_at = ? WHERE id = ?`).run(
    state,
    Date.now(),
    id,
  );
}

export interface EvidenceRecord {
  readonly role: EvidenceRole;
  readonly note: string;
  readonly occurredAt: number;
  readonly itemId: string | null;
  readonly episodeId: string | null;
}

export function evidenceFor(db: DB, commitmentId_: string): readonly EvidenceRecord[] {
  const rows = db
    .prepare(
      `SELECT role, note, occurred_at, item_id, episode_id FROM commitment_evidence
       WHERE commitment_id = ? ORDER BY occurred_at`,
    )
    .all(commitmentId_) as {
    role: string;
    note: string;
    occurred_at: number;
    item_id: string | null;
    episode_id: string | null;
  }[];

  return rows.map((row) => ({
    role: row.role as EvidenceRole,
    note: row.note,
    occurredAt: row.occurred_at,
    itemId: row.item_id,
    episodeId: row.episode_id,
  }));
}

export interface CommitmentQuery {
  readonly principalId: string;
  readonly states?: readonly CommitmentState[];
  readonly limit?: number;
  readonly dueBefore?: number;
}

export function listCommitments(db: DB, query: CommitmentQuery): readonly Commitment[] {
  const states = query.states ?? ["stated", "scheduled"];
  const placeholders = states.map((_, index) => `@s${String(index)}`);
  const bind: Record<string, unknown> = {
    principal: query.principalId,
    limit: query.limit ?? 50,
  };

  states.forEach((state, index) => {
    bind[`s${String(index)}`] = state;
  });

  const where = [`principal_id = @principal`, `state IN (${placeholders.join(", ")})`];

  if (query.dueBefore !== undefined) {
    where.push(`COALESCE(due_at, occurs_at) IS NOT NULL`);
    where.push(`COALESCE(due_at, occurs_at) <= @dueBefore`);
    bind["dueBefore"] = query.dueBefore;
  }

  const rows = db
    .prepare(
      `SELECT * FROM commitments WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(due_at, occurs_at, first_seen_at) ASC
       LIMIT @limit`,
    )
    .all(bind) as CommitmentRow[];

  return rows.map(hydrate);
}

export function getCommitment(db: DB, id: string): Commitment | null {
  const row = db.prepare(`SELECT * FROM commitments WHERE id = ?`).get(id) as
    | CommitmentRow
    | undefined;

  return row === undefined ? null : hydrate(row);
}

export function countCommitments(db: DB): { readonly total: number; readonly open: number } {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM commitments`).get() as { n: number }).n;
  const open = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM commitments WHERE state IN ('stated', 'scheduled')`)
      .get() as { n: number }
  ).n;

  return { total, open };
}
