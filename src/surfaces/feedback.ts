/**
 * A thumb, and the trace behind it.
 *
 * Every threshold in this store is an argument. The rarity ceiling, the
 * fourteen hour chatter window, the 0.6 admission bar, which linker fires on
 * what, whether a reminder ninety minutes before something is about it: all
 * reasoned about carefully, all written down with the reasoning attached, none
 * of them ever measured. There was nothing to measure against.
 *
 * A thumb is the cheapest ground truth available and the only one a single
 * person can produce at any volume. Twenty of them is a test set. Two hundred
 * is enough to tell whether a change to `gather.ts` helped.
 *
 * ## Three deliberate constraints
 *
 * **The verdict does not feed scoring.** Nothing reads this table at query
 * time and nothing should. A system that reweights on its own past outputs
 * learns its own habits, and at this volume there is nothing to fit. These rows
 * exist to be replayed against a new build, not to influence the current one.
 *
 * **The trace is the point, not the verdict.** A thumbs-down usually means the
 * sentence was bad, not that retrieval was wrong, and the two need completely
 * different fixes. Without the candidate set, the scores and the rules that
 * admitted or rejected each one, a negative verdict is unattributable and
 * therefore useless. `gather.ts` already produces exactly this shape internally
 * with `explain: true` and throws it away.
 *
 * **The trace lives on disk, not in the database.** It is verbose, it is
 * append-only, it is read in bulk and never queried, and it is the most
 * sensitive artifact Harbor produces: questions and retrieved content in the
 * same record. A file under `HARBOR_HOME` inherits the store's directory
 * permissions, can be rotated, and can be deleted without a migration. What is
 * in the database is the verdict and a pointer.
 *
 * On sending traces anywhere: they contain whatever the person asked about and
 * whatever was retrieved. `redact` exists so that a trace can be shared for
 * diagnosis without shipping the contents of somebody's mailbox, and it is
 * deliberately blunt rather than clever, because a redactor that is subtle is a
 * redactor nobody can verify.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { harborHome } from "../kernel/paths.js";
import type { DB } from "../kernel/db.js";

export type Verdict = "up" | "down";

/** One candidate, as the scorer saw it. */
export interface TracedCandidate {
  readonly ref: string;
  readonly title: string | null;
  readonly score: number;
  readonly admitted: boolean;
  /** The sentence the scorer wrote, whether it admitted or rejected. */
  readonly because: readonly string[];
}

export interface Trace {
  readonly at: number;
  readonly question: string;
  readonly surface: string;
  /** Which tier answered, and which model. */
  readonly tier: string | null;
  readonly model: string | null;
  /** Tools the model called, in order. */
  readonly tools: readonly string[];
  readonly candidates: readonly TracedCandidate[];
  /** What was shown. Truncated: this is for diagnosis, not for archiving. */
  readonly answer: string;
}

function traceDirectory(): string {
  const path = join(harborHome(), "traces");

  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  return path;
}

