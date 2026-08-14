/**
 * Streams: an account plus a connector.
 *
 * This table exists because adding Calendar proved the cursor does not belong
 * to the account. One credential, two sync protocols, two independent resume
 * points. The `cursor` column is an opaque string; only the connector that
 * wrote it knows what is inside, and Calendar's happens to be a JSON map of
 * calendar id to sync token.
 */
import type { DB } from "../kernel/db.js";

export interface Stream {
  readonly id: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly cursor: string | null;
  readonly lastSyncAt: number | null;
  /** The recent window has been read, so this source is usable. */
  readonly recentDone: boolean;
  /** Everything back to the source floor has been read. */
  readonly historicalDone: boolean;
  /** How far back the historical pass has reached, as an instant. */
  readonly oldestReached: number | null;
}

interface StreamRow {
  readonly id: string;
  readonly account_id: string;
  readonly connector_id: string;
  readonly cursor: string | null;
  readonly last_sync_at: number | null;
  readonly recent_done: number;
  readonly historical_done: number;
  readonly oldest_reached: number | null;
}

function hydrate(row: StreamRow): Stream {
  return {
    id: row.id,
    accountId: row.account_id,
    connectorId: row.connector_id,
    cursor: row.cursor,
    lastSyncAt: row.last_sync_at,
    recentDone: row.recent_done === 1,
    historicalDone: row.historical_done === 1,
    oldestReached: row.oldest_reached,
  };
}

export function streamId(accountId: string, connectorId: string): string {
  return `${accountId}/${connectorId}`;
}

export function ensureStream(db: DB, accountId: string, connectorId: string): Stream {
  const id = streamId(accountId, connectorId);

  db.prepare(
    `INSERT INTO streams (id, account_id, connector_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(id, accountId, connectorId, Date.now());

  const stream = getStream(db, id);
  if (stream === null) {
    throw new Error(`Stream ${id} vanished immediately after being written`);
  }
  return stream;
}

export function getStream(db: DB, id: string): Stream | null {
  const row = db.prepare(`SELECT * FROM streams WHERE id = ?`).get(id) as StreamRow | undefined;
  return row === undefined ? null : hydrate(row);
}

export function listStreams(db: DB, accountId?: string): readonly Stream[] {
  const rows =
    accountId === undefined
      ? (db.prepare(`SELECT * FROM streams ORDER BY id`).all() as StreamRow[])
      : (db
          .prepare(`SELECT * FROM streams WHERE account_id = ? ORDER BY id`)
          .all(accountId) as StreamRow[]);

  return rows.map(hydrate);
}

export function recordStreamSync(db: DB, id: string, cursor: string | null, at: number): void {
  db.prepare(`UPDATE streams SET cursor = ?, last_sync_at = ? WHERE id = ?`).run(cursor, at, id);
}

export function markPhase(
  db: DB,
  id: string,
  phase: "recent" | "historical",
  done: boolean,
  oldestReached?: number | null,
): void {
  const column = phase === "recent" ? "recent_done" : "historical_done";

  db.prepare(`UPDATE streams SET ${column} = ? WHERE id = ?`).run(done ? 1 : 0, id);

  if (oldestReached !== undefined) {
    db.prepare(`UPDATE streams SET oldest_reached = ? WHERE id = ?`).run(oldestReached, id);
  }
}

/** Streams still owing a historical pass, so the background filler knows its work. */
export function needsHistory(db: DB): readonly Stream[] {
  const rows = db
    .prepare(
      `SELECT * FROM streams WHERE recent_done = 1 AND historical_done = 0 ORDER BY id`,
    )
    .all() as StreamRow[];

  return rows.map(hydrate);
}
