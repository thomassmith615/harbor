/**
 * The task runner and the daemon loop.
 *
 * Every scheduled task is the same function the CLI calls, so there is exactly
 * one implementation of "sync" and the daemon cannot drift from the command.
 *
 * The loop itself is deliberately dull: wake up, ask the database what is due,
 * run it, write down what happened, sleep. State lives in SQLite rather than in
 * timers, so a restart resumes rather than losing the schedule or re-firing
 * everything that was due while it was down.
 */
import { backup } from "../kernel/backup.js";
import { classifyItems } from "../derive/classify.js";
import { composeBrief, renderBrief, runDetectors } from "../derive/brief.js";
import { buildCommitments } from "../derive/commitments.js";
import { produceDigest } from "../derive/digest.js";
import { extractPurchases } from "../derive/extract.js";
import { proposeFacts } from "../derive/facts.js";
import type { JobTask } from "../jobs/runner.js";
import { createEmbedder } from "../derive/embed/index.js";
import { derive } from "../derive/pipeline.js";
import { resolveEntities } from "../derive/entities.js";
import { syncAccount } from "../connectors/dispatch.js";
import { enqueue } from "../jobs/runner.js";
import { listAccounts } from "../store/accounts.js";
import { dueSchedules, recordRun, shouldDefer } from "./schedule.js";
import type { DB } from "../kernel/db.js";
import type { Embedder } from "../derive/embed/index.js";
import type { Logger } from "../kernel/logger.js";
import type { Schedule, ScheduledTask } from "./schedule.js";

export interface RunnerContext {
  readonly principalId: string;
  readonly timezone: string;
  readonly logger: Logger;
}

async function embedderOrNull(): Promise<Embedder | null> {
  try {
    return await createEmbedder();
  } catch {
    return null;
  }
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

/** The old direct path, kept for `harbor dev run` where a person is watching. */
export async function runTaskDirectly(
  db: DB,
  task: ScheduledTask,
  context: RunnerContext,
): Promise<string> {
  if (task === "sync") {
    // Every account, not just Google. This used to filter to one provider,
    // which meant a scheduled Harbor quietly synced nothing but the least
    // important source on the machine while the calendar, the mailbox, and the
    // message history went stale.
    const accounts = listAccounts(db);
    let changed = 0;

    for (const account of accounts) {
      const reports = await syncAccount(db, account, "auto", {
        timezone: context.timezone,
      });

      for (const report of reports) {
        changed += report.changed;
      }
    }

    return `${String(changed)} new or changed`;
  }

  if (task === "derive") {
    const embedder = await embedderOrNull();

    if (embedder === null) {
      return "skipped: no embedding backend";
    }

    const report = await derive(db, embedder);
    return `${String(report.itemsDerived)} items, ${String(report.embeddingsWritten)} embeddings`;
  }

  if (task === "resolve") {
    const report = resolveEntities(db);
    return `${String(report.itemsResolved)} items, ${String(report.entitiesCreated)} new people`;
  }

  if (task === "classify") {
    const report = classifyItems(db);
    return `${String(report.examined)} examined, ${String(report.restricted)} restricted`;
  }

  if (task === "signals") {
    const embedder = await embedderOrNull();

    const report = runDetectors(db, {
      principalId: context.principalId,
      timezone: context.timezone,
      ...(embedder === null ? {} : { embedder }),
    });

    const created = report.results.reduce((sum, result) => sum + result.created, 0);
    return `${String(created)} new observations`;
  }

  if (task === "commit") {
    const report = await buildCommitments(db, {
      principalId: context.principalId,
      limit: 20,
    });

    return (
      `${String(report.created)} new, ${String(report.merged)} merged, ` +
      `${String(report.scheduled)} scheduled, ${String(report.lapsed)} lapsed`
    );
  }

  if (task === "extract") {
    const report = await extractPurchases(db, { principalId: context.principalId, limit: 40 });

    return `${String(report.written)} purchases from ${String(report.read)} items read`;
  }

  if (task === "notice") {
    const report = await proposeFacts(db, { principalId: context.principalId, limit: 10 });

    return `${String(report.proposed)} proposed from ${String(report.read)} conversations`;
  }

  if (task === "digest") {
    const report = await produceDigest(db, {
      principalId: context.principalId,
      timezone: context.timezone,
      notify: true,
    });

    if (report.skipped !== null) {
      return `skipped: ${report.skipped}`;
    }

    return (
      `${String(report.brief.entries.length)} things` +
      (report.notified ? ", notified" : ", not delivered")
    );
  }

  if (task === "backup") {
    const result = backup(db);
    return `${result.path} (${String(result.bytes)} bytes)`;
  }

  if (task === "pipeline") {
    // The whole daily loop, in the only order that is correct: data first,
    // then the things derived from it, then the things derived from those.
    const parts: string[] = [];

    // Commitments after entities (they need people resolved) and before
    // signals (the detectors read them). The digest last, because it is the
    // only step that says anything out loud and everything else is its input.
    for (const step of [
      "sync",
      "classify",
      "derive",
      "resolve",
      "relate",
      "commit",
      "extract",
      "notice",
      "signals",
      "digest",
    ] as const) {
      parts.push(`${step}: ${await runTask(db, step, context)}`);
    }

    return parts.join("; ");
  }

  // The scheduler and the background job runner grew separate task
  // vocabularies, and `SCHEDULABLE` advertises several that only the job
  // runner implements. Rather than duplicate ingest logic here, hand those
  // straight to it: one implementation, and `harbor dev run recent` does what its
  // own help text says it does.
  if (INGEST_TASKS.includes(task)) {
    const outcome = enqueue(
      db,
      task as JobTask,
      { principalId: context.principalId, timezone: context.timezone },
      "scheduler",
    );

    if (outcome.blocked !== null) {
      return `${task} is waiting on ${outcome.blocked.task}`;
    }

    if (!outcome.started) {
      return `${task} is already running`;
    }

    return `${task} started as job ${outcome.job?.id ?? "?"}. Watch it with \`harbor jobs\`.`;
  }

  return `unknown task ${String(task)}`;
}

/** Tasks the job runner owns, because they are long, resumable, and exclusive. */
const INGEST_TASKS: readonly string[] = ["pulse", "recent", "history", "backfill", "onboard"];

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

export { renderBrief, composeBrief };
export type { Schedule };
