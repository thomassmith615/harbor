/**
 * Turning stated priors into fitted weights.
 *
 * The point of putting the decision layer in log-odds was never elegance. It
 * was that `weight × value` summed over named features is a logistic
 * regression, and a logistic regression can be fitted from examples, which
 * means the numbers in `model_weights` can stop being one person's beliefs and
 * start being measurements.
 *
 * Nothing about the extraction changes when that happens. The features are the
 * same, the sentences underneath them are the same, and an explanation shown to
 * a person is as true after a fit as before it. That separation is the whole
 * reason the combination was moved out of the branches it used to live in.
 *
 * ## Where labels come from
 *
 * Two sources, and they are honest about being different things.
 *
 * The coordination scenarios are labelled by construction: the fixture says
 * which observations are one event, so every (observation, event) pair it
 * implies is a labelled example. These are clean, they are few, and they were
 * written by somebody trying to break the system, so they are not a sample of
 * anything.
 *
 * The feedback table is real usage. It is sparser, noisier, and it is the only
 * source that reflects what actually happens in one person's life rather than
 * what a fixture author imagined.
 *
 * Fitting on the scenarios alone would be fitting to the test, so a fit is
 * refused unless there are real labels too, and the report says how many of
 * each went in.
 *
 * ## Why plain gradient descent
 *
 * Because the dataset is tens to hundreds of examples with a dozen features,
 * and at that size the fitting method is not what determines the answer. What
 * determines it is the regularisation pulling weights toward the priors, which
 * is doing most of the work here: with forty examples and thirteen features,
 * an unregularised fit will happily send a weight to infinity on the strength
 * of one example, and the prior is a better estimate than that.
 */
import { PRIORS } from "./features.js";
import type { DB } from "../kernel/db.js";

export interface Example {
  /** Feature name to value, as stored on the observation. */
  readonly features: Readonly<Record<string, number>>;
  /** True when the observation really did belong. */
  readonly label: boolean;
  readonly source: "scenario" | "feedback";
}

export interface FitReport {
  readonly examples: number;
  readonly fromFeedback: number;
  readonly fromScenarios: number;
  readonly weights: Readonly<Record<string, number>>;
  /** How much each weight moved from its prior. Large moves deserve a look. */
  readonly moved: readonly { readonly feature: string; readonly from: number; readonly to: number }[];
  readonly accuracy: number;
  readonly refused: string | null;
}

/**
 * How hard weights are pulled back toward their priors.
 *
 * High, deliberately. At this sample size the prior is usually a better
 * estimate than the data, and the job of a fit is to correct a belief that is
 * clearly wrong rather than to replace all of them with whatever forty examples
 * happened to contain.
 */
const REGULARIZATION = 0.5;

const STEPS = 400;
const RATE = 0.1;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Every membership decision the store has recorded, as a labelled example.
 *
 * The label comes from feedback: an event whose answer was approved supplies
 * positive examples, one that was rejected supplies negatives. That is a
 * coarser signal than it looks, because a thumbs-down often means the sentence
 * was bad rather than the membership wrong, which is why `note` is carried
 * through and why a fit on feedback alone is treated as weak evidence.
 */
export function examplesFromFeedback(db: DB, principalId: string): readonly Example[] {
  const rows = db
    .prepare(
      `SELECT f.verdict AS verdict, eo.features AS features
       FROM feedback f
       JOIN event_observations eo ON 1 = 1
       WHERE f.principal_id = ?
       LIMIT 0`,
    )
    .all(principalId) as { verdict: string; features: string }[];

  // Deliberately empty until feedback carries the event it was about.
  //
  // The join above has no condition because there is nothing yet to join on:
  // `feedback` records a question and an answer, not which events the answer
  // was built from. Writing a plausible-looking join that pairs every verdict
  // with every observation would produce a large number of labelled examples
  // and every one of them would be noise, which is worse than having none.
  // The seam is here, the limit is zero, and closing it means recording the
  // events an answer used at the moment the answer is given.
  return rows.map((row) => ({
    features: JSON.parse(row.features) as Record<string, number>,
    label: row.verdict === "up",
    source: "feedback" as const,
  }));
}

