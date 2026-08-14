/**
 * Sync runs.
 *
 * A backfill of tens of thousands of messages will be interrupted: a laptop
 * lid, a network drop, a Ctrl-C when it is taking longer than expected. The
 * only requirement that matters is that the next attempt resumes rather than
 * restarts, which means the page cursor has to be durable, not in memory.
 */
import type { DB } from "../kernel/db.js";

export type SyncMode = "recent" | "backfill" | "incremental";
export type SyncState = "running" | "complete" | "failed";

export interface SyncRun {
  readonly id: number;
  readonly accountId: string;
  readonly streamId: string;
  readonly mode: SyncMode;
  readonly state: SyncState;
  readonly pageCursor: string | null;
  readonly startHistoryId: string | null;
  readonly fetched: number;
  readonly changed: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error: string | null;
}

interface SyncRunRow {
  readonly id: number;
  readonly account_id: string;
  readonly stream_id: string;
  readonly mode: SyncMode;
  readonly state: SyncState;
  readonly page_cursor: string | null;
  readonly start_history_id: string | null;
  readonly fetched: number;
  readonly changed: number;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly error: string | null;
}

function hydrate(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    accountId: row.account_id,
    streamId: row.stream_id,
    mode: row.mode,
    state: row.state,
    pageCursor: row.page_cursor,
    startHistoryId: row.start_history_id,
    fetched: row.fetched,
    changed: row.changed,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

export function startRun(
  db: DB,
  accountId: string,
  streamId: string,
  mode: SyncMode,
  watermark: string | null,
): SyncRun {
  const result = db
    .prepare(
      `INSERT INTO sync_runs (account_id, stream_id, mode, state, start_history_id, started_at)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    )
    .run(accountId, streamId, mode, watermark, Date.now());

  const run = getRun(db, Number(result.lastInsertRowid));
  if (run === null) {
    throw new Error("sync run vanished immediately after insert");
  }
  return run;
}

export function getRun(db: DB, id: number): SyncRun | null {
  const row = db.prepare(`SELECT * FROM sync_runs WHERE id = ?`).get(id) as SyncRunRow | undefined;
  return row === undefined ? null : hydrate(row);
}

/** The interrupted backfill to pick back up, if there is one. */
export function resumableRun(db: DB, streamId: string, mode: SyncMode): SyncRun | null {
  const row = db
    .prepare(
      `SELECT * FROM sync_runs
       WHERE stream_id = ? AND mode = ? AND state = 'running'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(streamId, mode) as SyncRunRow | undefined;

  return row === undefined ? null : hydrate(row);
}

export function lastCompleted(db: DB, streamId: string, mode: SyncMode): SyncRun | null {
  const row = db
    .prepare(
      `SELECT * FROM sync_runs
       WHERE stream_id = ? AND mode = ? AND state = 'complete'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(streamId, mode) as SyncRunRow | undefined;

  return row === undefined ? null : hydrate(row);
}

/** Checkpoint after every page, so an interruption costs at most one page. */
export function checkpoint(
  db: DB,
  id: number,
  pageCursor: string | null,
  fetched: number,
  changed: number,
): void {
  db.prepare(
    `UPDATE sync_runs SET page_cursor = ?, fetched = ?, changed = ? WHERE id = ?`,
  ).run(pageCursor, fetched, changed, id);
}

export function finishRun(db: DB, id: number, state: SyncState, error?: string): void {
  db.prepare(`UPDATE sync_runs SET state = ?, finished_at = ?, error = ? WHERE id = ?`).run(
    state,
    Date.now(),
    error ?? null,
    id,
  );
}

export function recentRuns(db: DB, accountId: string, limit = 5): readonly SyncRun[] {
  const rows = db
    .prepare(`SELECT * FROM sync_runs WHERE account_id = ? ORDER BY id DESC LIMIT ?`)
    .all(accountId, limit) as SyncRunRow[];

  return rows.map(hydrate);
}
