/**
 * Running a task as a job.
 *
 * One wrapper around the same task functions the scheduler and the CLI call, so
 * there is still exactly one implementation of "derive" and no chance of the
 * API drifting from the command.
 *
 * Jobs run in the daemon process, detached from whoever asked. The caller gets
 * an id back immediately; progress lands in the database.
 */
import { backup } from "../kernel/backup.js";
import { pruneBackups, rotateLogs } from "../kernel/housekeeping.js";
import { classifyItems } from "../derive/classify.js";
import { createEmbedder } from "../derive/embed/index.js";
import { derive, reindex } from "../derive/pipeline.js";
import { resolveEntities } from "../derive/entities.js";
import { relate } from "../derive/relate.js";
import { buildCommitments } from "../derive/commitments.js";
import { extractPurchases } from "../derive/extract.js";
import { proposeFacts } from "../derive/facts.js";
import { nameSituations } from "../derive/name.js";
import { runDetectors } from "../derive/brief.js";
import { syncAccount } from "../connectors/dispatch.js";
import { listAccounts } from "../store/accounts.js";
import { needsHistory } from "../store/streams.js";
import {
  activeJob,
  cancelRequested,
  createJob,
  finishJob,
  listJobs,
  requestCancel,
  startJob,
  updateProgress,
} from "../store/jobs.js";
import type { DB } from "../kernel/db.js";
import type { Job } from "../store/jobs.js";
import type { Embedder } from "../derive/embed/index.js";

export const JOB_TASKS = [
  "pulse",
  "sync",
  "recent",
  "history",
  "backfill",
  "classify",
  "derive",
  "resolve",
  "relate",
  "commit",
  "extract",
  "notice",
  "signals",
  "name",
  "backup",
  "reindex",
  "onboard",
] as const;

export type JobTask = (typeof JOB_TASKS)[number];

export interface JobContext {
  readonly principalId: string;
  readonly timezone: string;
  /** Restrict to one connector, for per-source cadences. */
  readonly target?: string | undefined;
}

/**
 * What must not run at the same time as what.
 *
 * The passes are not independent and never were. `classify` labels sensitivity,
 * and anything unlabelled is withheld by the gate. `derive` embeds, and
 * interest matching needs those vectors. `resolve` builds entities, and the
 * unclosed-loop detector needs them to tell a person from a newsletter.
 *
 * Running them concurrently does not error. Each simply sees a partial view of
 * the one before it and quietly does less, which is the failure mode worth
 * spending code to prevent. Encoding it here rather than in the UI means the
 * ordering is enforced rather than merely documented.
 *
 * Anything not listed together genuinely can overlap: a backup does not care
 * what else is happening.
 */
const INGEST: readonly JobTask[] = ["onboard", "pulse", "sync", "recent", "history", "backfill"];

const DECLARED: Readonly<Record<JobTask, readonly JobTask[]>> = {
  // The whole sequence. Nothing else may run alongside it.
  onboard: [...INGEST, "classify", "derive", "resolve", "commit", "extract", "signals"],
  // The appliance loop: a small incremental sync followed by derivation of
  // whatever it found. Conflicts with everything, because it does everything.
  pulse: [...INGEST, "classify", "derive", "resolve", "commit", "signals"],
  // Ingest changes what every derivation is derived from.
  sync: [...INGEST, "classify", "derive", "resolve", "commit", "signals"],
  recent: [...INGEST, "classify", "derive", "resolve", "commit", "signals"],
  // History runs in the background for hours. It blocks ingest, because two
  // passes writing the same stream is one too many, but it deliberately does
  // not block derivation: the whole point is that Harbor stays usable while it
  // fills in behind you.
  history: [...INGEST],
  backfill: [...INGEST, "classify", "derive", "resolve", "commit", "signals"],
  // Derivations read the store and write their own tables. They may not run
  // alongside ingest, and signals reads all of them.
  classify: ["onboard", "pulse", "sync", "recent", "backfill", "classify", "signals"],
  derive: ["onboard", "pulse", "sync", "recent", "backfill", "derive", "signals"],
  resolve: ["onboard", "pulse", "sync", "recent", "backfill", "resolve", "relate", "signals"],
  // Relating asks "are these the same person" of the entity layer, so it must
  // not run while that layer is being rewritten.
  relate: ["onboard", "pulse", "sync", "recent", "backfill", "resolve", "relate", "signals"],
  // Reads reminders, episodes, and the calendar, and writes its own table.
  // Blocked by the passes that produce its inputs rather than by everything.
  commit: ["onboard", "pulse", "sync", "recent", "backfill", "derive", "resolve", "commit"],
  extract: ["onboard", "pulse", "sync", "recent", "backfill", "extract"],
  notice: ["onboard", "pulse", "sync", "recent", "backfill", "derive", "notice"],
  // Reads the situations relate has just settled and writes a sentence about
  // each. Blocked by the pass that rewrites them and by ingest, and by nothing
  // else: it is slow, it holds no locks anybody wants, and nothing downstream
  // reads what it writes.
  name: ["onboard", "pulse", "sync", "recent", "backfill", "relate", "name"],
  signals: [
    "onboard",
    "pulse",
    "sync",
    "recent",
    "backfill",
    "classify",
    "derive",
    "resolve",
    "relate",
    "signals",
  ],
  // Reads a consistent snapshot, so it is safe alongside anything.
  backup: ["backup"],
  reindex: ["onboard", "pulse", "derive", "reindex"],
};