/**
 * Fits weights by regularised gradient descent.
 *
 * Returns the weights rather than writing them, so a caller can look before
 * committing. `apply` is the separate step.
 */
export function fit(examples: readonly Example[]): FitReport {
  const fromFeedback = examples.filter((example) => example.source === "feedback").length;
  const fromScenarios = examples.length - fromFeedback;

  const priors: Record<string, number> = {};

  for (const [feature, prior] of Object.entries(PRIORS)) {
    priors[feature] = prior.weight;
  }

  if (fromFeedback === 0) {
    return {
      examples: examples.length,
      fromFeedback,
      fromScenarios,
      weights: priors,
      moved: [],
      accuracy: accuracyOf(examples, priors),
      refused:
        "no real labels: fitting on the scenarios alone would be fitting to the test",
    };
  }

  const weights: Record<string, number> = { ...priors };

  for (let step = 0; step < STEPS; step += 1) {
    const gradient: Record<string, number> = {};

    for (const example of examples) {
      let logOdds = weights["bias"] ?? 0;

      for (const [feature, value] of Object.entries(example.features)) {
        logOdds += (weights[feature] ?? 0) * value;
      }

      const error = sigmoid(logOdds) - (example.label ? 1 : 0);

      gradient["bias"] = (gradient["bias"] ?? 0) + error;

      for (const [feature, value] of Object.entries(example.features)) {
        gradient[feature] = (gradient[feature] ?? 0) + error * value;
      }
    }

    for (const feature of Object.keys(weights)) {
      const slope = (gradient[feature] ?? 0) / examples.length;

      // Pulled toward the prior rather than toward zero. Shrinking to zero
      // would say "no opinion" where the honest default is "the belief we
      // started with", and at this sample size that difference decides most
      // of the weights.
      const pull = REGULARIZATION * ((weights[feature] ?? 0) - (priors[feature] ?? 0));

      weights[feature] = (weights[feature] ?? 0) - RATE * (slope + pull / examples.length);
    }
  }

  const moved = Object.keys(weights)
    .map((feature) => ({
      feature,
      from: priors[feature] ?? 0,
      to: weights[feature] ?? 0,
    }))
    .filter((entry) => Math.abs(entry.to - entry.from) > 0.15)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));

  return {
    examples: examples.length,
    fromFeedback,
    fromScenarios,
    weights,
    moved,
    accuracy: accuracyOf(examples, weights),
    refused: null,
  };
}

function accuracyOf(
  examples: readonly Example[],
  weights: Readonly<Record<string, number>>,
): number {
  if (examples.length === 0) {
    return 0;
  }

  let right = 0;

  for (const example of examples) {
    let logOdds = weights["bias"] ?? 0;

    for (const [feature, value] of Object.entries(example.features)) {
      logOdds += (weights[feature] ?? 0) * value;
    }

    if (sigmoid(logOdds) >= 0.5 === example.label) {
      right += 1;
    }
  }

  return right / examples.length;
}

/**
 * Writes a fitted set, marked as fitted.
 *
 * `origin` matters more than the number. A weight a person wrote down and a
 * weight that came out of forty examples deserve different amounts of trust,
 * and six months later nobody will remember which is which unless it is
 * recorded.
 */
export function apply(
  db: DB,
  weights: Readonly<Record<string, number>>,
  model = "membership.v1",
): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO model_weights (model, feature, weight, origin, note, updated_at)
     VALUES (?, ?, ?, 'fitted', ?, ?)`,
  );

  for (const [feature, weight] of Object.entries(weights)) {
    insert.run(model, feature, weight, PRIORS[feature]?.note ?? null, Date.now());
  }
}

/** Puts the stated priors back. The undo for a fit that made things worse. */
export function reset(db: DB, model = "membership.v1"): number {
  return db.prepare(`DELETE FROM model_weights WHERE model = ?`).run(model).changes;
}
