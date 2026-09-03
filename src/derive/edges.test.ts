/**
 * Edges between things that share no words.
 *
 * The graph was empty and it was not a threshold problem. Every linker judged
 * on a shared distinctive word, a shared person, or a shared identifier, and
 * candidate generation used the same three plus thread adjacency. So the whole
 * apparatus was a string matcher with a date filter, and two nodes about one
 * evening in different vocabulary were rejected correctly by every rule
 * available: "the bar" and "Great American Pub" share no token, and both `bar`
 * and `pub` are three letters, below the term index floor, so neither could be
 * a token even if they had matched.
 *
 * What is pinned here is the alternative. Give the store more kinds of thing
 * that can be identical -- a place id, a stated hour -- and the same conservative
 * rules start firing, with evidence lines a person can check.
 *
 * The rejections matter more than the acceptances and most of these assertions
 * are on that side. Any rule loose enough to connect a group chat to a
 * reservation is loose enough to connect it to a newsletter, and the difference
 * between the two is the whole design.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { derive } from "./pipeline.js";
import { resolveEntities } from "./entities.js";
import { anchorNodes, buildStories } from "./stories.js";
import { relate } from "./relate.js";
import { seedBarFixture, seedBarReactions } from "../fixtures/bar-night.js";
import { fixtureEmbedder, openTestStore, type TestStore } from "../fixtures/harness.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import { recordFeedback } from "../surfaces/feedback.js";
import { runEval } from "../surfaces/evaluate.js";

const TZ = "America/New_York";

let store: TestStore;

interface EdgeRow {
  readonly kind: string;
  readonly evidence: string;
  readonly from_kind: string;
  readonly from_id: string;
  readonly to_kind: string;
  readonly to_id: string;
}

function edges(): readonly EdgeRow[] {
  return store.db
    .prepare(`SELECT kind, evidence, from_kind, from_id, to_kind, to_id FROM relationships`)
    .all() as EdgeRow[];
}

function itemFor(externalId: string): string {
  const row = store.db
    .prepare(`SELECT id FROM items WHERE external_id = ?`)
    .get(externalId) as { id: string } | undefined;

  assert.ok(row !== undefined, externalId);

  return row.id;
}

before(async () => {
  store = openTestStore();

  const fixture = seedBarFixture(store.db);
  seedBarReactions(store.db, fixture.streams["imessage"] ?? "");

  await derive(store.db, fixtureEmbedder(), { timezone: TZ });
  resolveEntities(store.db, {});
  anchorNodes(store.db, { timezone: TZ });

  // No explicit resolvePlaces call. `buildStories` does it, because a venue
  // resolved to a place lives in an anchor and `--rebuild` clears anchors: a
  // sequence that resolved separately would be undone by any later rebuild,
  // and the only symptom would be fewer edges.

  // Stories before relate, deliberately. The plan layer resolves "the bar" to a
  // venue by matching a time, and writes that conclusion back as an anchor; the
  // graph is what consumes it. Running relate first would measure the store as
  // it was before the story layer had learned anything.
  buildStories(store.db, { principalId: DEFAULT_PRINCIPAL, timezone: TZ });
  relate(store.db, { principalId: DEFAULT_PRINCIPAL, timezone: TZ });
});

after(() => {
  store.close();
});

describe("edges the old graph could not draw", () => {
  test("the group chat and the reservation are connected", () => {
    const drawn = edges();

    assert.ok(drawn.length > 0, "the whole scenario used to produce zero edges");

    const joined = drawn.filter(
      (edge) => edge.from_kind === "episode" && edge.to_id === itemFor("bar-mail-1"),
    );

    assert.ok(joined.length > 0, "a conversation and a confirmation sharing no word");
  });

  test("one edge is justified by the place, in the venue's own name", () => {
    const place = edges().find((edge) => /both about Great American Pub/.test(edge.evidence));

    assert.ok(place !== undefined, `no place edge in ${JSON.stringify(edges().map((e) => e.evidence))}`);
  });

  test("another is justified by one time answering another", () => {
    const clock = edges().find((edge) => /8ish/.test(edge.evidence) && /8:00 PM/.test(edge.evidence));

    assert.ok(clock !== undefined);

    // The sentence has to name the second reason too. A time alone is not
    // enough, because a dozen things state an hour on any given evening.
    assert.match(clock.evidence, /both are about|same people/);
  });

  test("every edge says why in words that name the evidence", () => {
    for (const edge of edges()) {
      assert.ok(edge.evidence.length > 10, edge.kind);
      assert.ok(
        !/similar|related|matches/i.test(edge.evidence),
        `"${edge.evidence}" explains nothing a person could check`,
      );
    }
  });
});

describe("what must still not connect", () => {
  test("the newsletters state hours that evening and join nothing", () => {
    for (const edge of edges()) {
      for (const [kind, id] of [
        [edge.from_kind, edge.from_id],
        [edge.to_kind, edge.to_id],
      ]) {
        if (kind !== "item") {
          continue;
        }

        const row = store.db
          .prepare(`SELECT external_id AS id FROM items WHERE id = ?`)
          .get(id) as { id: string } | undefined;

        assert.ok(
          row === undefined || !row.id.startsWith("bar-noise-"),
          `${row?.id ?? ""} joined the evening`,
        );
      }
    }
  });

  test("the unrelated conversation is not joined to the reservation", () => {
    const ken = store.db
      .prepare(
        `SELECT e.id AS id FROM episodes e
         JOIN episode_items ei ON ei.episode_id = e.id
         JOIN items i ON i.id = ei.item_id
         WHERE i.external_id = 'unrelated-msg-0' LIMIT 1`,
      )
      .get() as { id: string } | undefined;

    assert.ok(ken !== undefined);

    const joined = edges().filter(
      (edge) =>
        (edge.from_id === ken.id && edge.to_id === itemFor("bar-mail-1")) ||
        (edge.to_id === ken.id && edge.from_id === itemFor("bar-mail-1")),
    );

    assert.equal(joined.length, 0, "a rendering bug is not a night out");
  });

  test("a common noun never becomes a place two nodes share", () => {
    // If "the bar" had been allowed to become an entity, every conversation in
    // the store mentioning a bar would now be one situation.
    const bars = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM entities
         WHERE kind = 'place' AND LOWER(display_name) IN ('the bar', 'bar', 'the office')`,
      )
      .get() as { n: number };

    assert.equal(bars.n, 0);
  });
});

describe("replaying a verdict", () => {
  test("an approved case that still retrieves everything holds", () => {
    recordFeedback(store.db, {
      principalId: DEFAULT_PRINCIPAL,
      verdict: "up",
      trace: {
        at: Date.now(),
        question: "what am I doing tonight",
        surface: "test",
        tier: null,
        model: null,
        tools: ["search"],
        candidates: [
          { ref: "item:a", title: null, score: 1, admitted: true, because: ["shown"] },
          { ref: "item:b", title: null, score: 1, admitted: true, because: ["shown"] },
        ],
        answer: "an evening at a pub",
      },
    });

    const report = runEval(store.db, DEFAULT_PRINCIPAL, () => ["item:a", "item:b"]);

    assert.equal(report.held, 1);
    assert.equal(report.regressed, 0);
  });

  test("an approved case that lost something is a regression", () => {
    const report = runEval(store.db, DEFAULT_PRINCIPAL, () => ["item:a"]);

    assert.equal(report.regressed, 1);
    assert.deepEqual(report.cases[0]?.lost, ["item:b"]);
  });

  test("a rejected case is never reported as fixed", () => {
    recordFeedback(store.db, {
      principalId: DEFAULT_PRINCIPAL,
      verdict: "down",
      note: "wrong evening",
      trace: {
        at: Date.now(),
        question: "who is coming",
        surface: "test",
        tier: null,
        model: null,
        tools: [],
        candidates: [{ ref: "item:c", title: null, score: 1, admitted: true, because: ["shown"] }],
        answer: "nobody",
      },
    });

    // Retrieval has changed completely, and that is still not evidence the
    // answer is now right. A thumbs-down says the answer was bad without
    // saying why, and the cause is as often the sentence as the retrieval.
    const report = runEval(store.db, DEFAULT_PRINCIPAL, (question) =>
      question === "who is coming" ? ["item:z"] : ["item:a", "item:b"],
    );

    const rejected = report.cases.find((entry) => entry.verdict === "down");

    assert.ok(rejected !== undefined);
    assert.equal(rejected.outcome, "changed");
    assert.notEqual(rejected.outcome as string, "held");
  });
});
