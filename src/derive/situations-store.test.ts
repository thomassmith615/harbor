/**
 * Situation identity, against the real pipeline and a real store.
 *
 * The matcher has its own unit tests. This file exists because the bug being
 * fixed was never visible in a unit: it lived in the seam between the relate
 * pass, the threads table, and the detectors that key off a situation id, and
 * every individual run of every individual piece looked correct.
 *
 * So these run the actual pipeline, twice, and assert on what survived.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { relate } from "./relate.js";
import { derive } from "./pipeline.js";
import { resolveEntities } from "./entities.js";
import { PRINCIPAL, seedFixture } from "../fixtures/store.js";
import { fixtureEmbedder, openTestStore, type TestStore } from "../fixtures/harness.js";
import {
  getThread,
  renameThread,
  setThreadState,
  threadNodes,
  topThreads,
} from "../store/relationships.js";

let store: TestStore;

function rerun(): void {
  relate(store.db, { principalId: PRINCIPAL, timezone: "America/New_York" });
}

before(async () => {
  store = openTestStore();
  seedFixture(store.db);

  await derive(store.db, fixtureEmbedder(), {});
  resolveEntities(store.db, {});
  rerun();
});

after(() => {
  store.close();
});

describe("a situation is a thing, not a fingerprint", () => {
  test("the fixture store produces situations at all", () => {
    // Guards the rest of the file. Every assertion below is vacuously true on
    // an empty table, which is exactly how a test suite goes green while the
    // feature is gone.
    assert.ok(topThreads(store.db, PRINCIPAL, { minSources: 2 }).length > 0);
  });

  test("ids survive a rebuild that changes nothing", () => {
    const before_ = topThreads(store.db, PRINCIPAL, { minSources: 2 }).map((t) => t.id);

    rerun();

    const after_ = topThreads(store.db, PRINCIPAL, { minSources: 2 }).map((t) => t.id);

    assert.deepEqual(after_, before_);
  });

  test("a no-op rebuild does not claim the membership changed", () => {
    const first = topThreads(store.db, PRINCIPAL, { minSources: 2 })[0];

    assert.ok(first !== undefined);

    const changedAt = first.lastChangedAt;

    rerun();

    const again = getThread(store.db, first.id);

    assert.equal(again?.lastChangedAt, changedAt);
  });

  test("first seen is preserved across rebuilds, and is not just updated_at", () => {
    const first = topThreads(store.db, PRINCIPAL, { minSources: 2 })[0];

    assert.ok(first !== undefined);
    assert.ok(first.firstSeenAt !== null);

    const seen = first.firstSeenAt;

    rerun();

    assert.equal(getThread(store.db, first.id)?.firstSeenAt, seen);
  });

  test("a rename is the person's and no pass overwrites it", () => {
    const first = topThreads(store.db, PRINCIPAL, { minSources: 2 })[0];

    assert.ok(first !== undefined);
    assert.ok(renameThread(store.db, first.id, "Crabbing weekend"));

    rerun();

    const after_ = getThread(store.db, first.id);

    assert.equal(after_?.title, "Crabbing weekend");
    assert.equal(after_?.titleSource, "user");
  });

  test("a dismissal survives a rebuild and stops the situation being listed", () => {
    // The whole milestone in one assertion. Before this change the situation
    // came back with a different id on the next pass, so the dismissal applied
    // to a row that no longer existed and Harbor raised it again.
    const open = topThreads(store.db, PRINCIPAL, { minSources: 2 });
    const target = open[0];

    assert.ok(target !== undefined);
    assert.ok(setThreadState(store.db, target.id, "dismissed"));

    rerun();

    const stillThere = getThread(store.db, target.id);

    assert.equal(stillThere?.state, "dismissed", "the dismissal did not survive the rebuild");

    const listed = topThreads(store.db, PRINCIPAL, { minSources: 2 }).map((t) => t.id);

    assert.ok(!listed.includes(target.id), "a dismissed situation is still being listed");
  });

  test("a dismissed situation keeps its members and can be reopened", () => {
    const dismissed = topThreads(store.db, PRINCIPAL, {
      minSources: 2,
      states: ["dismissed"],
    })[0];

    assert.ok(dismissed !== undefined);
    assert.ok(threadNodes(store.db, dismissed.id).length > 0);

    assert.ok(setThreadState(store.db, dismissed.id, "open"));
    rerun();

    assert.equal(getThread(store.db, dismissed.id)?.state, "open");
  });

  test("a situation that grows keeps its id", () => {
    const target = topThreads(store.db, PRINCIPAL, { minSources: 2 })[0];

    assert.ok(target !== undefined);

    const before_ = threadNodes(store.db, target.id).length;

    // Withdraw the weakest edge in the store and put it back. The component
    // membership genuinely moves and returns, which is the shape of a real
    // growth event without needing to seed new source data.
    const weakest = store.db
      .prepare(`SELECT id, confidence FROM relationships ORDER BY confidence ASC LIMIT 1`)
      .get() as { id: string; confidence: number } | undefined;

    assert.ok(weakest !== undefined);

    store.db.prepare(`UPDATE relationships SET confidence = 0.01 WHERE id = ?`).run(weakest.id);
    rerun();

    store.db
      .prepare(`UPDATE relationships SET confidence = ? WHERE id = ?`)
      .run(weakest.confidence, weakest.id);
    rerun();

    const after_ = getThread(store.db, target.id);

    assert.ok(after_ !== null, "the situation did not survive an edge changing and returning");
    assert.equal(threadNodes(store.db, target.id).length, before_);
  });
});
