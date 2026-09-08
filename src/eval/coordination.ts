/**
 * Measuring whether Harbor got the event structure right.
 *
 * Everything in the derive layer has been argued rather than measured. The
 * rarity ceiling, the 0.6 admission bar, the two-kinds rule, the three day
 * window on a shared place: each is written down with its reasoning attached
 * and none of them has ever been scored against a case where the right answer
 * was known. That is fine for a prototype and it is not fine for a rewrite,
 * because a rewrite without a baseline is a rewrite that cannot be shown to
 * have helped.
 *
 * ## What is being measured
 *
 * The task is a clustering: given a pile of observations, which of them are
 * evidence about the same real-world occurrence. So the metric is a clustering
 * metric, and the useful ones here are pairwise.
 *
 * A *gold pair* is two observations the fixture says belong to one event. A
 * *predicted pair* is two observations Harbor put in one story or situation.
 * Precision and recall follow, and so do the two numbers that actually matter:
 *
 *   **Over-merges** are predicted pairs that are not gold pairs. Two evenings
 *   welded into one. This is the damaging error: it produces a confident
 *   sentence about an occurrence that never happened, and the person reading it
 *   has no way to see that two things were fused.
 *
 *   **Over-splits** are gold pairs Harbor did not predict. Evidence that should
 *   have been gathered and was not. This is the cautious error: the answer is
 *   thin, and thin is visible.
 *
 * They are not equally bad and the score says so. `cost` weights an over-merge
 * at several times an over-split, which is the explicit statement of the
 * instruction that a false merge is worse than a cautious split. Reporting only
 * F1 would hide exactly the trade this system is being asked to make.
 *
 * ## Why not just count stories
 *
 * Because the number of stories is trivially gameable in both directions and
 * correlates with nothing. A build that merges everything into one situation
 * scores one story and is useless; a build that refuses to merge anything
 * scores many and is equally useless. Only the induced partition is worth
 * looking at.
 *
 * ## B-cubed
 *
 * Reported alongside because pairwise metrics are dominated by large clusters:
 * one twelve-message conversation contributes sixty-six pairs and can drown out
 * five wrong merges elsewhere. B-cubed weights each observation equally
 * regardless of how big its cluster is, so the two together say more than
 * either alone.
 */

/** A set of observation ids the fixture says are one occurrence. */
export interface GoldEvent {
  readonly name: string;
  readonly members: readonly string[];
}

export interface Gold {
  readonly events: readonly GoldEvent[];
  /**
   * Observations that belong to no event.
   *
   * Not the same as absent. These are the hard negatives: a newsletter that
   * mentions the venue, a conversation that happened nearby, a plan nobody
   * accepted. They are named so that pulling one in counts as an over-merge
   * rather than passing unnoticed.
   */
  readonly unassigned?: readonly string[];
}

/** What the system under test produced, as sets of observation ids. */
export type Predicted = readonly (readonly string[])[];

export interface PairCounts {
  readonly agreed: number;
  readonly overMerged: number;
  readonly overSplit: number;
}

export interface Score {
  readonly pairs: PairCounts;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** B-cubed, which weights observations rather than pairs. */
  readonly bcubedPrecision: number;
  readonly bcubedRecall: number;
  /** Over-merges weighted against over-splits. Lower is better. */
  readonly cost: number;
  /** Gold events with no predicted cluster covering most of them. */
  readonly missed: readonly string[];
  /** Over-merged pairs, named, so a failure can be read rather than counted. */
  readonly worstMerges: readonly string[];
}

/**
 * How much worse a false merge is than a cautious split.
 *
 * Four, and the number is a statement of intent rather than a measurement. An
 * over-split leaves a thin answer that a person can see is thin. An over-merge
 * produces a fluent, confident sentence about an evening that did not happen,
 * and nothing in the interface marks it as a fusion of two things. The second
 * failure is both more damaging and harder to notice, and the cost function
 * should say so out loud rather than leaving it to a reviewer's judgement.
 */
export const MERGE_COST = 4;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairsOf(members: readonly string[]): Set<string> {
  // Deduplicated first. A cluster can legitimately name one observation twice
  // (an item attached directly and again through the episode containing it),
  // and without this that produces a self-pair which is counted as an
  // over-merge: the metric reporting a fault of its own as a fault of the
  // system under test.
  const cluster = [...new Set(members)];
  const pairs = new Set<string>();

  for (let i = 0; i < cluster.length; i += 1) {
    for (let j = i + 1; j < cluster.length; j += 1) {
      pairs.add(pairKey(cluster[i] ?? "", cluster[j] ?? ""));
    }
  }

  return pairs;
}

function union(sets: readonly Set<string>[]): Set<string> {
  const all = new Set<string>();

  for (const set of sets) {
    for (const value of set) {
      all.add(value);
    }
  }

  return all;
}

/**
 * Scores a predicted clustering against the gold one.
 *
 * Observations the fixture never mentions are ignored entirely. A build that
 * drags an unrelated item from elsewhere in the store into a story is not
 * penalised here, and that is deliberate: this measures the fixture's own
 * structure, and a store with other things in it is a different experiment.
 * Hard negatives are penalised, because the fixture names them.
 */
