/**
 * Replaying what somebody judged, against what the code does now.
 *
 * The point of collecting verdicts is not the verdicts. It is that a change to
 * `gather.ts` or `linkers.ts` can be answered with a number instead of an
 * argument: eleven of eleven approved cases still retrieve what they retrieved,
 * and two rejected ones no longer do.
 *
 * ## What is compared, and what is not
 *
 * Not the answer text. Two runs of the same question against the same store
 * produce two different sentences, both correct, and comparing them measures
 * the model's phrasing rather than Harbor's retrieval. A replay that reported a
 * regression every time a model chose a different word would be worse than no
 * replay, because it would train the reader to ignore it.
 *
 * What is compared is the retrieval: which nodes came back, and whether the
 * ones that mattered are still there. That is deterministic, it is the part
 * this codebase actually controls, and it is where a threshold change shows up.
 *
 * ## What a regression means
 *
 * For a thumbs-up case: something that was retrieved no longer is. That is a
 * loss of recall and it is unambiguous, because a person said the answer was
 * good and the material behind it has gone.
 *
 * For a thumbs-down case: nothing is claimed. A negative verdict says the
 * answer was bad without saying why, and the cause is as often the sentence as
 * the retrieval. These are reported as "still failing" or "changed" and never
 * as passing, because there is no evidence available here that would justify
 * calling one fixed. Somebody has to look.
 *
 * That asymmetry is the honest shape of this data, and pretending otherwise
 * would produce a green number that means nothing.
 */
import { feedbackCases, readTrace } from "./feedback.js";
import type { DB } from "../kernel/db.js";
import type { FeedbackRow, Trace } from "./feedback.js";

export type CaseOutcome =
  /** Approved, and everything it was built on is still retrieved. */
  | "held"
  /** Approved, and something it was built on is no longer retrieved. */
  | "regressed"
  /** Rejected before, and retrieval is unchanged, so nothing has been fixed. */
  | "still_failing"
  /** Rejected before, and retrieval has changed. Worth a human look. */
  | "changed"
  /** The trace is missing, so there is nothing to compare against. */
  | "untestable";

export interface CaseResult {
  readonly id: string;
  readonly question: string;
  readonly verdict: "up" | "down";
  readonly outcome: CaseOutcome;
  /** Refs that were retrieved then and are not now. */
  readonly lost: readonly string[];
  /** Refs retrieved now that were not then. */
  readonly gained: readonly string[];
  readonly note: string | null;
}

export interface EvalReport {
  readonly cases: readonly CaseResult[];
  readonly held: number;
  readonly regressed: number;
  readonly stillFailing: number;
  readonly changed: number;
  readonly untestable: number;
}

/**
 * How retrieval is reproduced for a recorded case.
 *
 * Supplied by the caller rather than reached for, because the honest version of
 * this needs the same tools the `ask` loop uses and this module should not
 * import the reasoning layer to run a comparison. The CLI wires it.
 */
export type Retrieve = (question: string) => readonly string[];

function admittedRefs(trace: Trace): readonly string[] {
  return trace.candidates.filter((candidate) => candidate.admitted).map((candidate) => candidate.ref);
}

function outcomeFor(
  row: FeedbackRow,
  lost: readonly string[],
  gained: readonly string[],
): CaseOutcome {
  if (row.verdict === "up") {
    return lost.length === 0 ? "held" : "regressed";
  }

  return lost.length === 0 && gained.length === 0 ? "still_failing" : "changed";
}

export function runEval(
  db: DB,
  principalId: string,
  retrieve: Retrieve,
  options: { readonly limit?: number } = {},
): EvalReport {
  const rows = feedbackCases(db, principalId, { limit: options.limit ?? 200 });
  const cases: CaseResult[] = [];

  for (const row of rows) {
    const trace = readTrace(row);

    if (trace === null) {
      cases.push({
        id: row.id,
        question: row.question,
        verdict: row.verdict,
        outcome: "untestable",
        lost: [],
        gained: [],
        note: row.note,
      });

      continue;
    }

    const before = new Set(admittedRefs(trace));
    const after = new Set(retrieve(row.question));

    const lost = [...before].filter((ref) => !after.has(ref));
    const gained = [...after].filter((ref) => !before.has(ref));

    cases.push({
      id: row.id,
      question: row.question,
      verdict: row.verdict,
      outcome: outcomeFor(row, lost, gained),
      lost,
      gained,
      note: row.note,
    });
  }

  const count = (outcome: CaseOutcome): number =>
    cases.filter((entry) => entry.outcome === outcome).length;

  return {
    cases,
    held: count("held"),
    regressed: count("regressed"),
    stillFailing: count("still_failing"),
    changed: count("changed"),
    untestable: count("untestable"),
  };
}