/**
 * The declarations above, made symmetric.
 *
 * `blockedBy` only ever consulted `CONFLICTS[incoming]`, which quietly assumed
 * every pair was declared from both sides. Twenty of them were not, and the
 * consequences were not theoretical:
 *
 *   `relate` declared a conflict with `pulse`, and `pulse` did not declare one
 *   with `relate`. `pulse` runs relate internally as one of its seven steps.
 *   So a long relate pass did not stop the fifteen-minute pulse from starting,
 *   and two relate passes ran concurrently over the same edge and situation
 *   tables. On an appliance with a pulse schedule that is not a rare race, it
 *   is what happens every time relate takes more than fifteen minutes, which
 *   on a first full store it always does.
 *
 *   Same shape for `notice`, `extract`, `reindex` against `pulse`, and for
 *   `commit` against `derive` and `resolve`.
 *
 * Making the closure symmetric rather than fixing twenty entries by hand is
 * deliberate: a hand-maintained table drifts the moment somebody adds a task,
 * and this one already had. A conflict is a statement about a pair, so either
 * side may declare it and both sides are bound by it.
 *
 * What this costs: `pulse` is now genuinely refused while `extract` (4:30am)
 * or `notice` (5:00am) is running. That is the correct behaviour and it is
 * visible, because a refused schedule is recorded as skipped with the blocker
 * named. If those windows grow long enough to matter, the answer is to bound
 * them, not to let the passes overlap.
 */
function symmetric(
  declared: Readonly<Record<JobTask, readonly JobTask[]>>,
): Readonly<Record<JobTask, readonly JobTask[]>> {
  const sets = new Map<JobTask, Set<JobTask>>();

  for (const task of JOB_TASKS) {
    sets.set(task, new Set<JobTask>());
  }

  for (const task of JOB_TASKS) {
    for (const other of declared[task] ?? []) {
      sets.get(task)?.add(other);
      sets.get(other)?.add(task);
    }
  }

  const closed: Partial<Record<JobTask, readonly JobTask[]>> = {};

  for (const task of JOB_TASKS) {
    closed[task] = [...(sets.get(task) ?? new Set<JobTask>())].sort();
  }

  return closed as Record<JobTask, readonly JobTask[]>;
}

export const CONFLICTS = symmetric(DECLARED);

/**
 * Pairs where only one side declared the conflict.
 *
 * Exported so a test can assert the closure is doing something and so
 * `harbor dev conflicts` can show what was inferred rather than written down.
 */
export function undeclaredPairs(): readonly (readonly [JobTask, JobTask])[] {
  const found: (readonly [JobTask, JobTask])[] = [];

  for (const task of JOB_TASKS) {
    for (const other of DECLARED[task] ?? []) {
      if (!(DECLARED[other] ?? []).includes(task)) {
        found.push([task, other]);
      }
    }
  }

  return found;
}

export interface Blocker {
  readonly task: string;
  readonly jobId: string;
}

/** The running job, if any, that stops this task from starting. */
export function blockedBy(db: DB, task: JobTask): Blocker | null {
  for (const other of CONFLICTS[task] ?? []) {
    const running = activeJob(db, other);

    if (running !== null) {
      return { task: other, jobId: running.id };
    }
  }

  return null;
}

/** What a client can start right now, and why not when it cannot. */
export function taskAvailability(
  db: DB,
): readonly { readonly task: JobTask; readonly blockedBy: Blocker | null }[] {
  return JOB_TASKS.map((task) => ({ task, blockedBy: blockedBy(db, task) }));
}

export function cancel(db: DB, id: string): boolean {
  return requestCancel(db, id);
}

