/**
 * Every detector runs.
 *
 * The cheapest test in the suite and the one whose absence let a detector sit
 * broken for four milestones. `upcoming_loose_end` queried `thread_items`,
 * which was renamed to `thread_nodes` in migration 023, and nothing noticed:
 * SQL is a string, so typecheck cannot see it, the build cannot see it, and the
 * failure only appears when a person runs the pass and gets `no such table`.
 *
 * It asserts almost nothing about the output on purpose. What it asserts is
 * that every detector can be run at all, which is exactly the property that was
 * silently false.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { DETECTORS } from "./detectors.js";
import { runDetectors, DETECTOR_VERSION, dropStaleObservations } from "./brief.js";
import { openTestStore, type TestStore } from "../fixtures/harness.js";
import { seedFixture, PRINCIPAL } from "../fixtures/store.js";

let store: TestStore;

before(() => {
  store = openTestStore();
  seedFixture(store.db);
});

after(() => {
  store.close();
});

describe("every detector", () => {
  test("runs against a real store without failing", () => {
    for (const detector of DETECTORS) {
      assert.doesNotThrow(() => {
        detector.run(store.db, {
          principalId: PRINCIPAL,
          timezone: "UTC",
          now: Date.now(),
        });
      }, `detector ${detector.id} threw`);
    }
  });

  test("the whole pass runs", () => {
    const report = runDetectors(store.db, { principalId: PRINCIPAL, timezone: "UTC" });

    assert.equal(
      report.results.length,
      DETECTORS.length,
      "a detector was skipped rather than run",
    );
  });

  test("a version bump retracts what older rules queued", () => {
    // The mechanism that lets a corrected detector take back what it said. It
    // exists because a digest kept repeating "before has come up in 20
    // conversations" after the rule that produced it had been fixed.
    store.db
      .prepare(
        `INSERT INTO observations
           (id, principal_id, detector_id, detector_version, dedup_key, title, detail,
            salience, evidence, earliest_useful_at, expires_at, state, created_at)
         VALUES ('o_old', ?, 'recurring_subject', 1, 'k', 'something an old rule said',
                 '', 0.5, '[]', 0, ?, 'pending', 0)`,
      )
      .run(PRINCIPAL, Date.now() + 86_400_000);

    const dropped = dropStaleObservations(store.db, DETECTOR_VERSION);

    assert.ok(dropped >= 1, "an observation from older rules survived");

    const left = store.db
      .prepare(`SELECT COUNT(*) AS n FROM observations WHERE id = 'o_old'`)
      .get() as { n: number };

    assert.equal(left.n, 0);
  });

  test("a dismissal survives a version bump", () => {
    // Someone who said "not worth saying" judged the finding, not the code that
    // found it. Re-asking would be the most annoying possible behaviour.
    store.db
      .prepare(
        `INSERT INTO observations
           (id, principal_id, detector_id, detector_version, dedup_key, title, detail,
            salience, evidence, earliest_useful_at, expires_at, state, created_at)
         VALUES ('o_dismissed', ?, 'recurring_subject', 1, 'k2', 'already dismissed',
                 '', 0.5, '[]', 0, ?, 'dismissed', 0)`,
      )
      .run(PRINCIPAL, Date.now() + 86_400_000);

    dropStaleObservations(store.db, DETECTOR_VERSION);

    const left = store.db
      .prepare(`SELECT COUNT(*) AS n FROM observations WHERE id = 'o_dismissed'`)
      .get() as { n: number };

    assert.equal(left.n, 1, "a dismissal was thrown away by a version bump");
  });
});
