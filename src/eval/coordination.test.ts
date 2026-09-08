/**
 * The coordination suite, as a test.
 *
 * Two jobs, and they are different jobs.
 *
 * The first is to check the metric. A clustering metric is easy to get subtly
 * wrong and a wrong metric is worse than none, because it makes a rewrite look
 * successful. So the arithmetic is pinned against hand-worked cases where the
 * answer can be counted on fingers.
 *
 * The second is to pin the baseline. These numbers are bad and they are
 * recorded rather than fixed, because the rewrite that follows has to be shown
 * to have improved them and there is nothing to compare against otherwise. The
 * assertions are ceilings, not targets: they fail if the current code gets
 * worse, and they will be tightened as it gets better.
 *
 * A note on why the ceilings are not simply zero. Setting them to the ideal
 * would make this file fail for months and a permanently red test is a test
 * everybody learns to ignore. Setting them at the measured value means any
 * regression is caught tomorrow.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MERGE_COST, score, summarize } from "./coordination.js";
import { runSuite } from "./run.js";
import { SCENARIOS } from "../fixtures/scenarios.js";

describe("the metric", () => {
  const gold = {
    events: [
      { name: "a", members: ["1", "2", "3"] },
      { name: "b", members: ["4", "5"] },
    ],
    unassigned: ["6"],
  };

  test("a perfect clustering scores perfectly", () => {
    const result = score(gold, [
      ["1", "2", "3"],
      ["4", "5"],
    ]);

    assert.equal(result.pairs.overMerged, 0);
    assert.equal(result.pairs.overSplit, 0);
    assert.equal(result.f1, 1);
    assert.equal(result.cost, 0);
  });

  test("fusing two events is counted as six over-merged pairs", () => {
    // Three members times two members. Counting pairs rather than clusters is
    // what makes a big wrong merge cost more than a small one.
    const result = score(gold, [["1", "2", "3", "4", "5"]]);

    assert.equal(result.pairs.overMerged, 6);
    assert.equal(result.pairs.overSplit, 0);
  });

  test("splitting an event is counted, and costs less", () => {
    const split = score(gold, [["1", "2"], ["3"], ["4", "5"]]);
    const merged = score(gold, [["1", "2", "3", "4", "5"]]);

    assert.equal(split.pairs.overSplit, 2);
    assert.ok(
      split.cost < merged.cost,
      "a cautious split has to be cheaper than a confident fusion",
    );
    assert.equal(MERGE_COST, 4);
  });

  test("pulling in a hard negative is an over-merge", () => {
    // The point of naming unassigned observations. Without them, dragging a
    // newsletter into an evening is invisible to the score.
    const result = score(gold, [
      ["1", "2", "3", "6"],
      ["4", "5"],
    ]);

    assert.equal(result.pairs.overMerged, 3);
  });

  test("an observation the fixture never mentions is ignored", () => {
    const result = score(gold, [
      ["1", "2", "3", "999"],
      ["4", "5"],
    ]);

    assert.equal(result.pairs.overMerged, 0);
  });

  test("a missed event is reported by name, not only counted", () => {
    const result = score(gold, [["1", "2", "3"]]);

    assert.deepEqual(result.missed, ["b"]);
  });

  test("b-cubed weights observations, not pairs", () => {
    // One wrong merge inside a large cluster barely moves pairwise precision
    // and should visibly move b-cubed, which is why both are reported.
    const wide = {
      events: [
        { name: "big", members: ["1", "2", "3", "4", "5", "6", "7", "8"] },
        { name: "small", members: ["9", "10"] },
      ],
    };

    const fused = score(wide, [["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]]);

    assert.ok(fused.bcubedPrecision < 1);
    assert.equal(fused.bcubedRecall, 1);
  });

  test("summarising adds up the parts", () => {
    const summary = summarize([
      { scenario: "x", score: score(gold, [["1", "2", "3", "4", "5"]]) },
      { scenario: "y", score: score(gold, [["1", "2", "3"], ["4", "5"]]) },
    ]);

    assert.equal(summary.overMerged, 6);
    assert.equal(summary.cost, 24);
  });
});

describe("the suite covers what it claims to", () => {
  test("every scenario states what it is testing", () => {
    for (const scenario of SCENARIOS) {
      assert.ok(scenario.about.length > 10, scenario.name);
      assert.ok(scenario.observations.length > 0, scenario.name);
    }
  });

  test("gold labels never put one observation in two events", () => {
    for (const scenario of SCENARIOS) {
      const seen = new Set<string>();

      for (const event of scenario.gold.events) {
        for (const member of event.members) {
          assert.ok(!seen.has(member), `${scenario.name}: ${member} is in two events`);
          seen.add(member);
        }
      }
    }
  });

  test("gold labels refer to observations that exist", () => {
    for (const scenario of SCENARIOS) {
      const ids = new Set(scenario.observations.map((observation) => observation.id));

      for (const event of scenario.gold.events) {
        for (const member of event.members) {
          assert.ok(ids.has(member), `${scenario.name}: ${member} is not in the fixture`);
        }
      }

      for (const id of scenario.gold.unassigned ?? []) {
        assert.ok(ids.has(id), `${scenario.name}: ${id} is not in the fixture`);
      }
    }
  });

  test("at least half the scenarios are hard negatives", () => {
    // A suite of positives measures reach and calls it accuracy. The cases
    // worth having are the ones where similarity is right about the pairs and
    // wrong about the event.
    const negatives = SCENARIOS.filter(
      (scenario) => scenario.gold.events.length > 1 || (scenario.gold.unassigned ?? []).length > 0,
    );

    assert.ok(negatives.length >= SCENARIOS.length / 2, `${String(negatives.length)} of ${String(SCENARIOS.length)}`);
  });
});

/**
 * What was measured before the rewrite, recorded rather than re-run.
 *
 * `situations` is retired: `relate` no longer builds connected components, so
 * the "situations" and "both" rows cannot be reproduced by running the current
 * code and asserting them live would be asserting that a retired pass still
 * behaves as it used to. They are written down here instead, which is what a
 * baseline is for.
 *
 *                  over-merged  over-split  missed  mean f1  cost
 *   stories                 22          33      11    0.486   121
 *   situations              22          29       8    0.605   117
 *   both (as shown)         30          17       6    0.666   137
 *
 * The last row is the finding that motivated the rewrite: two partially
 * inconsistent representations, shown together, over-merged more than either
 * did alone.
 */
