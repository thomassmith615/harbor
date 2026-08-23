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
import { contentTerms, soloCeilingFor } from "./terms.js";
import { derive } from "./pipeline.js";
import { resolveEntities } from "./entities.js";
import { PRINCIPAL, seedFixture } from "../fixtures/store.js";
import { upsertItem } from "../store/items.js";
import { fixtureEmbedder, openTestStore, type TestStore } from "../fixtures/harness.js";
import {
  countEdges,
  countPendingRelationships,
  crossSourceEdges,
  edgesFor,
  topThreads,
  threadNodes,
  getThread,
  renameThread,
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
      "the Brennan conversation is not connected to the Brennan dinner",
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

describe("the failures from the first real run", () => {
  test("a distinctive word carries an edge on its own", () => {
    // "Wildwood" appeared in 19 things out of 40,000 and was rejected, because
    // the solo-word bar was hardcoded at 3 while the corpus ceiling scaled to
    // 500. Anything between 4 and 500 needed a partner word it did not have.
    const conversation = episodeFor("msg-shore-1");
    const event: NodeRef = { kind: "item", id: itemFor("evt-shore") };

    assert.ok(
      connected(conversation, event),
      "the Wildwood conversation is not connected to the Wildwood calendar entry",
    );
  });

  test("a contact card is not a situation", () => {
    // A card carries a timestamp and nothing that happened, so "a contact card
    // from March and a payment three days later" read as a two-source
    // discovery.
    const card: NodeRef = { kind: "item", id: itemFor("card-devin") };

    assert.equal(
      edgesFor(store.db, card).length,
      0,
      "a contact card was linked into the graph",
    );

    for (const thread of topThreads(store.db, PRINCIPAL, { minSources: 2, limit: 50 })) {
      for (const ref of threadNodes(store.db, thread.id)) {
        const kind = store.db
          .prepare(`SELECT kind FROM items WHERE id = ?`)
          .pluck()
          .get(ref.id) as string | undefined;

        assert.notEqual(kind, "contact", `situation "${thread.title ?? ""}" contains a contact card`);
      }
    }
  });

  test("recurring notifications do not chain into a situation", () => {
    // The top-ranked situation on the first real run was twenty Venmo receipts
    // for one weekly transaction. Every statement in it was true.
    const first: NodeRef = { kind: "item", id: itemFor("mail-venmo-0") };
    const second: NodeRef = { kind: "item", id: itemFor("mail-venmo-3") };

    assert.equal(
      connected(first, second),
      false,
      "two instances of the same notification template were linked",
    );

    // And they share "wildwood" with the real shore conversation, so this also
    // pins that a template cannot be dragged into someone else's situation.
    const conversation = episodeFor("msg-shore-1");

    assert.equal(
      connected(conversation, first),
      false,
      "a payment notification was linked into the shore conversation",
    );
  });

  test("every situation has something that actually happened in it", () => {
    const spine = ["event", "task", "conversation"];

    for (const thread of topThreads(store.db, PRINCIPAL, { minSources: 2, limit: 50 })) {
      const kinds = threadNodes(store.db, thread.id).map((ref) =>
        ref.kind === "episode"
          ? "conversation"
          : ((store.db.prepare(`SELECT kind FROM items WHERE id = ?`).pluck().get(ref.id) ??
              "") as string),
      );

      assert.ok(
        kinds.some((kind) => spine.includes(kind)),
        `situation "${thread.title ?? ""}" is only mail: ${kinds.join(", ")}`,
      );
    }
  });

  test("the solo-word bar scales with the store", () => {
    // The bug in one line: this used to be a constant 3 while the rarity
    // ceiling scaled to 500. On a 40,000-item store that meant a word
    // appearing 19 times needed a partner word, and "wildwood" got rejected.
    assert.equal(soloCeilingFor(5), 3, "a tiny store should still have a floor of 3");
    assert.equal(soloCeilingFor(120), 20, "a large store should let a rarer word stand alone");
    assert.ok(soloCeilingFor(60) > 3, "the bar never went back to being a constant");
  });

  test("one-way mail is not linked by a shared word", () => {
    // Two recruiter blasts with different subjects, so template detection
    // cannot see them, sharing "devops" and "marlborough". On the real run this
    // class of mail produced 91% of every edge in the store.
    const first: NodeRef = { kind: "item", id: itemFor("mail-recruiter-1") };
    const second: NodeRef = { kind: "item", id: itemFor("mail-recruiter-2") };

    assert.equal(
      connected(first, second),
      false,
      "two recruiter emails were linked because they use the same industry words",
    );

    // And it does not get dragged into a real conversation either.
    const chat = episodeFor("msg-recruiter-chat");

    assert.equal(
      connected(chat, first),
      false,
      "a recruiter blast was linked into a conversation about it",
    );
  });

  test("one-way mail can still be linked by a reference or a reminder", () => {
    // The exclusion is narrow on purpose. A booking confirmation is one-way
    // mail and its confirmation code is real evidence; a dentist appointment
    // notice is one-way mail and the reminder covering it is exactly the
    // cross-source connection Harbor exists for.
    const booking: NodeRef = { kind: "item", id: itemFor("mail-booking") };
    const flight: NodeRef = { kind: "item", id: itemFor("mail-flight") };
    const task: NodeRef = { kind: "item", id: itemFor("task-dentist") };
    const dentist: NodeRef = { kind: "item", id: itemFor("mail-dentist") };

    assert.equal(edgeBetween(booking, flight), "shares_reference");
    assert.ok(connected(task, dentist), "a reminder lost its connection to the mail it covers");
  });

  test("mail that arrived once and was never replied to is still one-way", () => {
    // The volume floor let this through: a sweepstakes blast from a fresh
    // address arrives once, so it never reached the three-message threshold,
    // and it shares "wildwood" with a real conversation.
    const spam: NodeRef = { kind: "item", id: itemFor("mail-sweepstakes") };

    assert.equal(
      edgesFor(store.db, spam).length,
      0,
      "a one-off sweepstakes email was linked into the graph",
    );
  });

  test("a recurring reminder counts once, not once per occurrence", () => {
    // Four instances of "rehearsal speech write ~5min" made a seventeen-thing
    // situation that was really about six things.
    const later: NodeRef = { kind: "item", id: itemFor("task-speech-2") };

    assert.equal(
      edgesFor(store.db, later).length,
      0,
      "a repeat occurrence of a recurring reminder became its own node",
    );
  });

  test("one shared word two months apart is coincidence", () => {
    // `tracks` refused this pair on the gap and `about_same` drew it anyway,
    // because it had no notion of time at all.
    const task: NodeRef = { kind: "item", id: itemFor("task-gauge") };
    const chat = episodeFor("msg-gauge");

    assert.equal(
      connected(task, chat),
      false,
      "a single word shared across two months was treated as evidence",
    );
  });

  test("a hostname is not a distinctive word", () => {
    // "amazonaws" was among the rarest-looking words in the store, because it
    // is in the tracking pixel at the bottom of thousands of marketing emails.
    const terms = contentTerms(
      "Your statement is ready. https://tracking.us-east-1.amazonaws.com/x?id=9 " +
        "Visit example.com for details about the Brennans.",
    );

    assert.ok(!terms.includes("amazonaws"), `link host leaked into terms: ${terms.join(", ")}`);
    assert.ok(!terms.includes("example"), `link host leaked into terms: ${terms.join(", ")}`);
    assert.ok(terms.includes("brennans"), "stripping links also removed real words");
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

    const dinner = found.find((thread) => (thread.title ?? "").includes("Brennan"));

    assert.ok(dinner !== undefined, "the Brennan dinner is not a situation");

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

  test("new items after a full pass still draw edges", async () => {
    // The gap in the two tests above, and the one that matters most.
    //
    // "A re-run draws nothing" and "a rebuild matches the incremental run" are
    // both satisfied by a pass that has stopped drawing edges entirely. A
    // frozen graph is indistinguishable from a correct one by every assertion
    // in this file until something new arrives, and what arrives in real use is
    // a source connected months after the rest.
    //
    // The symptom is `0 connections drawn` on every run forever, which reads as
    // "nothing new was related" and is exactly what a correct pass says on a
    // quiet day. Weeks could pass before anybody looked.
    const streamId = store.db
      .prepare(`SELECT id FROM streams WHERE connector_id = 'apple-calendar'`)
      .get() as { id: string };

    const mailStream = store.db
      .prepare(`SELECT id FROM streams WHERE connector_id = 'imap'`)
      .get() as { id: string };

    const accountOf = (id: string): string =>
      (store.db.prepare(`SELECT account_id AS a FROM streams WHERE id = ?`).get(id) as {
        a: string;
      }).a;

    const when = Date.UTC(2026, 8, 2, 15, 0, 0);

    // A confirmation code shared between a new mail and a new calendar entry:
    // two sources, no people in common, which is the pairing the reference
    // linker exists for.
    upsertItem(store.db, {
      accountId: accountOf(mailStream.id),
      streamId: mailStream.id,
      externalId: "late-mail-1",
      kind: "email",
      direction: "inbound",
      threadId: null,
      title: "Your booking QKZT-4417 is confirmed",
      body: "Reference QKZT-4417. Doors at seven.",
      author: "tickets@venue.example",
      participants: [],
      occurredAt: when,
      endsAt: null,
      state: null,
      raw: { fixture: "late-mail-1" },
    });

    upsertItem(store.db, {
      accountId: accountOf(streamId.id),
      streamId: streamId.id,
      externalId: "late-event-1",
      kind: "event",
      threadId: null,
      title: "Venue, ref QKZT-4417",
      body: "QKZT-4417",
      author: null,
      participants: [],
      occurredAt: Date.UTC(2026, 8, 14, 23, 0, 0),
      endsAt: Date.UTC(2026, 8, 15, 1, 0, 0),
      state: null,
      raw: { fixture: "late-event-1" },
    });

    await derive(store.db, fixtureEmbedder(), {});
    resolveEntities(store.db, {});

    assert.ok(
      countPendingRelationships(store.db, RELATIONSHIP_VERSION) > 0,
      "new items were not queued for relating, so the graph can never grow",
    );

    const report = relate(store.db, {
      principalId: PRINCIPAL,
      timezone: "America/New_York",
    });

    assert.ok(
      report.edgesDrawn > 0,
      "a pass over new cross-source items drew nothing, which is a frozen graph",
    );

    assert.ok(
      connected({ kind: "item", id: itemFor("late-mail-1") }, {
        kind: "item",
        id: itemFor("late-event-1"),
      }),
      "a shared confirmation code across two sources did not connect them",
    );

    assert.equal(
      countPendingRelationships(store.db, RELATIONSHIP_VERSION),
      0,
      "the queue did not drain, so these items are relinked on every pass forever",
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
      result.distinctive.some((term) => term.includes("brennan")),
      `"brennans" was not treated as distinctive; got ${result.distinctive.join(", ")}`,
    );

    const drawn = result.candidates.filter((candidate) => candidate.drawn.length > 0);

    assert.ok(drawn.length > 0, "why reports no edges for something the pass linked");
  });
});

describe("a title the person gave, and taking it back", () => {
  test("a rename sticks and an empty one hands it back", () => {
    // Both directions, because only one of them existed. A user title is exempt
    // from renaming and from retirement, so a rename made while testing pinned
    // a real situation open under a meaningless name with no way to undo it.
    const thread = topThreads(store.db, PRINCIPAL, { limit: 1, minSources: 2 })[0];

    assert.ok(thread !== undefined, "no situation to rename");

    assert.ok(renameThread(store.db, thread.id, "Test rename"));

    const renamed = getThread(store.db, thread.id);
    assert.equal(renamed?.title, "Test rename");
    assert.equal(renamed?.titleSource, "user");

    assert.ok(renameThread(store.db, thread.id, ""));

    const returned = getThread(store.db, thread.id);
    assert.equal(returned?.titleSource, "derived", "an empty title did not hand it back");
    assert.equal(returned?.summary, null, "a summary of the old name survived");

    // Whitespace is an empty title, not a name made of spaces.
    assert.ok(renameThread(store.db, thread.id, "Real name"));
    assert.ok(renameThread(store.db, thread.id, "   "));
    assert.equal(getThread(store.db, thread.id)?.titleSource, "derived");
  });
});
