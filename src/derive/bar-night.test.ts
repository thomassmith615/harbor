/**
 * An evening that never reached a calendar.
 *
 * The scenario in `fixtures/bar-night.ts` is the one every part of the story
 * layer was bad at, and it is bad at it for a reason worth stating rather than
 * tuning around: a trip arrives pre-specified from an airline, and a night out
 * arrives as "later", "the bar" and "im in". Nothing there is a place the
 * gazetteer holds, a date `dates.ts` reads, or an identifier anybody quotes.
 *
 * Three groups of assertions.
 *
 * The first pins what the store still cannot do, because those constraints are
 * load-bearing and a future change that quietly relaxes one of them (a term
 * floor of three, say) should have to argue for it here.
 *
 * The second is the plan layer working end to end: a proposal, a roster, a time
 * the conversation never stated being answered by a confirmation that never
 * mentioned the conversation, and a one word reminder attached to it.
 *
 * The third is the forbidden half, and it is the half worth reading. Every
 * mechanism that admits the right conversation would, left alone, admit the
 * wrong one, because both are episodes a couple of hours before the same
 * evening. A rendering bug is not a night out.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { derive } from "./pipeline.js";
import { resolveEntities } from "./entities.js";
import { buildStories } from "./stories.js";
import { detectFrames } from "./frames.js";
import { NoiseIndex } from "./noise.js";
import { TermIndex } from "./terms.js";
import { datesIn } from "./dates.js";
import { looksLikeProposal, readPlans, venuesIn } from "./plans.js";
import { narrowest, resolves, timeHintsIn } from "./timing.js";
import { upcoming } from "./upcoming.js";
import {
  CHAT_AT,
  DAVE,
  NINA,
  RESERVED_AT,
  SAM,
  seedBarFixture,
  seedBarReactions,
} from "../fixtures/bar-night.js";
import { fixtureEmbedder, openTestStore, type TestStore } from "../fixtures/harness.js";
import { anchorsFor } from "../store/anchors.js";
import { storyMembers, topStories } from "../store/stories.js";
import { nodeKey } from "../store/nodes.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { Story } from "../store/stories.js";

const TZ = "America/New_York";
const MINUTE = 60_000;

let store: TestStore;

function itemFor(externalId: string): string {
  const row = store.db
    .prepare(`SELECT id FROM items WHERE external_id = ?`)
    .get(externalId) as { id: string } | undefined;

  assert.ok(row !== undefined, `fixture item ${externalId} not found`);

  return row.id;
}

function episodeFor(externalId: string): string {
  const row = store.db
    .prepare(`SELECT episode_id AS id FROM episode_items WHERE item_id = ?`)
    .get(itemFor(externalId)) as { id: string } | undefined;

  assert.ok(row !== undefined, `no episode covers ${externalId}`);

  return row.id;
}

function transcriptOf(episodeId: string): string {
  const row = store.db
    .prepare(`SELECT transcript FROM episodes WHERE id = ?`)
    .get(episodeId) as { transcript: string } | undefined;

  assert.ok(row !== undefined);

  return row.transcript;
}

function thePlan(): Story {
  const stories = topStories(store.db, DEFAULT_PRINCIPAL, { limit: 20, kind: "plan" });

  assert.equal(stories.length, 1, "exactly one plan was assembled");

  const plan = stories[0];

  assert.ok(plan !== undefined);

  return plan;
}

function memberKeys(storyId: string): ReadonlySet<string> {
  return new Set(storyMembers(store.db, storyId).map((member) => nodeKey(member.ref)));
}

before(async () => {
  store = openTestStore();
  const fixture = seedBarFixture(store.db);
  seedBarReactions(store.db, fixture.streams["imessage"] ?? "");

  await derive(store.db, fixtureEmbedder(), {});
  resolveEntities(store.db, {});

  buildStories(store.db, { principalId: DEFAULT_PRINCIPAL, timezone: TZ });
});

after(() => {
  store.close();
});

describe("what the evening does not give you", () => {
  test("there is no calendar entry anywhere in it", () => {
    const events = (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM items WHERE kind = 'event' AND deleted_at IS NULL`)
        .get() as { n: number }
    ).n;

    assert.equal(events, 0, "the whole point: nothing wrote this down");
  });

  test("bar and pub are both under the term floor, so neither can be an anchor", () => {
    const terms = new TermIndex(store.db);

    assert.ok(!terms.distinctive("who's going to the bar later").includes("bar"));
    assert.ok(!terms.distinctive("Great American Pub").includes("pub"));
  });

  test("nothing in the conversation states a date", () => {
    assert.equal(datesIn("who's going to the bar later", CHAT_AT).length, 0);
    assert.equal(datesIn("8ish?", CHAT_AT).length, 0);
  });

  test("the reminder is one word, so nothing can match it on content", () => {
    const anchors = anchorsFor(store.db, { kind: "item", id: itemFor("bar-task-1") });

    assert.deepEqual(
      anchors.filter((anchor) => anchor.kind === "topic").map((anchor) => anchor.value),
      ["wallet"],
    );
  });

  test("the graph still draws no edge between any two of the four pieces", () => {
    // Unchanged, and left here deliberately. The plan layer does not work by
    // finding a similarity the linkers missed. There is no similarity here to
    // find; it works by asking a different question.
    const edges = (
      store.db.prepare(`SELECT COUNT(*) AS n FROM relationships`).get() as { n: number }
    ).n;

    assert.equal(edges, 0);
  });
});

describe("reading a plan out of a conversation", () => {
  test("a proposal is recognised and an aside is not", () => {
    assert.ok(looksLikeProposal("who's going to the bar later"));
    assert.ok(!looksLikeProposal("anyone seen my charger btw"));
    assert.ok(!looksLikeProposal("the game is on at 9 too"));
  });

  test("the roster is who agreed, not who was in the thread", () => {
    const plans = readPlans(transcriptOf(episodeFor("bar-msg-0")), CHAT_AT, TZ, "ep");

    assert.equal(plans.length, 1);

    const going = new Set((plans[0]?.stances ?? []).map((stance) => stance.speaker));

    assert.ok(going.has(DAVE), "said im in");
    assert.ok(going.has(SAM), "said same");
    assert.ok(going.has("Me"), "said yeah I'm going");

    // Nina never types an answer. She taps the message, which is how a good
    // share of any real roster replies, and which the connector used to
    // discard before the store existed.
    assert.ok(going.has(NINA), "liked the proposal");

    // And Ken liked a message about a charger, which is not agreeing to
    // anything.
    assert.equal(going.size, 4);
  });

  test("every stance quotes the line it came from", () => {
    const transcript = transcriptOf(episodeFor("bar-msg-0"));

    for (const stance of readPlans(transcript, CHAT_AT, TZ, "ep")[0]?.stances ?? []) {
      assert.ok(transcript.includes(stance.quote), `"${stance.quote}" is not in the transcript`);
    }
  });

  test("a venue is read whether it is a proper name or a common noun", () => {
    assert.ok(venuesIn("who's going to the bar later").includes("the bar"));
    assert.ok(
      venuesIn("Your reservation at Great American Pub is confirmed").includes(
        "Great American Pub",
      ),
    );
  });
});

describe("time as an interval", () => {
  test("later is a window, not an instant", () => {
    const later = narrowest(timeHintsIn("who's going to the bar later", CHAT_AT, TZ));

    assert.ok(later !== null);
    assert.equal(later.kind, "vague");
    assert.ok(later.endsAt - later.startsAt > 4 * 60 * MINUTE, "hours wide");
  });

  test("a stated hour resolves a window, and a second vague one does not", () => {
    const later = narrowest(timeHintsIn("who's going to the bar later", CHAT_AT, TZ));
    const eight = narrowest(timeHintsIn("Thursday, August 27 at 8:00 PM", CHAT_AT, TZ));
    const tonight = narrowest(timeHintsIn("see you tonight", CHAT_AT, TZ));

    assert.ok(later !== null && eight !== null && tonight !== null);

    assert.ok(resolves(later, eight), "8:00 PM answers later");
    assert.ok(!resolves(later, tonight), "tonight answers nothing");
  });

  test("one statement is read once, at its strongest", () => {
    // "at 8:00 PM" matches the meridiem rule and the preposed rule, and the
    // second has no meridiem to go on so it reads eight in the morning. Both
    // stored, and the store holds a time twelve hours from the truth that a
    // plan can then resolve against.
    assert.equal(timeHintsIn("Thursday, August 27 at 8:00 PM", CHAT_AT, TZ).length, 1);
  });
});

describe("the evening, assembled", () => {
  test("a plan frame exists with no calendar entry underneath it", () => {
    const frames = detectFrames(store.db, new NoiseIndex(store.db), { timezone: TZ });

    assert.equal(frames.report.trips, 0);
    assert.equal(frames.report.occasions, 0);
    assert.equal(frames.report.plans, 1);
    assert.equal(frames.report.plansResolved, 1);
  });

  test("the reservation resolves the time the conversation left open", () => {
    const plan = thePlan();

    // Eight o'clock, which nobody in the conversation ever said.
    assert.equal(plan.spanStartsAt, RESERVED_AT);
    assert.ok(memberKeys(plan.id).has(`item:${itemFor("bar-mail-1")}`));
  });

  test("the mail joins despite being mass mail with no shared word", () => {
    const member = storyMembers(store.db, thePlan().id).find(
      (candidate) => candidate.ref.id === itemFor("bar-mail-1"),
    );

    assert.ok(member !== undefined);

    // And says so in a sentence naming both halves of the claim.
    assert.ok(
      member.evidence.some((line) => /8ish/.test(line) && /8:00 PM/.test(line)),
      `evidence should quote both times, got ${JSON.stringify(member.evidence)}`,
    );
  });

  test("the wallet reminder attaches to the resolved time", () => {
    assert.ok(
      memberKeys(thePlan().id).has(`item:${itemFor("bar-task-1")}`),
      "a one word reminder twenty minutes before the table",
    );
  });

  test("it spans three sources and says who and when in one sentence", () => {
    const plan = thePlan();

    assert.equal(plan.sourceCount, 3);
    assert.ok(plan.summary !== null);
    assert.ok(/Dave Mullen/.test(plan.summary ?? ""));
    assert.ok(/Nina Patel/.test(plan.summary ?? ""), "including whoever only tapped");
    assert.ok(/8:00 PM/.test(plan.summary ?? ""));
  });

  test("upcoming shows the evening, not three loose fragments", () => {
    const entries = upcoming(store.db, {
      principalId: DEFAULT_PRINCIPAL,
      now: CHAT_AT,
      days: 7,
    });

    const evening = entries.find((entry) => /Great American Pub/.test(entry.title));

    assert.ok(evening !== undefined, "the evening is on the upcoming surface");
    assert.equal(evening.sourceCount, 3);

    // And the reminder is no longer a separate line with nothing attached.
    assert.ok(!entries.some((entry) => entry.title === "wallet"));
  });
});

describe("what must not join", () => {
  test("a conversation happening nearby with nobody who is going", () => {
    assert.ok(
      !memberKeys(thePlan().id).has(`episode:${episodeFor("unrelated-msg-0")}`),
      "a rendering bug three hours earlier is not a night out",
    );
  });

  test("the aside about the game does not become the time", () => {
    // "the game is on at 9 too" sits four lines from the proposal and is a
    // confident looking clock time to any rule that only counts hours.
    assert.notEqual(thePlan().spanStartsAt, RESERVED_AT + 60 * MINUTE);
  });

  test("a newsletter stating an hour that evening resolves nothing", () => {
    for (const member of storyMembers(store.db, thePlan().id)) {
      const row = store.db
        .prepare(`SELECT external_id AS id FROM items WHERE id = ?`)
        .get(member.ref.id) as { id: string } | undefined;

      assert.ok(
        row === undefined || !row.id.startsWith("bar-noise-"),
        `${row?.id ?? ""} should not be in the evening`,
      );
    }
  });

  test("a plan nobody pinned to a time is not on any surface", () => {
    // Agreement with no hour is a plan Harbor cannot say anything useful
    // about, and saying it anyway is how a surface fills with evenings that
    // may or may not have happened.
    const plans = readPlans(
      "Dave Mullen: we should grab dinner sometime\nSam Ortiz: im in",
      CHAT_AT,
      TZ,
      "ep",
    );

    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.time, null);
  });
});
