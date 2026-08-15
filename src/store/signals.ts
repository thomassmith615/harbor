/**
 * Signals storage.
 *
 * The invariant worth defending in this file: an observation cannot exist
 * without evidence. `recordObservation` rejects an empty evidence list rather
 * than writing a row, because the whole safety story for a system that speaks
 * first is that every proactive claim is clickable back to the items that
 * produced it. A detector that cannot point at anything is a bug, and it should
 * fail loudly at the point it tries to write.
 */
import { DETECTOR_VERSION } from "../derive/brief.js";
import { createHash } from "node:crypto";
import type { DB } from "../kernel/db.js";

export type InterestState = "active" | "dormant" | "fulfilled" | "dismissed";
export type ObservationState = "pending" | "surfaced" | "dismissed" | "acted" | "stale";

export interface Interest {
  readonly id: string;
  readonly principalId: string;
  readonly statement: string;
  readonly origin: "user" | "conversation";
  readonly originNote: string | null;
  readonly state: InterestState;
  readonly createdAt: number;
  readonly lastConfirmedAt: number | null;
  readonly expiresAt: number | null;
}

interface InterestRow {
  readonly id: string;
  readonly principal_id: string;
  readonly statement: string;
  readonly origin: "user" | "conversation";
  readonly origin_note: string | null;
  readonly state: InterestState;
  readonly created_at: number;
  readonly last_confirmed_at: number | null;
  readonly expires_at: number | null;
}

function hydrateInterest(row: InterestRow): Interest {
  return {
    id: row.id,
    principalId: row.principal_id,
    statement: row.statement,
    origin: row.origin,
    originNote: row.origin_note,
    state: row.state,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
    expiresAt: row.expires_at,
  };
}

/** Interests go dormant rather than vanishing, so a stale one stops nagging. */
export const INTEREST_TTL_DAYS = 120;

export function addInterest(
  db: DB,
  input: {
    readonly principalId: string;
    readonly statement: string;
    readonly origin?: "user" | "conversation";
    readonly originNote?: string | null;
    readonly ttlDays?: number;
  },
): Interest {
  const id = `i_${createHash("sha256").update(`${input.principalId}\u0000${input.statement.toLowerCase()}`).digest("hex").slice(0, 16)}`;
  const now = Date.now();
  const ttl = (input.ttlDays ?? INTEREST_TTL_DAYS) * 86_400_000;

  db.prepare(
    `INSERT INTO interests
       (id, principal_id, statement, origin, origin_note, state, created_at,
        last_confirmed_at, expires_at)
     VALUES (@id, @principalId, @statement, @origin, @originNote, 'active', @now, @now, @expires)
     ON CONFLICT (id) DO UPDATE SET
       state = 'active',
       last_confirmed_at = excluded.last_confirmed_at,
       expires_at = excluded.expires_at`,
  ).run({
    id,
    principalId: input.principalId,
    statement: input.statement,
    origin: input.origin ?? "user",
    originNote: input.originNote ?? null,
    now,
    expires: now + ttl,
  });

  const interest = getInterest(db, id);
  if (interest === null) {
    throw new Error(`Interest ${id} vanished immediately after being written`);
  }
  return interest;
}

export function getInterest(db: DB, id: string): Interest | null {
  const row = db.prepare(`SELECT * FROM interests WHERE id = ?`).get(id) as
    | InterestRow
    | undefined;

  return row === undefined ? null : hydrateInterest(row);
}

export function listInterests(
  db: DB,
  principalId: string,
  states: readonly InterestState[] = ["active"],
): readonly Interest[] {
  const placeholders = states.map((_, index) => `@s${String(index)}`);
  const bind: Record<string, unknown> = { principalId };

  states.forEach((state, index) => {
    bind[`s${String(index)}`] = state;
  });

  const rows = db
    .prepare(
      `SELECT * FROM interests
       WHERE principal_id = @principalId AND state IN (${placeholders.join(", ")})
       ORDER BY created_at DESC`,
    )
    .all(bind) as InterestRow[];

  return rows.map(hydrateInterest);
}

export function setInterestState(db: DB, id: string, state: InterestState): void {
  db.prepare(`UPDATE interests SET state = ? WHERE id = ?`).run(state, id);
}

