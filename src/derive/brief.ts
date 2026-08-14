/**
 * Running detectors, and composing the brief.
 *
 * The budget is the most important number in this file and the default is
 * deliberately uncomfortable. Three. If Harbor tells you eight things every
 * morning you stop reading within a week, and it will have made itself useless
 * while every individual component worked correctly. A brief that is usually
 * empty is a success, not a failure.
 *
 * The feedback loop is the other half. Dismissals are the only quality signal
 * available, so a detector the user keeps waving away gets muted automatically
 * and reported, rather than left running to slowly poison the whole surface.
 */
import { humanWhen } from "../kernel/time.js";
import { DETECTORS } from "./detectors.js";
import { getItem } from "../store/items.js";
import {
  bumpDetector,
  detectorStats,
  dueObservations,
  expireInterests,
  recordBrief,
  setDetectorSuppressed,
  setObservationState,
} from "../store/signals.js";
import type { DB } from "../kernel/db.js";
import type { Embedder } from "./embed/index.js";
import type { DetectorResult } from "./detectors.js";
import type { Observation } from "../store/signals.js";

/** How small a brief has to be to stay worth reading. */
export const DEFAULT_BUDGET = 3;

/** Dismissal rate above which a detector mutes itself, once it has a track record. */
const SUPPRESS_RATE = 0.7;
const SUPPRESS_MIN_SAMPLES = 8;

export interface RunOptions {
  readonly principalId: string;
  readonly timezone: string;
  readonly embedder?: Embedder | undefined;
  readonly now?: number;
}

export interface RunReport {
  readonly results: readonly DetectorResult[];
  readonly interestsExpired: number;
  readonly suppressed: readonly string[];
  readonly durationMs: number;
}

export function runDetectors(db: DB, options: RunOptions): RunReport {
  const started = Date.now();
  const now = options.now ?? started;

  const interestsExpired = expireInterests(db, options.principalId, now);

  const context = {
    principalId: options.principalId,
    timezone: options.timezone,
    now,
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
  };

  const results: DetectorResult[] = [];

  for (const detector of DETECTORS) {
    results.push(detector.run(db, context));
  }

  // A detector with a track record of being ignored stops running. This is the
  // only thing preventing "add another detector" from being strictly negative.
  const suppressed: string[] = [];

  for (const stats of detectorStats(db)) {
    if (
      !stats.suppressed &&
      stats.surfaced >= SUPPRESS_MIN_SAMPLES &&
      stats.dismissalRate >= SUPPRESS_RATE
    ) {
      setDetectorSuppressed(db, stats.detectorId, true);
      suppressed.push(stats.detectorId);
    }
  }

  return {
    results,
    interestsExpired,
    suppressed,
    durationMs: Date.now() - started,
  };
}

export interface BriefEntry {
  readonly observation: Observation;
  readonly evidence: readonly {
    readonly id: string;
    readonly title: string | null;
    readonly author: string | null;
    readonly when: string;
    readonly link: string | null;
  }[];
}

export interface Brief {
  readonly id: number | null;
  readonly entries: readonly BriefEntry[];
  readonly budget: number;
  readonly withheld: number;
}

/**
 * Composes a brief and marks what it contains as surfaced.
 *
 * `preview` runs the same selection without recording anything, so looking at
 * what Harbor would say does not consume the suppression.
 */
/**
 * Drops observations already covered by a better one.
 *
 * The graph made this necessary and also made it possible. A cross-source
 * observation about a meeting cites the messages that arranged it, and the
 * single-source detector cites one of those same messages on its own, so the
 * brief said the same thing three times in descending order of usefulness.
 *
 * Subsumption is by evidence: if everything one observation points at is
 * already pointed at by a stronger one, the weaker adds nothing. Comparing
 * evidence rather than titles means this needs no notion of what the detectors
 * mean, only what they saw.
 */
function withoutSubsumed<T extends { readonly observation: { readonly salience: number }; readonly evidence: readonly { readonly id: string }[] }>(
  entries: readonly T[],
): readonly T[] {
  const ordered = [...entries].sort(
    (a, b) =>
      b.evidence.length - a.evidence.length || b.observation.salience - a.observation.salience,
  );

  const kept: T[] = [];

  for (const entry of ordered) {
    const ids = new Set(entry.evidence.map((item) => item.id));

    if (ids.size === 0) {
      kept.push(entry);
      continue;
    }

    const covered = kept.some((other) => {
      const theirs = new Set(other.evidence.map((item) => item.id));
      return [...ids].every((id) => theirs.has(id));
    });

    if (!covered) {
      kept.push(entry);
    }
  }

  // Back to salience order for display; subsumption is about what to show, not
  // what order to show it in.
  return kept.sort((a, b) => b.observation.salience - a.observation.salience);
}