const BEFORE = { overMerged: 30, overSplit: 17, missed: 6, meanF1: 0.666, cost: 137 } as const;

describe("the baseline", () => {
  test("the event model over-merges nothing", async () => {
    const events = await runSuite(SCENARIOS, { model: "events" });

    // The error that matters. A confident fusion produces a fluent sentence
    // about an evening that did not happen and nothing marks it as a fusion;
    // a cautious split produces a thin answer that is visibly thin.
    assert.equal(events.overMerged, 0, "a false merge is the error that must not survive");
  });

  test("and beats what was there by more than a factor of four", async () => {
    const events = await runSuite(SCENARIOS, { model: "events" });

    assert.ok(events.cost * 4 < BEFORE.cost, `${String(events.cost)} against ${String(BEFORE.cost)}`);
    assert.ok(events.meanF1 > BEFORE.meanF1);
    assert.ok(events.missed < BEFORE.missed);
  });

  test("the remaining failures are splits, and they are bounded", async () => {
    const events = await runSuite(SCENARIOS, { model: "events" });

    // Ceilings taken from measurement, not chosen. They fail on a regression
    // and get tightened as the remaining splits are closed.
    assert.ok(events.overSplit <= 10, `over-split ${String(events.overSplit)}`);
    assert.ok(events.missed <= 1, `missed ${String(events.missed)}`);
  });

  test("stories alone is still worse, which is why it is being replaced", async () => {
    const stories = await runSuite(SCENARIOS, { model: "stories" });
    const events = await runSuite(SCENARIOS, { model: "events" });

    assert.ok(events.cost < stories.cost);
    assert.ok(events.missed < stories.missed);
  });
});
