/**
 * Jobs.
 *
 * A CLI can run a fifteen-minute backfill synchronously and print dots. A
 * client cannot: it starts something, gets backgrounded, comes back, and needs
 * to know where things stand. That difference is the whole reason this table
 * exists.
 *
 * Progress is written to the database rather than pushed to a logger, which
 * means it survives the client disconnecting, the app being killed, and the
 * daemon restarting mid-pass. The underlying passes were already resumable;
 * this makes them observable.
 *
 * One job per task at a time. Two concurrent derives would fight over the same
 * pending set and do the same work twice.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "../kernel/db.js";

export type JobState = "queued" | "running" | "complete" | "failed" | "cancelled";

export interface Job {
  readonly id: string;
  readonly principalId: string;
  readonly task: string;
  readonly state: JobState;
  readonly phase: string | null;
  readonly progressDone: number;
  readonly progressTotal: number | null;
  readonly note: string | null;
  readonly error: string | null;
  readonly requestedBy: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

interface JobRow {
  readonly id: string;
  readonly principal_id: string;
  readonly task: string;
  readonly state: JobState;
  readonly phase: string | null;
  readonly progress_done: number;
  readonly progress_total: number | null;
  readonly note: string | null;
  readonly error: string | null;
  readonly requested_by: string | null;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
}

function hydrate(row: JobRow): Job {
  return {
    id: row.id,
    principalId: row.principal_id,
    task: row.task,
    state: row.state,
    phase: row.phase,
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    note: row.note,
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createJob(
  db: DB,
  input: {
    readonly principalId: string;
    readonly task: string;
    readonly requestedBy?: string;
  },
): Job {
  const id = `j_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  db.prepare(
    `INSERT INTO jobs (id, principal_id, task, state, requested_by, owner_pid, created_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(id, input.principalId, input.task, input.requestedBy ?? null, process.pid, Date.now());

  const job = getJob(db, id);

  if (job === null) {
    throw new Error(`Job ${id} vanished immediately after being written`);
  }

  return job;
}

export function getJob(db: DB, id: string): Job | null {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row === undefined ? null : hydrate(row);
}

/** The job currently doing this task, if any. Guards against duplicate runs. */
export function activeJob(db: DB, task: string): Job | null {
  const row = db
    .prepare(
      `SELECT * FROM jobs WHERE task = ? AND state IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(task) as JobRow | undefined;

  return row === undefined ? null : hydrate(row);
}

export function listJobs(db: DB, limit = 20): readonly Job[] {
  const rows = db
    .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as JobRow[];

  return rows.map(hydrate);
}

export function startJob(db: DB, id: string, phase?: string): void {
  db.prepare(`UPDATE jobs SET state = 'running', started_at = ?, phase = ? WHERE id = ?`).run(
    Date.now(),
    phase ?? null,
    id,
  );
}

export function updateProgress(
  db: DB,
  id: string,
  progress: {
    readonly done?: number;
    readonly total?: number | null;
    readonly phase?: string;
    readonly note?: string;
  },
): void {
  const fields: string[] = [];
  const bind: Record<string, unknown> = { id };

  if (progress.done !== undefined) {
    fields.push("progress_done = @done");
    bind["done"] = progress.done;
  }

  if (progress.total !== undefined) {
    fields.push("progress_total = @total");
    bind["total"] = progress.total;
  }

  if (progress.phase !== undefined) {
    fields.push("phase = @phase");
    bind["phase"] = progress.phase;
  }

  if (progress.note !== undefined) {
    fields.push("note = @note");
    bind["note"] = progress.note.slice(0, 300);
  }

  if (fields.length === 0) {
    return;
  }

  db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = @id`).run(bind);
}

export function finishJob(
  db: DB,
  id: string,
  state: Exclude<JobState, "queued" | "running">,
  detail?: { readonly note?: string; readonly error?: string },
): void {
  db.prepare(
    `UPDATE jobs SET state = ?, finished_at = ?,
       note = COALESCE(?, note), error = ? WHERE id = ?`,
  ).run(
    state,
    Date.now(),
    detail?.note?.slice(0, 300) ?? null,
    detail?.error?.slice(0, 500) ?? null,
    id,
  );
}

/**
 * Marks jobs that were running when the process died.
 *
 * Called at startup. A job stuck in `running` forever would block its task from
 * ever being started again, and the underlying passes are resumable anyway, so
 * the honest thing is to record that it was interrupted and let it be re-run.
 */
export function requestCancel(db: DB, id: string): boolean {
  return db
    .prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ? AND state IN ('queued','running')`)
    .run(id).changes > 0;
}

/** Checked between batches by every long pass. */
export function cancelRequested(db: DB, id: string): boolean {
  const row = db.prepare(`SELECT cancel_requested FROM jobs WHERE id = ?`).get(id) as
    | { cancel_requested: number }
    | undefined;

  return row !== undefined && row.cancel_requested === 1;
}

/**
 * Marks jobs whose owning process is gone.
 *
 * This runs on every database open, which is the important constraint: a
 * read-only CLI command opens the database while a daemon is mid-backfill, and
 * it must not disturb it. The previous version failed every running job
 * unconditionally, so checking on a job was what ended it.
 *
 * `kill(pid, 0)` asks whether a process exists without signalling it. A job
 * with no recorded pid predates this and is left alone rather than guessed at:
 * a stuck job is a nuisance, and killing a live one loses an hour of work.
 */
export function reapOrphans(db: DB): number {
  const rows = db
    .prepare(
      `SELECT id, owner_pid FROM jobs
       WHERE state IN ('queued', 'running') AND owner_pid IS NOT NULL`,
    )
    .all() as { id: string; owner_pid: number }[];

  const dead = rows.filter((row) => {
    if (row.owner_pid === process.pid) {
      // Our own, from earlier in this process. Not orphaned.
      return false;
    }

    try {
      process.kill(row.owner_pid, 0);
      return false;
    } catch (error: unknown) {
      // EPERM means the process exists and belongs to someone else, which is
      // still alive. Only ESRCH means gone.
      return (error as { code?: string }).code !== "EPERM";
    }
  });

  if (dead.length === 0) {
    return 0;
  }

  const mark = db.prepare(
    `UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?`,
  );

  const work = db.transaction(() => {
    for (const row of dead) {
      mark.run(Date.now(), "the process running this stopped; safe to run again", row.id);
    }
  });

  work();
  return dead.length;
}