/** One file per month. Small enough to read, coarse enough not to litter. */
function tracePath(at: number): string {
  const date = new Date(at);
  const stamp = `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

  return join(traceDirectory(), `${stamp}.jsonl`);
}

export interface RecordedFeedback {
  readonly id: string;
  readonly path: string;
  readonly offset: number;
}

/**
 * Writes the trace, then the verdict pointing at it.
 *
 * In that order, and it matters: a verdict pointing at a trace that was never
 * written is a row that cannot be replayed, which is the only thing these rows
 * are for. A trace with no verdict is merely unused.
 *
 * The offset is the byte position of the line, so a replay reads one record
 * rather than parsing a year of them.
 */
export function recordFeedback(
  db: DB,
  input: {
    readonly principalId: string;
    readonly verdict: Verdict;
    readonly note?: string | null;
    readonly trace: Trace;
  },
): RecordedFeedback {
  const path = tracePath(input.trace.at);
  const offset = existsSync(path) ? statSync(path).size : 0;

  appendFileSync(path, `${JSON.stringify(input.trace)}\n`, { mode: 0o600 });

  const id = randomUUID();

  db.prepare(
    `INSERT INTO feedback
       (id, principal_id, question, verdict, note, surface, trace_path, trace_offset, created_at)
     VALUES (@id, @principalId, @question, @verdict, @note, @surface, @path, @offset, @at)`,
  ).run({
    id,
    principalId: input.principalId,
    question: input.trace.question,
    verdict: input.verdict,
    note: input.note ?? null,
    surface: input.trace.surface,
    path,
    offset,
    at: Date.now(),
  });

  return { id, path, offset };
}

export interface FeedbackRow {
  readonly id: string;
  readonly question: string;
  readonly verdict: Verdict;
  readonly note: string | null;
  readonly surface: string;
  readonly createdAt: number;
  readonly tracePath: string | null;
  readonly traceOffset: number | null;
}

export function feedbackCases(
  db: DB,
  principalId: string,
  options: { readonly verdict?: Verdict; readonly limit?: number } = {},
): readonly FeedbackRow[] {
  const rows = db
    .prepare(
      `SELECT id, question, verdict, note, surface, created_at, trace_path, trace_offset
       FROM feedback
       WHERE principal_id = @principalId
         ${options.verdict === undefined ? "" : "AND verdict = @verdict"}
       ORDER BY created_at DESC
       LIMIT @limit`,
    )
    .all({
      principalId,
      verdict: options.verdict ?? "",
      limit: options.limit ?? 500,
    }) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row["id"] as string,
    question: row["question"] as string,
    verdict: row["verdict"] as Verdict,
    note: (row["note"] as string | null) ?? null,
    surface: row["surface"] as string,
    createdAt: row["created_at"] as number,
    tracePath: (row["trace_path"] as string | null) ?? null,
    traceOffset: (row["trace_offset"] as number | null) ?? null,
  }));
}

/** Reads back the trace one verdict points at. */
export function readTrace(row: FeedbackRow): Trace | null {
  if (row.tracePath === null || row.traceOffset === null || !existsSync(row.tracePath)) {
    return null;
  }

  const contents = readFileSync(row.tracePath, "utf8");
  const line = contents.slice(row.traceOffset).split("\n")[0] ?? "";

  try {
    return JSON.parse(line) as Trace;
  } catch {
    return null;
  }
}

/**
 * Removes the obvious identifiers from a trace.
 *
 * Blunt on purpose. A subtle redactor is one nobody can check, and the person
 * deciding whether to share a trace has to be able to read the output and see
 * for themselves what is left. Names are not removed, because a trace with the
 * names taken out cannot be reasoned about at all, and that is the trade to
 * state plainly rather than to make silently.
 */
export function redact(trace: Trace): Trace {
  const scrub = (text: string): string =>
    text
      .replace(/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g, "<email>")
      .replace(/\+?\d[\d\s().-]{8,17}\d/g, "<number>")
      .replace(/\bhttps?:\/\/\S+/g, "<url>")
      .replace(/\b\d{1,5}\s+[A-Z][\w.-]*(?:\s+[A-Z][\w.-]*){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road)\b/g, "<address>");

  return {
    ...trace,
    question: scrub(trace.question),
    answer: scrub(trace.answer),
    candidates: trace.candidates.map((candidate) => ({
      ...candidate,
      title: candidate.title === null ? null : scrub(candidate.title),
      because: candidate.because.map(scrub),
    })),
  };
}

export interface FeedbackSummary {
  readonly up: number;
  readonly down: number;
  readonly withTrace: number;
}

export function feedbackSummary(db: DB, principalId: string): FeedbackSummary {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN verdict = 'up' THEN 1 ELSE 0 END) AS up,
         SUM(CASE WHEN verdict = 'down' THEN 1 ELSE 0 END) AS down,
         SUM(CASE WHEN trace_path IS NOT NULL THEN 1 ELSE 0 END) AS withTrace
       FROM feedback WHERE principal_id = ?`,
    )
    .get(principalId) as { up: number | null; down: number | null; withTrace: number | null };

  return {
    up: row.up ?? 0,
    down: row.down ?? 0,
    withTrace: row.withTrace ?? 0,
  };
}
