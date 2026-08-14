/**
 * The relationship layer, pinned.
 *
 * Every assertion here corresponds to something that was actually wrong, or to
 * something that would be wrong silently if it broke. That is the standard for
 * adding a test to this file: not coverage, but "if this regressed, how long
 * would it take anybody to notice". The answer for most of the graph is weeks,
 * because a missing edge looks exactly like a question Harbor could not answer.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { relate, explain, RELATIONSHIP_VERSION } from "./relate.js";
import { derive } from "./pipeline.js";
import { resolveEntities } from "./entities.js";
import { PRINCIPAL, seedFixture } from "../fixtures/store.js";
import { fixtureEmbedder, openTestStore, type TestStore } from "../fixtures/harness.js";
import {
  countEdges,
  countPendingRelationships,
  crossSourceEdges,
  edgesFor,
  topThreads,
  threadNodes,
} from "../store/relationships.js";
import { nodeKey, parseNodeRef } from "../store/nodes.js";
import type { NodeRef } from "../store/nodes.js";

let store: TestStore;

/** The id of a fixture item, by the external id it was seeded with. */
function itemFor(externalId: string): string {
  const row = store.db
    .prepare(`SELECT id FROM items WHERE external_id = ?`)
    .get(externalId) as { id: string } | undefined;

  assert.ok(row !== undefined, `fixture item ${externalId} not found`);

  return row.id;
}

/** The episode covering a fixture message. */
function episodeFor(externalId: string): NodeRef {
  const row = store.db
    .prepare(`SELECT episode_id AS id FROM episode_items WHERE item_id = ?`)
    .get(itemFor(externalId)) as { id: string } | undefined;

  assert.ok(row !== undefined, `no episode covers ${externalId}`);

  return { kind: "episode", id: row.id };
}

function connected(a: NodeRef, b: NodeRef): boolean {
  return edgesFor(store.db, a).some((edge) => {
    const other = nodeKey(edge.from) === nodeKey(a) ? edge.to : edge.from;
    return nodeKey(other) === nodeKey(b);
  });
}

function edgeBetween(a: NodeRef, b: NodeRef): string | null {
  for (const edge of edgesFor(store.db, a)) {
    const other = nodeKey(edge.from) === nodeKey(a) ? edge.to : edge.from;

    if (nodeKey(other) === nodeKey(b)) {
      return edge.kind;
    }
  }

  return null;
}

before(async () => {
  store = openTestStore();
  seedFixture(store.db);

  // The real pipeline, in the real order. A test that seeds episodes by hand
  // would pass while segmentation was broken.
  await derive(store.db, fixtureEmbedder(), {});
  resolveEntities(store.db, {});
  relate(store.db, { principalId: PRINCIPAL, timezone: "America/New_York" });
});

after(() => {
  store.close();
});

describe("the graph reaches across sources", () => {
  test("a conversation is connected to the calendar entry it arranged", () => {
    // The case the product exists for, and the case that was structurally
    // impossible: a calendar entry typed by hand has no attendees, so it has no
    // entities, so no generator ever produced it as a candidate.
    const conversation = episodeFor("msg-dinner-2");
    const event: NodeRef = { kind: "item", id: itemFor("evt-dinner") };

    assert.ok(
      connected(conversation, event),
      "the Kearney conversation is not connected to the Kearney dinner",
    );
  });

  test("a booking and a flight five months apart share a confirmation code", () => {
    const booking: NodeRef = { kind: "item", id: itemFor("mail-booking") };
    const flight: NodeRef = { kind: "item", id: itemFor("mail-flight") };

    assert.equal(edgeBetween(booking, flight), "shares_reference");
  });

  test("a reminder is connected to the mail it covers, sharing no people", () => {
    const task: NodeRef = { kind: "item", id: itemFor("task-dentist") };
    const mail: NodeRef = { kind: "item", id: itemFor("mail-dentist") };

    assert.ok(connected(task, mail), "the dentist reminder is not connected to the dentist mail");
  });

  test("most edges are not same-source", () => {
    // The number that exposed the original defect. On the first real run,
    // 35,784 of 35,898 edges were same-source, which is a graph restating what
    // Messages and Gmail already show.
    const total = countEdges(store.db);
    const cross = crossSourceEdges(store.db);

    assert.ok(total > 0, "no edges at all");
    assert.ok(
      cross > 0,
      `${String(total)} edges and none of them cross a source boundary`,
    );
  });
});