export function saveInterestEmbedding(
  db: DB,
  id: string,
  model: string,
  vector: Buffer,
): void {
  db.prepare(`UPDATE interests SET embedding = ?, embedding_model = ? WHERE id = ?`).run(
    vector,
    model,
    id,
  );
}

export function interestEmbeddings(
  db: DB,
  principalId: string,
  model: string,
): readonly { readonly interest: Interest; readonly vector: Buffer }[] {
  const rows = db
    .prepare(
      `SELECT * FROM interests
       WHERE principal_id = ? AND state = 'active'
         AND embedding IS NOT NULL AND embedding_model = ?`,
    )
    .all(principalId, model) as (InterestRow & { embedding: Buffer })[];

  return rows.map((row) => ({ interest: hydrateInterest(row), vector: row.embedding }));
}

/** Marks interests nobody has reconfirmed as dormant, so they stop generating noise. */
export function expireInterests(db: DB, principalId: string, now = Date.now()): number {
  const result = db
    .prepare(
      `UPDATE interests SET state = 'dormant'
       WHERE principal_id = ? AND state = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .run(principalId, now);

  return result.changes;
}

export interface Observation {
  readonly id: string;
  readonly principalId: string;
  readonly detectorId: string;
  readonly dedupKey: string;
  readonly title: string;
  readonly detail: string | null;
  readonly salience: number;
  readonly evidence: readonly string[];
  readonly interestId: string | null;
  readonly earliestUsefulAt: number;
  readonly expiresAt: number | null;
  readonly state: ObservationState;
  readonly createdAt: number;
}

interface ObservationRow {
  readonly id: string;
  readonly principal_id: string;
  readonly detector_id: string;
  readonly dedup_key: string;
  readonly title: string;
  readonly detail: string | null;
  readonly salience: number;
  readonly evidence: string;
  readonly interest_id: string | null;
  readonly earliest_useful_at: number;
  readonly expires_at: number | null;
  readonly state: ObservationState;
  readonly created_at: number;
}

function hydrateObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    principalId: row.principal_id,
    detectorId: row.detector_id,
    dedupKey: row.dedup_key,
    title: row.title,
    detail: row.detail,
    salience: row.salience,
    evidence: JSON.parse(row.evidence) as string[],
    interestId: row.interest_id,
    earliestUsefulAt: row.earliest_useful_at,
    expiresAt: row.expires_at,
    state: row.state,
    createdAt: row.created_at,
  };
}

export interface ObservationInput {
  readonly principalId: string;
  readonly detectorId: string;
  readonly dedupKey: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly salience: number;
  readonly evidence: readonly string[];
  readonly interestId?: string | null;
  readonly earliestUsefulAt: number;
  readonly expiresAt?: number | null;
}

/**
 * Writes an observation, once.
 *
 * The dedup key is the suppression mechanism: a second detection of the same
 * situation updates salience and nothing else, so nothing is ever said twice.
 * Returns false when the observation already existed.
 */
export function recordObservation(db: DB, input: ObservationInput): boolean {
  if (input.evidence.length === 0) {
    throw new Error(
      `Detector ${input.detectorId} tried to write an observation with no evidence. ` +
        "Nothing proactive may be asserted that cannot be pointed at.",
    );
  }

  const id = `o_${createHash("sha256").update(`${input.principalId}\u0000${input.dedupKey}`).digest("hex").slice(0, 16)}`;

  const existing = db.prepare(`SELECT state FROM observations WHERE id = ?`).get(id) as
    | { state: ObservationState }
    | undefined;

  if (existing !== undefined) {
    // Only the score moves. State, and therefore suppression, is untouched.
    db.prepare(`UPDATE observations SET salience = ? WHERE id = ?`).run(input.salience, id);
    return false;
  }

  db.prepare(
    `INSERT INTO observations
       (id, principal_id, detector_id, detector_version, dedup_key, title, detail, salience,
        evidence, interest_id, earliest_useful_at, expires_at, state, created_at)
     VALUES (@id, @principalId, @detectorId, @detectorVersion, @dedupKey, @title, @detail,
             @salience, @evidence, @interestId, @earliestUsefulAt, @expiresAt, 'pending', @now)`,
  ).run({
    id,
    detectorVersion: DETECTOR_VERSION,
    principalId: input.principalId,
    detectorId: input.detectorId,
    dedupKey: input.dedupKey,
    title: input.title,
    detail: input.detail ?? null,
    salience: input.salience,
    evidence: JSON.stringify(input.evidence),
    interestId: input.interestId ?? null,
    earliestUsefulAt: input.earliestUsefulAt,
    expiresAt: input.expiresAt ?? null,
    now: Date.now(),
  });

  return true;
}

/** Everything ready to say: pending, past its useful-from time, not expired. */
export function dueObservations(
  db: DB,
  principalId: string,
  now: number,
  limit: number,
): readonly Observation[] {
  const rows = db
    .prepare(
      `SELECT o.* FROM observations o
       LEFT JOIN detector_feedback f ON f.detector_id = o.detector_id
       WHERE o.principal_id = ?
         AND o.state = 'pending'
         AND o.earliest_useful_at <= ?
         AND (o.expires_at IS NULL OR o.expires_at > ?)
         AND COALESCE(f.suppressed, 0) = 0
       ORDER BY o.salience DESC, o.created_at ASC
       LIMIT ?`,
    )
    .all(principalId, now, now, limit) as ObservationRow[];

  return rows.map(hydrateObservation);
}

export function openObservations(db: DB, detectorId?: string): readonly Observation[] {
  const rows =
    detectorId === undefined
      ? (db
          .prepare(`SELECT * FROM observations WHERE state IN ('pending', 'surfaced')`)
          .all() as ObservationRow[])
      : (db
          .prepare(
            `SELECT * FROM observations WHERE state IN ('pending', 'surfaced') AND detector_id = ?`,
          )
          .all(detectorId) as ObservationRow[]);

  return rows.map(hydrateObservation);
}

export function getObservation(db: DB, id: string): Observation | null {
  const row = db.prepare(`SELECT * FROM observations WHERE id = ?`).get(id) as
    | ObservationRow
    | undefined;

  return row === undefined ? null : hydrateObservation(row);
}

export function setObservationState(db: DB, id: string, state: ObservationState): void {
  const now = Date.now();

  if (state === "surfaced") {
    db.prepare(`UPDATE observations SET state = ?, surfaced_at = ? WHERE id = ?`).run(
      state,
      now,
      id,
    );
    return;
  }

  db.prepare(`UPDATE observations SET state = ?, resolved_at = ? WHERE id = ?`).run(
    state,
    now,
    id,
  );
}

export function recordBrief(
  db: DB,
  principalId: string,
  observationIds: readonly string[],
  budget: number,
): number {
  const result = db
    .prepare(
      `INSERT INTO briefs (principal_id, observation_ids, budget, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(principalId, JSON.stringify(observationIds), budget, Date.now());

  return Number(result.lastInsertRowid);
}

export interface DetectorStats {
  readonly detectorId: string;
  readonly surfaced: number;
  readonly dismissed: number;
  readonly acted: number;
  readonly suppressed: boolean;
  readonly dismissalRate: number;
}

export function bumpDetector(
  db: DB,
  detectorId: string,
  field: "surfaced" | "dismissed" | "acted",
): void {
  db.prepare(
    `INSERT INTO detector_feedback (detector_id, ${field}, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT (detector_id) DO UPDATE SET
       ${field} = ${field} + 1,
       updated_at = excluded.updated_at`,
  ).run(detectorId, Date.now());
}

export function detectorStats(db: DB): readonly DetectorStats[] {
  const rows = db
    .prepare(`SELECT * FROM detector_feedback ORDER BY detector_id`)
    .all() as {
    detector_id: string;
    surfaced: number;
    dismissed: number;
    acted: number;
    suppressed: number;
  }[];

  return rows.map((row) => ({
    detectorId: row.detector_id,
    surfaced: row.surfaced,
    dismissed: row.dismissed,
    acted: row.acted,
    suppressed: row.suppressed === 1,
    dismissalRate: row.surfaced === 0 ? 0 : row.dismissed / row.surfaced,
  }));
}

export function setDetectorSuppressed(db: DB, detectorId: string, suppressed: boolean): void {
  db.prepare(
    `INSERT INTO detector_feedback (detector_id, suppressed, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (detector_id) DO UPDATE SET suppressed = excluded.suppressed,
       updated_at = excluded.updated_at`,
  ).run(detectorId, suppressed ? 1 : 0, Date.now());
}
