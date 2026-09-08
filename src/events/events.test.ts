/**
 * The decision layer, tested where the suite cannot see it.
 *
 * `coordination.test.ts` measures the whole pipeline against labelled
 * scenarios, which is the number that matters and is also a blunt instrument:
 * it says the answer changed without saying which mechanism changed it. These
 * are the mechanisms, checked directly, so that a regression names itself.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { combine, loadWeights, PRIORS } from "./features.js";
import { fit, type Example } from "./calibrate.js";
import { openTestStore } from "../fixtures/harness.js";
import type { Feature } from "./features.js";

function weights() {
  const store = openTestStore();

  try {
    return { set: loadWeights(store.db), close: () => store.close() };
  } catch (error) {
    store.close();
    throw error;
  }
}

const feature = (name: string, value = 1): Feature => ({
  name,
  value,
  evidence: `${name} fired`,
});

describe("combining evidence", () => {
  test("nothing at all is a no", () => {
    const held = weights();

    try {
      const scored = combine([], held.set, "context");

      // The prior is against belonging, which is the honest default: most pairs
      // of things in a store have nothing to do with each other.
      assert.ok(scored.probability < 0.2);
    } finally {
      held.close();
    }
  });

  test("one decisive feature is enough", () => {
    const held = weights();

    try {
      const scored = combine([feature("ref_shared")], held.set, "spine");

      assert.ok(scored.probability > 0.75, scored.probability.toFixed(3));
    } finally {
      held.close();
    }
  });

  test("one contradiction beats several weak agreements", () => {
    const held = weights();

    try {
      // The thing the old additive scorer could not express at all. Every
      // branch there added, so a stated time that the event cannot have could
      // only ever be handled as a special-case rejection somewhere else.
      const agreeable = combine(
        [feature("topic_overlap"), feature("people_overlap"), feature("in_span")],
        held.set,
        "during",
      );

      const contradicted = combine(
        [
          feature("topic_overlap"),
          feature("people_overlap"),
          feature("in_span"),
          feature("time_conflict"),
        ],
        held.set,
        "during",
      );

      assert.ok(agreeable.probability > contradicted.probability);
      assert.ok(contradicted.probability < 0.1, contradicted.probability.toFixed(3));
    } finally {
      held.close();
    }
  });

  test("every feature reports its own contribution", () => {
    const held = weights();

    try {
      const scored = combine([feature("place_same"), feature("broadcast")], held.set, "context");

      const place = scored.features.find((entry) => entry.name === "place_same");
      const broadcast = scored.features.find((entry) => entry.name === "broadcast");

      assert.ok((place?.contribution ?? 0) > 0);
      assert.ok((broadcast?.contribution ?? 0) < 0);

      // Provenance improves rather than degrades: the old scorer recorded an
      // unattributable 0.4, and this records which term produced which part of
      // the final number.
      assert.equal(
        scored.logOdds.toFixed(4),
        (
          PRIORS["bias"]!.weight +
          (place?.contribution ?? 0) +
          (broadcast?.contribution ?? 0)
        ).toFixed(4),
      );
    } finally {
      held.close();
    }
  });

  test("only features that moved the number get a sentence", () => {
    const held = weights();

    try {
      const scored = combine(
        [feature("ref_shared"), feature("topic_overlap", 0.01)],
        held.set,
        "spine",
      );

      // A list naming every term that scored zero is a worse explanation than
      // one naming the feature that decided it.
      assert.equal(scored.evidence.length, 1);
    } finally {
      held.close();
    }
  });

  test("weights come from the store, so a fitted set takes effect", () => {
    const store = openTestStore();

    try {
      loadWeights(store.db);

      store.db
        .prepare(`UPDATE model_weights SET weight = ? WHERE model = ? AND feature = ?`)
        .run(9, "membership.v1", "topic_overlap");

      const scored = combine([feature("topic_overlap")], loadWeights(store.db), "context");

      assert.ok(scored.probability > 0.9, "the table is what runs, not the constant");
    } finally {
      store.close();
    }
  });
});

describe("calibration", () => {
  const scenarioExamples: readonly Example[] = [
    { features: { ref_shared: 1 }, label: true, source: "scenario" },
    { features: { topic_overlap: 1 }, label: false, source: "scenario" },
  ];

  test("fitting on the test set alone is refused", () => {
    const outcome = fit(scenarioExamples);

    // Fitting to the fixtures would produce a build that scores well on the
    // only thing measuring it, which is worse than not fitting at all.
    assert.ok(outcome.refused !== null);
    assert.deepEqual(outcome.moved, []);
  });

  test("with real labels, a clearly wrong weight moves", () => {
    const examples: Example[] = [];

    for (let index = 0; index < 40; index += 1) {
      // Feedback saying that a shared topic word alone is a real membership.
      // The prior disagrees; forty examples should shift it.
      examples.push({ features: { topic_overlap: 1 }, label: true, source: "feedback" });
    }

    const outcome = fit(examples);

    assert.equal(outcome.refused, null);

    const moved = outcome.moved.find((entry) => entry.feature === "topic_overlap");

    assert.ok(moved !== undefined, "the weight the data disagreed with did not move");
    assert.ok(moved.to > moved.from);
  });

  test("weights are pulled toward the priors, not toward zero", () => {
    // Two examples cannot be allowed to overturn a belief. Shrinking to zero
    // would say "no opinion" where the honest default is the prior.
    const outcome = fit([
      { features: { ref_shared: 1 }, label: false, source: "feedback" },
      { features: { ref_shared: 1 }, label: false, source: "feedback" },
    ]);

    const held = outcome.weights["ref_shared"] ?? 0;

    assert.ok(held > 2, `a shared confirmation code fell to ${held.toFixed(2)} on two examples`);
  });

  test("accuracy is reported on the examples given", () => {
    const outcome = fit([
      { features: { ref_shared: 1 }, label: true, source: "feedback" },
      { features: {}, label: false, source: "feedback" },
    ]);

    assert.equal(outcome.accuracy, 1);
  });
});