export function running(db: DB): readonly Job[] {
  return listJobs(db, 30).filter((job) => job.state === "running" || job.state === "queued");
}

/**
 * Starts a job unless one is already running for that task.
 *
 * Returns the existing job rather than an error when there is one: a client
 * that taps sync twice should see the same progress, not a failure.
 */
export function enqueue(
  db: DB,
  task: JobTask,
  context: JobContext,
  requestedBy: string,
): { readonly job: Job | null; readonly started: boolean; readonly blocked: Blocker | null } {
  const existing = activeJob(db, task);

  if (existing !== null) {
    return { job: existing, started: false, blocked: null };
  }

  const blocker = blockedBy(db, task);

  if (blocker !== null) {
    // Refused, and nothing is written.
    //
    // This used to record a job and immediately cancel it, so the history
    // filled with cancelled rows that never ran. Someone checking why a task
    // would not start found a cancelled job and reasonably concluded something
    // had gone wrong, when the truth was simply that a refusal is not an event
    // worth remembering.
    return { job: null, started: false, blocked: blocker };
  }

  const job = createJob(db, { principalId: context.principalId, task, requestedBy });

  // Detached on purpose. The HTTP response returns now; the work continues.
  void execute(db, job.id, task, context);

  return { job, started: true, blocked: null };
}

/**
 * Stops a job, and stops waiting for it to agree.
 *
 * Cancellation is cooperative: a pass checks between batches, so it stops
 * within one batch, which for a mailbox page can be tens of seconds. That is
 * correct and it is also indistinguishable from a stuck job if you are watching
 * a button. `force` marks it failed immediately, which unblocks everything
 * behind it. The pass may still be mid-flight, but the passes are resumable and
 * the alternative is a task that can never run again.
 */
export function stop(db: DB, id: string, force = false): { readonly stopped: boolean } {
  const requested = requestCancel(db, id);

  if (force) {
    finishJob(db, id, "cancelled", { error: "stopped by hand" });
    return { stopped: true };
  }

  return { stopped: requested };
}

/** Stops everything in flight. The blunt instrument, for when things are stuck. */
export function stopAll(db: DB, force = false): number {
  const live = listJobs(db, 50).filter(
    (job) => job.state === "running" || job.state === "queued",
  );

  for (const job of live) {
    stop(db, job.id, force);
  }

  return live.length;
}

/**
 * Writes that must not take the process down.
 *
 * A job runs detached from whoever asked for it, so it can still be going when
 * the daemon shuts down and closes the database. Its next progress write then
 * throws from a callback nobody is awaiting, which is an unhandled rejection
 * and a dead process. Swallowing it is right: the job is already lost, orphan
 * reaping will mark it failed on the next start, and crashing on the way out
 * helps nobody.
 */
function guarded(work: () => void): void {
  try {
    work();
  } catch {
    // The database is closed, or closing. Nothing useful left to record.
  }
}

