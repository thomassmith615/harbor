/**
 * The scheduler.
 *
 * Deliberately not cron. Two shapes cover everything Harbor needs: every N
 * minutes, and daily at a time. A cron parser would be more expressive and
 * would mostly be used to express one of those two.
 *
 * `next_run_at` is stored rather than held in memory. A daemon restart must not
 * lose the schedule, and must not re-fire everything that was due while it was
 * down, which is what an in-memory timer does on every deploy.
 */
import { localDate, localHour, localTimeToInstant, localWeekday } from "../kernel/time.js";
import type { DB } from "../kernel/db.js";

export type ScheduledTask =
  | "pulse"
  | "recent"
  | "history"
  | "sync"
  | "derive"
  | "resolve"
  | "relate"
  | "classify"
  | "signals"
  | "commit"
  | "extract"
  | "notice"
  | "digest"
  | "name"
  | "pipeline"
  | "backup";

export const SCHEDULABLE: readonly ScheduledTask[] = [
  "pulse",
  "sync",
  "recent",
  "history",
  "derive",
  "resolve",
  "relate",
  "classify",
  "commit",
  "extract",
  "notice",
  "signals",
  "name",
  "digest",
  "pipeline",
  "backup",
];

export interface Schedule {
  readonly id: string;
  readonly principalId: string;
  readonly task: ScheduledTask;
  /**
   * One connector, or all of them.
   *
   * A single cadence for every source is wrong in both directions: a local
   * SQLite read can happen every minute and costs nothing, while a CalDAV round
   * trip that often is rude for no benefit.
   */
  readonly target: string | null;
  readonly intervalMinutes: number | null;
  readonly atHour: number | null;
  readonly atMinute: number | null;
  readonly enabled: boolean;
  readonly lastRunAt: number | null;
  readonly lastStatus: string | null;
  readonly lastNote: string | null;
  readonly nextRunAt: number | null;
}

interface ScheduleRow {
  readonly id: string;
  readonly principal_id: string;
  readonly task: ScheduledTask;
  readonly target: string | null;
  readonly interval_minutes: number | null;
  readonly at_hour: number | null;
  readonly at_minute: number | null;
  readonly enabled: number;
  readonly last_run_at: number | null;
  readonly last_status: string | null;
  readonly last_note: string | null;
  readonly next_run_at: number | null;
}

function hydrate(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    principalId: row.principal_id,
    task: row.task,
    target: row.target,
    intervalMinutes: row.interval_minutes,
    atHour: row.at_hour,
    atMinute: row.at_minute,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastNote: row.last_note,
    nextRunAt: row.next_run_at,
  };
}

/**
 * When this schedule should next fire.
 *
 * For daily schedules it finds the next occurrence of the local wall-clock
 * time, which is what someone means by "6:30am" and is not the same as adding
 * 24 hours: those differ twice a year.
 */
export function computeNextRun(schedule: Schedule, tz: string, from: number): number {
  if (schedule.intervalMinutes !== null && schedule.intervalMinutes > 0) {
    return from + schedule.intervalMinutes * 60_000;
  }

  const hour = schedule.atHour ?? 7;
  const minute = schedule.atMinute ?? 0;
  const DAY = 86_400_000;

  for (let offset = 0; offset <= 2; offset += 1) {
    const probe = from + offset * DAY;
    // Wall-clock, not "plus 24 hours". Those differ twice a year, and a daily
    // job that drifts an hour every autumn is the kind of bug nobody reports
    // and everybody notices.
    const candidate = localTimeToInstant(localDate(probe, tz), hour, minute, tz);

    if (candidate > from) {
      return candidate;
    }
  }

  return from + DAY;
}

export function addSchedule(
  db: DB,
  input: {
    readonly principalId: string;
    readonly task: ScheduledTask;
    readonly intervalMinutes?: number | null;
    readonly atHour?: number | null;
    readonly atMinute?: number | null;
    readonly target?: string | null;
    readonly timezone: string;
  },
): Schedule {
  // Keyed by task and target, so `pulse` on iMessage every minute and `pulse`
  // on Gmail every five are two schedules rather than one overwriting the other.
  const id =
    input.target === undefined || input.target === null
      ? `s_${input.task}`
      : `s_${input.task}:${input.target}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO schedules
       (id, principal_id, task, target, interval_minutes, at_hour, at_minute, enabled, created_at)
     VALUES (@id, @principalId, @task, @target, @intervalMinutes, @atHour, @atMinute, 1, @now)
     ON CONFLICT (id) DO UPDATE SET
       target = excluded.target,
       interval_minutes = excluded.interval_minutes,
       at_hour = excluded.at_hour,
       at_minute = excluded.at_minute,
       enabled = 1`,
  ).run({
    id,
    principalId: input.principalId,
    task: input.task,
    target: input.target ?? null,
    intervalMinutes: input.intervalMinutes ?? null,
    atHour: input.atHour ?? null,
    atMinute: input.atMinute ?? null,
    now,
  });

  const schedule = getSchedule(db, id);

  if (schedule === null) {
    throw new Error(`Schedule ${id} vanished immediately after being written`);
  }

  const next = computeNextRun(schedule, input.timezone, now);
  db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run(next, id);

  return { ...schedule, nextRunAt: next };
}