/**
 * Per-account weight, applied to salience only.
 *
 * A signup address that exists to get past popups produces real, correctly
 * ingested mail that is worth nothing to interrupt somebody about. Weight is
 * the one place Harbor is told that, and it is deliberately confined to the
 * brief: retrieval is untouched, so asking about something in a low-weight
 * account still finds it. The weight decides what is worth saying unprompted,
 * not what Harbor knows.
 *
 * An observation takes the highest weight among its evidence, not the average.
 * One message from a person who matters is enough to make something worth
 * saying, even if the other four pieces of evidence are marketing mail.
 */
function weighted<T extends { readonly observation: Observation; readonly evidence: readonly { readonly id: string }[] }>(
  db: DB,
  entries: readonly T[],
): readonly T[] {
  if (entries.length === 0) {
    return entries;
  }

  const lookup = db.prepare(
    `SELECT MAX(a.weight) AS weight FROM items i
     JOIN accounts a ON a.id = i.account_id
     WHERE i.id = ?`,
  );

  const scored = entries.map((entry) => {
    let weight = 0;

    for (const item of entry.evidence) {
      const row = lookup.get(item.id) as { weight: number | null } | undefined;
      weight = Math.max(weight, row?.weight ?? 1);
    }

    const effective = entry.evidence.length === 0 ? 1 : weight;

    return {
      entry,
      salience: entry.observation.salience * effective,
    };
  });

  return scored
    .sort((left, right) => right.salience - left.salience)
    .map((scored_) => scored_.entry);
}

export function composeBrief(
  db: DB,
  options: RunOptions & { readonly budget?: number; readonly preview?: boolean },
): Brief {
  const now = options.now ?? Date.now();
  const budget = options.budget ?? DEFAULT_BUDGET;

  // Over-fetch by one so the caller can honestly say how much was held back.
  const candidates = dueObservations(db, options.principalId, now, budget + 25);

  // Subsumption happens before the budget, not after. Otherwise three views of
  // one situation consume the whole allowance and the second real thing never
  // gets said.
  const hydrated: BriefEntry[] = candidates.map((observation) => ({
    observation,
    evidence: observation.evidence.flatMap((id) => {
      const item = getItem(db, id);

      if (item === null) {
        return [];
      }

      return [
        {
          id: item.id,
          title: item.title,
          author: item.author,
          when: humanWhen(item.occurredAt, options.timezone),
          link: item.uri,
        },
      ];
    }),
  }));

  const distinct = weighted(db, withoutSubsumed(hydrated));
  const entries = distinct.slice(0, budget);
  const withheld = distinct.length - entries.length;

  if (options.preview === true) {
    return { id: null, entries, budget, withheld };
  }

  // Only what was actually shown is marked surfaced. Marking a subsumed
  // observation would suppress it forever without anyone having read it.
  const shown = entries.map((entry) => entry.observation);

  const write = db.transaction(() => {
    for (const observation of shown) {
      setObservationState(db, observation.id, "surfaced");
      bumpDetector(db, observation.detectorId, "surfaced");
    }
  });

  write();

  const id =
    shown.length === 0
      ? null
      : recordBrief(
          db,
          options.principalId,
          shown.map((observation) => observation.id),
          budget,
        );

  return { id, entries, budget, withheld };
}

export function dismissObservation(db: DB, id: string, detectorId: string): void {
  setObservationState(db, id, "dismissed");
  bumpDetector(db, detectorId, "dismissed");
}

/**
 * Deterministic rendering.
 *
 * The brief is readable with no model call at all. Phrasing it better is an
 * optional upgrade, which is the cost ladder showing up where it matters: the
 * expensive part of a daily proactive feature should be optional, not
 * structural.
 */
export function renderBrief(brief: Brief): string {
  if (brief.entries.length === 0) {
    return "Nothing worth interrupting you about.";
  }

  const lines: string[] = [];

  for (const entry of brief.entries) {
    lines.push(entry.observation.title);

    if (entry.observation.detail !== null) {
      lines.push(`  ${entry.observation.detail}`);
    }

    for (const item of entry.evidence) {
      lines.push(`  ${item.when}  ${item.author ?? ""}`.trimEnd());
      if (item.link !== null) {
        lines.push(`  ${item.link}`);
      }
    }

    lines.push(`  [${entry.observation.id}]`);
    lines.push("");
  }

  if (brief.withheld > 0) {
    lines.push(
      `${String(brief.withheld)} more held back to stay inside a budget of ${String(brief.budget)}.`,
    );
  }

  return lines.join("\n").trimEnd();
}