export function score(gold: Gold, predicted: Predicted): Score {
  const known = new Set<string>([
    ...gold.events.flatMap((event) => event.members),
    ...(gold.unassigned ?? []),
  ]);

  const goldPairs = union(gold.events.map((event) => pairsOf(event.members)));

  // Only ids the fixture knows about. Anything else is outside the experiment.
  const clusters = predicted
    .map((cluster) => cluster.filter((id) => known.has(id)))
    .filter((cluster) => cluster.length > 1);

  const predictedPairs = union(clusters.map(pairsOf));

  let agreed = 0;

  for (const pair of predictedPairs) {
    if (goldPairs.has(pair)) {
      agreed += 1;
    }
  }

  const overMerged = predictedPairs.size - agreed;
  const overSplit = goldPairs.size - agreed;

  const precision = predictedPairs.size === 0 ? 1 : agreed / predictedPairs.size;
  const recall = goldPairs.size === 0 ? 1 : agreed / goldPairs.size;

  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // Which gold events were found at all. A cluster covering more than half an
  // event is "found"; anything less is not the same occurrence in any useful
  // sense, whatever the pair counts say.
  const missed: string[] = [];

  for (const event of gold.events) {
    if (event.members.length < 2) {
      continue;
    }

    const covered = clusters.some((cluster) => {
      const overlap = cluster.filter((id) => event.members.includes(id)).length;

      return overlap > event.members.length / 2;
    });

    if (!covered) {
      missed.push(event.name);
    }
  }

  return {
    pairs: { agreed, overMerged, overSplit },
    precision,
    recall,
    f1,
    ...bcubed(gold, clusters, known),
    cost: overMerged * MERGE_COST + overSplit,
    missed,
    worstMerges: [...predictedPairs]
      .filter((pair) => !goldPairs.has(pair))
      .slice(0, 8)
      .map((pair) => pair.replace("|", " + ")),
  };
}

function bcubed(
  gold: Gold,
  clusters: readonly (readonly string[])[],
  known: ReadonlySet<string>,
): { bcubedPrecision: number; bcubedRecall: number } {
  const goldOf = new Map<string, readonly string[]>();

  for (const event of gold.events) {
    for (const member of event.members) {
      goldOf.set(member, event.members);
    }
  }

  for (const id of gold.unassigned ?? []) {
    goldOf.set(id, [id]);
  }

  const predictedOf = new Map<string, readonly string[]>();

  for (const cluster of clusters) {
    for (const member of cluster) {
      predictedOf.set(member, cluster);
    }
  }

  let precision = 0;
  let recall = 0;
  let counted = 0;

  for (const id of known) {
    const goldCluster = goldOf.get(id) ?? [id];
    const predictedCluster = predictedOf.get(id) ?? [id];

    const shared = predictedCluster.filter((other) => goldCluster.includes(other)).length;

    precision += shared / predictedCluster.length;
    recall += shared / goldCluster.length;
    counted += 1;
  }

  return {
    bcubedPrecision: counted === 0 ? 1 : precision / counted,
    bcubedRecall: counted === 0 ? 1 : recall / counted,
  };
}

export interface SuiteResult {
  readonly scenario: string;
  readonly score: Score;
}

export interface SuiteSummary {
  readonly results: readonly SuiteResult[];
  readonly overMerged: number;
  readonly overSplit: number;
  readonly cost: number;
  readonly missed: number;
  readonly meanF1: number;
}

export function summarize(results: readonly SuiteResult[]): SuiteSummary {
  const overMerged = results.reduce((total, entry) => total + entry.score.pairs.overMerged, 0);
  const overSplit = results.reduce((total, entry) => total + entry.score.pairs.overSplit, 0);

  return {
    results,
    overMerged,
    overSplit,
    cost: results.reduce((total, entry) => total + entry.score.cost, 0),
    missed: results.reduce((total, entry) => total + entry.score.missed.length, 0),
    meanF1:
      results.length === 0
        ? 0
        : results.reduce((total, entry) => total + entry.score.f1, 0) / results.length,
  };
}

/** A readable report. Used by the CLI and by the test when it fails. */
export function report(summary: SuiteSummary): string {
  const lines: string[] = [];

  for (const entry of summary.results) {
    const { pairs } = entry.score;

    lines.push(
      `${entry.scenario.padEnd(34)} ` +
        `merge ${String(pairs.overMerged).padStart(3)}  ` +
        `split ${String(pairs.overSplit).padStart(3)}  ` +
        `f1 ${entry.score.f1.toFixed(2)}  ` +
        `cost ${String(entry.score.cost).padStart(4)}` +
        (entry.score.missed.length > 0 ? `  missed: ${entry.score.missed.join(", ")}` : ""),
    );

    for (const merge of entry.score.worstMerges) {
      lines.push(`    over-merged: ${merge}`);
    }
  }

  lines.push("");
  lines.push(
    `total  over-merged ${String(summary.overMerged)}  over-split ${String(summary.overSplit)}  ` +
      `missed ${String(summary.missed)}  mean f1 ${summary.meanF1.toFixed(3)}  cost ${String(summary.cost)}`,
  );

  return lines.join("\n");
}