async function execute(db: DB, jobId: string, task: JobTask, context: JobContext): Promise<void> {
  guarded(() => {
    startJob(db, jobId, task);
  });

  try {
    const note = await run(db, jobId, task, context);

    guarded(() => {
      finishJob(db, jobId, stopped(db, jobId) ? "cancelled" : "complete", { note });
    });
  } catch (error: unknown) {
    guarded(() => {
      finishJob(db, jobId, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/**
 * Cooperative stop.
 *
 * Wrapped so a closed database during shutdown reads as "stop", which is the
 * correct answer: the daemon is going away and the pass should end.
 */
function stopped(db: DB, jobId: string): boolean {
  try {
    return cancelRequested(db, jobId);
  } catch {
    return true;
  }
}

/** Progress reporting is best effort for the same reason. */
function report(db: DB, jobId: string, progress: Parameters<typeof updateProgress>[2]): void {
  guarded(() => {
    updateProgress(db, jobId, progress);
  });
}

async function embedderOrNull(): Promise<Embedder | null> {
  try {
    return await createEmbedder();
  } catch {
    return null;
  }
}

async function run(db: DB, jobId: string, task: JobTask, context: JobContext): Promise<string> {
  if (task === "sync" || task === "backfill" || task === "recent" || task === "history") {
    const mode =
      task === "backfill"
        ? "backfill"
        : task === "recent"
          ? "recent"
          : task === "history"
            ? "historical"
            : "auto";

    // The history fill only visits streams that still owe one, so running it
    // repeatedly is cheap and "finished" is a real state rather than a guess.
    const owing =
      task === "history" ? new Set(needsHistory(db).map((stream) => stream.id)) : null;

    let changed = 0;
    let touched = 0;
    const failures: string[] = [];

    for (const account of listAccounts(db)) {
      report(db, jobId, { phase: account.label });

      if (stopped(db, jobId)) {
        return `stopped after ${String(changed)} changes`;
      }

      // One account may not take the others down with it.
      //
      // There was no try here, so a single throwing account aborted the whole
      // pass and every account after it in the list never synced at all. On a
      // real store that meant a dead `files` connector silently stopping mail,
      // calendars, reminders, and messages from updating, with nothing saying
      // so beyond one line of job error. A multi-source sync has to be able to
      // report a broken source and carry on.
      try {
        const reports = await syncAccount(db, account, mode, {
          timezone: context.timezone,
          shouldStop: () => stopped(db, jobId),
          ...(context.target === undefined ? {} : { only: context.target }),
          ...(owing === null ? {} : { onlyStreams: owing }),
          onNote: (message) => {
            report(db, jobId, { note: message });
          },
          onProgress: (phase, done, total) => {
            report(db, jobId, { phase, done, total });
          },
        });

        for (const entry of reports) {
          changed += entry.changed;
          touched += 1;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        failures.push(`${account.label} (${account.sourceType}): ${detail}`);
        report(db, jobId, { note: `${account.label} failed: ${detail}` });
      }
    }

    // Failures are named in the result rather than thrown, so the job is
    // honest about a partial sync. Reporting success on a pass where a source
    // never ran is how a store quietly stops updating.
    const trouble =
      failures.length === 0 ? "" : `; ${String(failures.length)} source(s) failed: ${failures.join("; ")}`;

    if (task === "history") {
      const left = needsHistory(db).length;
      return `${String(changed)} added, ${String(left)} ${left === 1 ? "stream" : "streams"} still filling in${trouble}`;
    }

    return `${String(changed)} new or changed across ${String(touched)} streams${trouble}`;
  }

  if (task === "classify") {
    const outcome = classifyItems(db, {
      shouldStop: () => stopped(db, jobId),
      onProgress: (done, total) => {
        report(db, jobId, { done, total });
      },
    });

    return `${String(outcome.examined)} examined, ${String(outcome.restricted)} restricted`;
  }

  if (task === "derive") {
    const embedder = await embedderOrNull();

    if (embedder === null) {
      return "skipped: no embedding backend";
    }

    const outcome = await derive(db, embedder, {
      shouldStop: () => stopped(db, jobId),
      onProgress: (done, total) => {
        report(db, jobId, { done, total });
      },
      onNote: (message) => {
        report(db, jobId, { note: message });
      },
    });

    return (
      `${String(outcome.itemsDerived)} items, ` +
      `${String(outcome.episodesWritten)} conversations, ` +
      `${String(outcome.embeddingsWritten)} embeddings`
    );
  }

  if (task === "resolve") {
    const outcome = resolveEntities(db, {
      shouldStop: () => stopped(db, jobId),
      onProgress: (done, total) => {
        report(db, jobId, { done, total });
      },
    });

    return `${String(outcome.itemsResolved)} items, ${String(outcome.entitiesCreated)} new people`;
  }

  if (task === "notice") {
    const outcome = await proposeFacts(db, {
      principalId: context.principalId,
      // Small. Facts are rare, the candidate predicate is narrow, and nothing
      // here is used until a person confirms it, so there is no value in
      // hurrying through a message history.
      limit: 10,
      shouldStop: () => stopped(db, jobId),
      onNote: (message) => {
        report(db, jobId, { note: message });
      },
    });

    return `${String(outcome.proposed)} proposed from ${String(outcome.read)} conversations`;
  }

  if (task === "extract") {
    const outcome = await extractPurchases(db, {
      principalId: context.principalId,
      // Bounded, like commit. Extraction is the other pass that spends per
      // item, and an unattended run must never be able to read a whole mailbox.
      limit: 40,
      shouldStop: () => stopped(db, jobId),
      onProgress: (done, total) => {
        report(db, jobId, { done, total });
      },
      onNote: (message) => {
        report(db, jobId, { note: message });
      },
    });

    return `${String(outcome.written)} purchases from ${String(outcome.read)} items read`;
  }

  if (task === "commit") {
    const outcome = await buildCommitments(db, {
      principalId: context.principalId,
      // Bounded on a scheduled run. Extraction is the only part of Harbor that
      // spends money per item, and an unattended pass should never be able to
      // read a whole message history in one go.
      limit: 20,
      shouldStop: () => stopped(db, jobId),
      onProgress: (done, total) => {
        report(db, jobId, { done, total });
      },
      onNote: (message) => {
        report(db, jobId, { note: message });
      },
    });

    return (
      `${String(outcome.created)} new, ${String(outcome.merged)} merged, ` +
      `${String(outcome.scheduled)} scheduled, ${String(outcome.lapsed)} lapsed`
    );
  }

  if (task === "relate") {
    const outcome = relate(db, {
      principalId: context.principalId,
      timezone: context.timezone,
      shouldStop: () => stopped(db, jobId),
      onProgress: (done, total) => {
        report(db, jobId, { done, total });
      },
      onNote: (message) => {
        report(db, jobId, { note: message });
      },
    });

    return (
      `${String(outcome.edgesDrawn)} connections drawn, ` +
      `${String(outcome.threads.threads)} cross-source situations`
    );
  }

  if (task === "name") {
    const named = await nameSituations(db, {
      principalId: context.principalId,
      timezone: context.timezone,
      shouldStop: () => stopped(db, jobId),
      onNote: (message) => {
        report(db, jobId, { note: message });
      },
    });

    return (
      `${String(named.written)} summarised, ${String(named.failed)} failed, ` +
      `${String(named.considered)} were without one`
    );
  }

  if (task === "signals") {
    const embedder = await embedderOrNull();

    const outcome = runDetectors(db, {
      principalId: context.principalId,
      timezone: context.timezone,
      ...(embedder === null ? {} : { embedder }),
    });

    const created = outcome.results.reduce((sum, result) => sum + result.created, 0);
    return `${String(created)} new observations`;
  }

  if (task === "backup") {
    const written = backup(db);

    // Housekeeping rides on the backup rather than getting a schedule of its
    // own, because the instant after a backup succeeds is exactly the moment
    // discarding an older one is safe. Neither prune nor rotate may fail the
    // job: the backup is already durable, and losing it over a failed unlink
    // would be a straight downgrade.
    let note = written.path;

    try {
      const pruned = pruneBackups();

      if (pruned.removed > 0) {
        note += `; pruned ${String(pruned.removed)}, freed ${(pruned.bytesFreed / 1_048_576).toFixed(0)} MB`;
      }
    } catch {
      note += "; prune failed";
    }

    try {
      const rotated = rotateLogs();

      if (rotated.rotated.length > 0) {
        note += `; rotated ${String(rotated.rotated.length)} log(s)`;
      }
    } catch {
      note += "; log rotation failed";
    }

    return note;
  }

  if (task === "reindex") {
    const embedder = await embedderOrNull();

    if (embedder === null) {
      return "skipped: no embedding backend";
    }

    return `${String(reindex(db, embedder.model, embedder.dims))} vectors reindexed`;
  }

  if (task === "pulse") {
    // The appliance loop. Everything downstream is incremental by version
    // column, so on a quiet minute this is four cheap no-ops, and on a busy one
    // it derives exactly what just arrived rather than waiting for a nightly
    // batch. That is the difference between current and eventually current.
    const notes: string[] = [];

    for (const step of [
      "sync",
      "classify",
      "derive",
      "resolve",
      "relate",
      // After relate, because relate is what clears a summary whose membership
      // changed, and before signals, so anything that speaks is speaking about
      // situations that have a sentence attached.
      "name",
      "commit",
      "signals",
    ] as const) {
      if (stopped(db, jobId)) {
        break;
      }

      report(db, jobId, { phase: step });
      notes.push(`${step}: ${await run(db, jobId, step, context)}`);
    }

    return notes.join("; ");
  }

  if (task === "onboard") {
    // Contacts first, whole. An address book is small and is what turns
    // addresses and phone numbers into people, so every source read after it is
    // worth more. Then the recent window across everything, which is what makes
    // Harbor usable in minutes. History is not in this list on purpose: it runs
    // behind you.
    // Relating sits after resolution and before signals: it needs entities to
    // decide who is on what, and the detectors want the graph it produces.
    const steps: readonly JobTask[] = [
      "recent",
      "classify",
      "derive",
      "resolve",
      "relate",
      "name",
      "signals",
    ];
    const notes: string[] = [];

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];

      if (step === undefined) {
        continue;
      }

      report(db, jobId, {
        phase: step,
        done: index,
        total: steps.length,
        note: `step ${String(index + 1)} of ${String(steps.length)}: ${step}`,
      });

      if (stopped(db, jobId)) {
        notes.push("stopped");
        break;
      }

      notes.push(`${step}: ${await run(db, jobId, step, context)}`);
    }

    report(db, jobId, { done: steps.length, total: steps.length });
    return notes.join("; ");
  }

  return `unknown task ${String(task)}`;
}
