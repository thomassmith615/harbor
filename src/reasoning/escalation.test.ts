/**
 * Escalation as an outcome rather than a prediction.
 *
 * A task class declares the cheapest tier that *might* work. For structured
 * extraction that is a 3B local model, and on a real mailbox it failed 26 of 50
 * items: hallucinated totals that did not appear in the email, and English
 * prose where JSON was required. Every one of those was correctly rejected by
 * verification and then silently dropped, so half the receipts never arrived.
 *
 * Guessing difficulty up front is hard. Noticing that the cheap answer did not
 * survive verification is trivial, and by then the evidence is in hand. So the
 * caller raises the floor for one retry and the expensive model is spent only
 * on the items that actually needed it.
 *
 * The rule that matters most here is the one that says a floor may only ever be
 * raised. A retry that could lower it would let a task marked local-only reach
 * the cloud, which is a privacy failure wearing the costume of a cost
 * optimisation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chooseTier, nextTierAbove } from "./router.js";
import { TIERS, taskClass } from "./tasks.js";
import { openTestStore } from "../fixtures/harness.js";

test("escalation", async (t) => {
  await t.test("the ladder walks up and stops at the top", () => {
    assert.equal(nextTierAbove("local_small"), "local_large");
    assert.equal(nextTierAbove("local_large"), "cloud_cheap");
    assert.equal(nextTierAbove("cloud_cheap"), "cloud_premium");
    assert.equal(nextTierAbove("cloud_premium"), null);
  });

  await t.test("every tier except the last has one above it", () => {
    for (const tier of TIERS.slice(0, -1)) {
      assert.notEqual(nextTierAbove(tier), null, `${tier} should have a tier above it`);
    }
  });

  await t.test("a raised floor is honoured", () => {
    const store = openTestStore();

    try {
      const task = taskClass("extract.structured");

      assert.equal(chooseTier(store.db, task, "cloud_cheap"), "cloud_cheap");
      assert.equal(chooseTier(store.db, task, "cloud_premium"), "cloud_premium");
    } finally {
      store.close();
    }
  });

  await t.test("a floor may be raised but never lowered", () => {
    // The important one. If a caller could lower the floor, a task declared
    // local-only could be pushed to the cloud by a retry, which is a privacy
    // failure dressed up as a cost optimisation.
    const store = openTestStore();

    try {
      for (const id of ["extract.structured", "ask.converse"]) {
        const task = taskClass(id);
        const declared = task.floor ?? "local_small";
        const chosen = chooseTier(store.db, task, "local_small");

        assert.ok(
          TIERS.indexOf(chosen) >= TIERS.indexOf(declared),
          `${id}: asking for local_small dropped below its declared floor ${declared}`,
        );
      }
    } finally {
      store.close();
    }
  });

  await t.test("no floor at all behaves as before", () => {
    const store = openTestStore();

    try {
      const task = taskClass("extract.structured");

      assert.equal(chooseTier(store.db, task), chooseTier(store.db, task, undefined));
    } finally {
      store.close();
    }
  });
});