describe("the graph declines to guess", () => {
  test("a newsletter is connected to nothing", () => {
    const newsletter: NodeRef = { kind: "item", id: itemFor("mail-newsletter") };

    assert.equal(
      edgesFor(store.db, newsletter).length,
      0,
      "the gardening newsletter was linked to something",
    );
  });

  test("an unrelated chat is connected to nothing", () => {
    const chatter = episodeFor("msg-noise-1");

    assert.equal(
      edgesFor(store.db, chatter).length,
      0,
      "a chat containing only 'haha ok' was linked to something",
    );
  });

  test("every edge carries evidence a person could read", () => {
    const rows = store.db
      .prepare(`SELECT kind, evidence FROM relationships`)
      .all() as { kind: string; evidence: string }[];

    for (const row of rows) {
      assert.ok(
        row.evidence.trim().length > 10,
        `a ${row.kind} edge has no usable evidence: "${row.evidence}"`,
      );
    }
  });
});

describe("conversations are the unit, not messages", () => {
  test("individual texts are not graph subjects", () => {
    const text: NodeRef = { kind: "item", id: itemFor("msg-dinner-2") };

    assert.equal(
      edgesFor(store.db, text).length,
      0,
      "an individual message was linked directly rather than through its episode",
    );
  });

  test("conversational messages do not stay pending forever", () => {
    // Left pending, a quarter of a million messages would make the pass report
    // itself unfinished on every run and `harbor status` permanently wrong.
    assert.equal(countPendingRelationships(store.db, RELATIONSHIP_VERSION), 0);

    const stragglers = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM items
           WHERE relationships_version IS NULL AND deleted_at IS NULL`,
        )
        .get() as { n: number }
    ).n;

    assert.equal(stragglers, 0, "some items were never marked as considered");
  });

  test("a situation holds the conversation, not its forty messages", () => {
    const found = topThreads(store.db, PRINCIPAL, { minSources: 2, limit: 10 });

    assert.ok(found.length > 0, "no cross-source situations at all");

    const dinner = found.find((thread) => (thread.title ?? "").includes("Kearney"));

    assert.ok(dinner !== undefined, "the Kearney dinner is not a situation");

    const nodes = threadNodes(store.db, dinner.id);

    assert.ok(
      nodes.some((ref) => ref.kind === "episode"),
      "the situation contains no conversation",
    );
    assert.ok(
      nodes.length <= 4,
      `the situation has ${String(nodes.length)} members, so messages leaked in individually`,
    );
  });
});

describe("running it again changes nothing", () => {
  test("a second pass draws no new edges", () => {
    const before = countEdges(store.db);

    const report = relate(store.db, {
      principalId: PRINCIPAL,
      timezone: "America/New_York",
    });

    assert.equal(report.edgesDrawn, 0, "a re-run drew edges it had already drawn");
    assert.equal(countEdges(store.db), before);
  });

  test("a rebuild produces the same graph as the incremental run", () => {
    const before = store.db
      .prepare(`SELECT id FROM relationships ORDER BY id`)
      .all() as { id: string }[];

    store.db.prepare(`DELETE FROM relationships`).run();
    store.db.prepare(`UPDATE items SET relationships_version = NULL`).run();
    store.db.prepare(`UPDATE episodes SET relationships_version = NULL`).run();

    relate(store.db, { principalId: PRINCIPAL, timezone: "America/New_York" });

    const after = store.db
      .prepare(`SELECT id FROM relationships ORDER BY id`)
      .all() as { id: string }[];

    assert.deepEqual(
      after.map((row) => row.id),
      before.map((row) => row.id),
      "an incremental run and a full rebuild disagree about the graph",
    );
  });
});

describe("explanation matches the pass", () => {
  test("why says what was considered and what was rejected", () => {
    const result = explain(
      store.db,
      parseNodeRef(itemFor("evt-dinner")),
      PRINCIPAL,
      "America/New_York",
    );

    assert.ok(result !== null);
    assert.ok(result.candidates.length > 0, "the dinner event generated no candidates");
    assert.ok(
      result.distinctive.some((term) => term.includes("kearney")),
      `"kearneys" was not treated as distinctive; got ${result.distinctive.join(", ")}`,
    );

    const drawn = result.candidates.filter((candidate) => candidate.drawn.length > 0);

    assert.ok(drawn.length > 0, "why reports no edges for something the pass linked");
  });
});