export function getSchedule(db: DB, id: string): Schedule | null {
  const row = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as
    | ScheduleRow
    | undefined;

  return row === undefined ? null : hydrate(row);
}

export function listSchedules(db: DB): readonly Schedule[] {
  const rows = db.prepare(`SELECT * FROM schedules ORDER BY task`).all() as ScheduleRow[];
  return rows.map(hydrate);
}

export function setScheduleEnabled(db: DB, id: string, enabled: boolean): void {
  db.prepare(`UPDATE schedules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export function removeSchedule(db: DB, id: string): boolean {
  return db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes > 0;
}

export function dueSchedules(db: DB, now: number): readonly Schedule[] {
  const rows = db
    .prepare(
      `SELECT * FROM schedules
       WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY next_run_at`,
    )
    .all(now) as ScheduleRow[];

  return rows.map(hydrate);
}

export function recordRun(
  db: DB,
  schedule: Schedule,
  tz: string,
  status: "ok" | "error" | "skipped",
  note: string,
): void {
  const now = Date.now();

  db.prepare(
    `UPDATE schedules
     SET last_run_at = ?, last_status = ?, last_note = ?, next_run_at = ?
     WHERE id = ?`,
  ).run(now, status, note.slice(0, 300), computeNextRun(schedule, tz, now), schedule.id);
}

/** How soon to try again after being refused by a running job. */
const RETRY_MS = 5 * 60_000;

/**
 * How long to keep retrying before forfeiting the slot.
 *
 * Long enough to outlast any ingest pass that is merely slow, short enough that
 * a genuinely stuck job does not leave a task retrying until the small hours.
 */
const RETRY_WINDOW_MS = 3 * 3_600_000;

/**
 * A schedule that was refused because something else held the lock.
 *
 * Not the same as a run, and the difference cost real work. `recordRun`
 * advances `next_run_at` by `computeNextRun`, which for a daily task means
 * tomorrow. So a refusal forfeited the entire day:
 *
 *   commit   last Sat 11:08 AM  ok  skipped: pulse is running
 *   derive   last Sat 11:08 AM  ok  skipped: pulse is running
 *   extract  last Sat 11:08 AM  ok  skipped: pulse is running
 *   notice   last Sat 11:08 AM  ok  skipped: pulse is running
 *
 * Four passes collided with one pulse, and none of them ran that cycle. It was
 * recorded as status `ok`, which is how it stayed invisible: the schedule list
 * showed four healthy tasks that had quietly done nothing.
 *
 * So a refusal retries shortly instead, bounded by a window measured from when
 * the task was originally due. `last_run_at` is deliberately not touched: it
 * did not run, and every staleness check downstream depends on that being
 * honest.
 */
export function recordRefusal(db: DB, schedule: Schedule, tz: string, note: string): void {
  const now = Date.now();
  const dueAt = schedule.nextRunAt ?? now;
  const retryAt = now + RETRY_MS;

  // Past the window, give up on this slot and wait for the natural next one.
  // Without this a permanently stuck job leaves the task retrying every five
  // minutes indefinitely, which is a busy loop wearing a schedule as a hat.
  const nextRunAt =
    retryAt - dueAt > RETRY_WINDOW_MS ? computeNextRun(schedule, tz, now) : retryAt;

  db.prepare(
    `UPDATE schedules SET last_status = 'skipped', last_note = ?, next_run_at = ? WHERE id = ?`,
  ).run(note.slice(0, 300), nextRunAt, schedule.id);
}

/**
 * Whether a scheduled task should be skipped right now.
 *
 * Heavy background work at 2am is fine; heavy background work while the machine
 * is being used is a tax on everything else. Derivation is the only genuinely
 * expensive one, so it is the only one that defers.
 */
export function shouldDefer(task: ScheduledTask, now: number, tz: string): string | null {
  // History is the other expensive one, and it is by definition not urgent.
  if (task !== "derive" && task !== "history") {
    return null;
  }

  const hour = localHour(now, tz);
  const weekday = localWeekday(now, tz);

  if (weekday >= 1 && weekday <= 5 && hour >= 9 && hour < 18) {
    return `deferred: ${task} is expensive and it is the middle of a working day`;
  }

  return null;
}
