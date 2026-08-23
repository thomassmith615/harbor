/**
 * The daemon loop.
 *
 * Every scheduled task becomes a job, which is the one implementation of
 * running anything: the same path `harbor start`, `harbor dev run` and the Run
 * view all take. This file used to also hold a second, hand-written runner for
 * `harbor dev run`, covering twelve of the seventeen tasks and answering
 * "unknown task relate" for the rest. The tick never used it, so the only
 * broken path was the one a person types. It is gone.
 *
 * The loop itself is deliberately dull: wake up, ask the database what is due,
 * run it, write down what happened, sleep. State lives in SQLite rather than in
 * timers, so a restart resumes rather than losing the schedule or re-firing
 * everything that was due while it was down.
 */
import { enqueue } from "../jobs/runner.js";
import { dueSchedules, recordRefusal, recordRun, shouldDefer } from "./schedule.js";
import type { DB } from "../kernel/db.js";
import type { Logger } from "../kernel/logger.js";
import type { Schedule, ScheduledTask } from "./schedule.js";

export interface RunnerContext {
  readonly principalId: string;
  readonly timezone: string;
  readonly logger: Logger;
}

/** Runs one task and returns a one-line summary for the schedule row. */
export async function runTask(
  db: DB,
  task: ScheduledTask,
  context: RunnerContext,
  target?: string | null,
): Promise<string> {
  // Everything the scheduler runs is a job, so it shows up in Activity with
  // progress and a stop button rather than happening invisibly.
  const started = enqueue(
    db,
    task as never,
    {
      principalId: context.principalId,
      timezone: context.timezone,
      ...(target === undefined || target === null ? {} : { target }),
    },
    "scheduler",
  );

  if (started.blocked !== null) {
    return `skipped: ${started.blocked.task} is running`;
  }

  if (!started.started) {
    return "already running";
  }

  return started.job === null ? "refused" : `started ${started.job.id}`;
}

/**
 * Whether a note from `runTask` describes a refusal rather than a run.
 *
 * A string match, which is not lovely, but `runTask` is called from three
 * places and widening its return type would ripple further than this fix is
 * worth. The two producers are directly above; the test pins them.
 */
export function isRefusal(note: string): boolean {
  return note.startsWith("skipped: ") || note === "refused" || note === "already running";
}


export interface TickReport {
  readonly ran: readonly { readonly task: ScheduledTask; readonly note: string }[];
}

/** One pass over the due schedules. Exported so the CLI can force one. */
export async function tick(db: DB, context: RunnerContext, now = Date.now()): Promise<TickReport> {
  const ran: { task: ScheduledTask; note: string }[] = [];

  for (const schedule of dueSchedules(db, now)) {
    const deferral = shouldDefer(schedule.task, now, context.timezone);

    if (deferral !== null) {
      recordRun(db, schedule, context.timezone, "skipped", deferral);
      continue;
    }

    context.logger.info(`[${new Date().toISOString()}] running ${schedule.task}`);

    try {
      const note = await runTask(db, schedule.task, context, schedule.target);

      if (isRefusal(note)) {
        // Something else holds the lock. Come back shortly rather than
        // surrendering the slot, and do not record it as a run.
        recordRefusal(db, schedule, context.timezone, note);
        context.logger.info(`[${new Date().toISOString()}] ${schedule.task}: ${note}, retrying`);
        continue;
      }

      recordRun(db, schedule, context.timezone, "ok", note);
      ran.push({ task: schedule.task, note });
      context.logger.info(`[${new Date().toISOString()}] ${schedule.task}: ${note}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // A failing task must not take the daemon down with it, and must not
      // block every other schedule behind it.
      recordRun(db, schedule, context.timezone, "error", message);
      context.logger.error(`${schedule.task} failed: ${message}`);
    }
  }

  return { ran };
}

export interface DaemonOptions extends RunnerContext {
  /** How often to check for due work. The schedules themselves set the cadence. */
  readonly tickSeconds?: number;
  readonly onStop?: () => void;
}

export interface DaemonHandle {
  stop(): void;
  readonly stopped: Promise<void>;
}

export function startScheduler(db: DB, options: DaemonOptions): DaemonHandle {
  const tickMs = (options.tickSeconds ?? 60) * 1000;
  let running = true;
  let resolveStopped: () => void = () => undefined;

  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  async function loop(): Promise<void> {
    while (running) {
      try {
        await tick(db, options);
      } catch (error: unknown) {
        options.logger.error(
          `scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Sleep in short slices so a stop signal is honoured promptly rather than
      // after a full tick interval.
      for (let waited = 0; waited < tickMs && running; waited += 1000) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, tickMs - waited)));
      }
    }

    options.onStop?.();
    resolveStopped();
  }

  void loop();

  return {
    stop(): void {
      running = false;
    },
    stopped,
  };
}

export type { Schedule };
