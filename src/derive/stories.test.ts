/**
 * The story layer, pinned against the scenario it was built for.
 *
 * The standard for an assertion in this file is the same as everywhere else in
 * Harbor: not coverage, but "if this regressed, how long would it take anybody
 * to notice". For a missing story member the answer is never, because a story
 * that is quietly missing its most important piece of evidence still reads like
 * a complete story.
 *
 * Every forbidden membership here corresponds to something the previous design
 * either did wrongly or could not do at all.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { buildStories, explainStory } from "./stories.js";
import { detectFrames, homePlace } from "./frames.js";
import { anchorsOf, referencesIn } from "./anchors.js";
import { datesIn } from "./dates.js";
import { localityIn, placesIn, routesIn } from "./places.js";
import { presenceAt, presenceTimeline, describePresence } from "./presence.js";
import { NoiseIndex } from "./noise.js";
import { TermIndex } from "./terms.js";
import { derive } from "./pipeline.js";
import { resolveEntities } from "./entities.js";
import { DEPARTS_AT, MAYA, RETURNS_AT, seedTripFixture } from "../fixtures/trip.js";
import { inferredTrips, travelSignals, type TravelSignal } from "./signals.js";
import { fixtureEmbedder, openTestStore, type TestStore } from "../fixtures/harness.js";
import { anchorsFor } from "../store/anchors.js";
import { upsertItem } from "../store/items.js";
import { loadNode, nodeKey, NodeResolver } from "../store/nodes.js";
import { storyMembers, topStories } from "../store/stories.js";
import { setDisplayName } from "../store/entities.js";
import { upcoming } from "./upcoming.js";
import { parseNaming } from "./name-stories.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { NodeRef } from "../store/nodes.js";
import type { Story } from "../store/stories.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

let store: TestStore;

function itemFor(externalId: string): string {
  const row = store.db
    .prepare(`SELECT id FROM items WHERE external_id = ?`)
    .get(externalId) as { id: string } | undefined;

  assert.ok(row !== undefined, `fixture item ${externalId} not found`);

  return row.id;
}

function episodeFor(externalId: string): NodeRef {
  const row = store.db
    .prepare(`SELECT episode_id AS id FROM episode_items WHERE item_id = ?`)
    .get(itemFor(externalId)) as { id: string } | undefined;

  assert.ok(row !== undefined, `no episode covers ${externalId}`);

  return { kind: "episode", id: row.id };
}

function theTrip(): Story {
  const stories = topStories(store.db, DEFAULT_PRINCIPAL, { limit: 20, kind: "trip" });
  const trip = stories.find((story) => story.place === "boston");

  assert.ok(trip !== undefined, "no Boston trip was assembled");

  return trip;
}

function memberKeys(storyId: string): ReadonlySet<string> {
  return new Set(storyMembers(store.db, storyId).map((member) => nodeKey(member.ref)));
}

before(async () => {
  store = openTestStore();
  seedTripFixture(store.db);

  await derive(store.db, fixtureEmbedder(), {});
  resolveEntities(store.db, {});

  buildStories(store.db, {
    principalId: DEFAULT_PRINCIPAL,
    timezone: "America/New_York",
  });
});

after(() => {
  store.close();
});

describe("reading places out of text", () => {
  test("a route states both ends and their direction", () => {
    const routes = routesIn("Flight PHL to BOS");

    assert.equal(routes.length, 1);
    assert.equal(routes[0]?.from.id, "philadelphia");
    assert.equal(routes[0]?.to.id, "boston");
  });

  test("a city name is found however it is written", () => {
    const ids = placesIn("landing at logan around 9am, flight gets in early").map((p) => p.id);

    assert.ok(ids.includes("boston"), "logan with travel context is Boston");
  });

  test("an ambiguous name is not a place without travel context", () => {
    // The exact failure that made the old term index blacklist the word: a
    // person called Logan is not an airport, and frequency cannot tell them
    // apart because both are rare.
    const ids = placesIn("Hi, my name is Logan and I wondered if you were selling").map((p) => p.id);

    assert.ok(!ids.includes("boston"), "a person called Logan is not Boston");
  });

  test("a town in a calendar address is a place, gazetteer or not", () => {
    // The gazetteer is hand-checked, so it knows the places somebody flies to
    // and none of the places they drive to. A calendar entry's location field is
    // the way out: it is curated by whoever wrote the invitation, and the town
    // in it is a real place name whether or not any list contains it.
    const hits = localityIn("Location: 511 Minsi Trl W, Long Pond, PA 18334");

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "long_pond");
    assert.equal(hits[0]?.display, "Long Pond");
  });

  test("a town already known keeps its canonical id", () => {
    // Or an address in Philadelphia would be a different place from every other
    // mention of Philadelphia in the store.
    assert.equal(localityIn("Location: 1600 Market St, Philadelphia, PA 19103")[0]?.id, "philadelphia");
  });

  test("something that is not an address yields nothing", () => {
    assert.equal(localityIn("lets meet at the usual spot, ok?").length, 0);
    assert.equal(localityIn("Location: Zoom").length, 0);
  });

  test("a bare three letter code needs context to count", () => {
    assert.equal(placesIn("please SEE the attached DOC").length, 0);
  });
});

describe("reading dates out of text", () => {
  const written = Date.UTC(2026, 5, 12);

  test("a range written as ordinals keeps both ends", () => {
    const hits = datesIn("probably the 20th through the 24th", written);

    assert.equal(hits.length, 1);
    assert.ok(hits[0] !== undefined);
    assert.ok(hits[0].endsAt > hits[0].startsAt, "a range has width");
    assert.equal(Math.round((hits[0].endsAt - hits[0].startsAt) / DAY), 4);
  });

  test("a named month resolves to the nearest year", () => {
    const hits = datesIn("see you August 20", written);

    assert.equal(new Date(hits[0]?.startsAt ?? 0).getUTCFullYear(), 2026);
    assert.equal(new Date(hits[0]?.startsAt ?? 0).getUTCMonth(), 7);
  });

  test("a date far from when it was written is discarded rather than guessed", () => {
    assert.equal(datesIn("the meeting was 1/3", Date.UTC(2026, 6, 1)).length, 0);
  });
});

describe("reading identifiers", () => {
  test("a flight number needs no keyword in front of it", () => {
    // The bug this replaces: the old pattern required "flight" immediately
    // before the code, so a calendar entry titled "Flight PHL to BOS" with
    // "AA 1783" in the body yielded nothing, and the airline's own
    // confirmation could never be joined to the event it created.
    const found = referencesIn("Flight PHL to BOS\nAA 1783 departs 6:45am");

    assert.ok(
      found.some((reference) => reference.value === "AA1783"),
      "AA 1783 is a flight number even with the route in between",
    );
  });

  test("an English word captured by a pattern is not an identifier", () => {
    const found = referencesIn("Your trip confirmation\nConfirmation details below");

    assert.equal(found.length, 0);
  });
});

describe("the trip is assembled", () => {
  test("a journey out and a journey back are one story, not two", () => {
    const trip = theTrip();

    assert.equal(trip.kind, "trip");
    assert.equal(trip.place, "boston");
    assert.equal(trip.spanStartsAt, DEPARTS_AT);
    assert.ok(
      Math.abs(trip.spanEndsAt - (RETURNS_AT + 2 * HOUR)) < HOUR,
      "the span runs to the return flight landing",
    );
  });

  test("the trip spans more than one source", () => {
    assert.ok(theTrip().sourceCount >= 3, "calendar, mail, messages at least");
  });

  test("the reminder to pack joins on position alone", () => {
    // The headline case. "pack laptop" shares no word with anything in the
    // trip; its entire claim is that it is set for six hours before a
    // departure. The old linker rejected it by arithmetic before judging it.
    const members = memberKeys(theTrip().id);

    assert.ok(
      members.has(nodeKey({ kind: "item", id: itemFor("trip-task-pack") })),
      "pack laptop belongs to the trip",
    );
  });

  test("that reminder is marked as preparation rather than evidence", () => {
    const pack = storyMembers(store.db, theTrip().id).find(
      (member) => member.ref.id === itemFor("trip-task-pack"),
    );

    assert.equal(pack?.role, "preparation");
    assert.ok(
      pack?.evidence.some((line) => line.includes("getting ready")),
      "and says so in a sentence a person can read",
    );
  });

  test("a conversation two months before departure is still part of it", () => {
    // Sixty-two days out. The old content window reached sixty and demoted
    // anything past thirty to coincidence.
    const members = memberKeys(theTrip().id);

    assert.ok(
      members.has(nodeKey(episodeFor("trip-msg-1"))),
      "the conversation that opened the trip belongs to it",
    );
  });

  test("the airline confirmation is not filtered out for being automated", () => {
    // Nobody replies to an airline, so the broadcast rule excluded exactly the
    // documents that carry flight numbers and dates.
    const members = memberKeys(theTrip().id);

    assert.ok(
      members.has(nodeKey({ kind: "item", id: itemFor("trip-mail-air") })),
      "the confirmation belongs to the trip",
    );
  });

  test("the hotel booking joins on place and dates with no shared identifier", () => {
    const members = memberKeys(theTrip().id);

    assert.ok(members.has(nodeKey({ kind: "item", id: itemFor("trip-mail-hotel") })));
  });

  test("an event during the trip joins it", () => {
    const members = memberKeys(theTrip().id);

    assert.ok(members.has(nodeKey({ kind: "item", id: itemFor("trip-evt-fenway") })));
  });

  test("every member carries a readable reason", () => {
    for (const member of storyMembers(store.db, theTrip().id)) {
      assert.ok(member.evidence.length > 0, `${member.ref.id} joined with no stated reason`);

      for (const line of member.evidence) {
        assert.ok(line.length > 8, `evidence too thin to check: ${line}`);
      }
    }
  });
});

describe("what the trip must not swallow", () => {
  test("a stranger who mentions the destination mid-trip stays out", () => {
    // Right place, right week, and nothing to do with the trip. This is the
    // single most likely false positive in the whole design, because place and
    // time are the two strongest signals it has.
    const members = memberKeys(theTrip().id);

    assert.ok(
      !members.has(nodeKey(episodeFor("trip-msg-cold"))),
      "a cold sales text is not part of the trip",
    );
  });

  test("a recurring calendar entry inside the trip week stays out", () => {
    const members = memberKeys(theTrip().id);

    for (let index = 0; index < 6; index += 1) {
      assert.ok(
        !members.has(nodeKey({ kind: "item", id: itemFor(`trip-standup-${String(index)}`) })),
        "a standup is a template, not part of a trip",
      );
    }
  });

  test("a newsletter stays out", () => {
    const members = memberKeys(theTrip().id);

    for (let index = 0; index < 8; index += 1) {
      assert.ok(
        !members.has(nodeKey({ kind: "item", id: itemFor(`trip-news-${String(index)}`) })),
        "a newsletter is not part of anything",
      );
    }
  });

  test("an unrelated appointment well before the trip stays out", () => {
    const members = memberKeys(theTrip().id);

    assert.ok(!members.has(nodeKey({ kind: "item", id: itemFor("trip-evt-dentist") })));
  });

  test("no node belongs to two stories at once", () => {
    const rows = store.db
      .prepare(
        `SELECT node_kind, node_id, COUNT(*) AS n FROM story_nodes
         GROUP BY node_kind, node_id HAVING n > 1`,
      )
      .all() as { node_kind: string; node_id: string; n: number }[];

    assert.equal(rows.length, 0, `${String(rows.length)} nodes are in more than one story`);
  });
});

describe("explaining a story", () => {
  test("near misses are reported with the reason they missed", () => {
    const explanation = explainStory(store.db, theTrip().id, {
      principalId: DEFAULT_PRINCIPAL,
      timezone: "America/New_York",
    });

    assert.ok(explanation !== null, "a story that exists can be explained");
    assert.ok(explanation.rejected.length > 0, "something scored above zero and was turned down");

    for (const rejection of explanation.rejected) {
      assert.ok(rejection.reason.length > 10, "a rejection states why");
    }
  });

  test("the cold text is among the near misses, not silently absent", () => {
    // A thing that was considered and declined is a different fact from a
    // thing that was never looked at, and only one of them can be argued with.
    const explanation = explainStory(store.db, theTrip().id, {
      principalId: DEFAULT_PRINCIPAL,
      timezone: "America/New_York",
    });

    const cold = nodeKey(episodeFor("trip-msg-cold"));

    assert.ok(
      explanation?.rejected.some((rejection) => nodeKey(rejection.ref) === cold),
      "the cold text was considered and rejected on the record",
    );
  });
});

describe("presence", () => {
  test("home is inferred from the journeys themselves", () => {
    const noise = new NoiseIndex(store.db);
    const detected = detectFrames(store.db, noise);

    assert.equal(detected.report.home, "philadelphia");
  });

  test("during the trip, away", () => {
    const answer = presenceAt(store.db, DEFAULT_PRINCIPAL, DEPARTS_AT + DAY);

    assert.equal(answer?.interval.state, "away");
    assert.equal(answer?.interval.place, "boston");
    assert.equal(answer?.interval.basis, "observed");
  });

  test("after the return, home, and nothing says that changes", () => {
    // The stretch goal, stated as an assertion: a flight back with an empty
    // calendar after it means home, and the layer says so with a basis rather
    // than as an unqualified claim.
    const answer = presenceAt(store.db, DEFAULT_PRINCIPAL, RETURNS_AT + 3 * DAY);

    assert.equal(answer?.interval.state, "home");
    assert.equal(answer?.interval.basis, "observed");
    assert.equal(answer?.holdsForDays, null, "open ended: no journey ends it");
    assert.ok(describePresence(answer).includes("home"));
  });

  test("before the trip, home, but only inferred", () => {
    const answer = presenceAt(store.db, DEFAULT_PRINCIPAL, DEPARTS_AT - 20 * DAY);

    assert.equal(answer?.interval.state, "home");
    assert.equal(answer?.interval.basis, "inferred");
    assert.ok(
      describePresence(answer).startsWith("probably"),
      "an inference is hedged and an observation is not",
    );
  });

  test("a plan is not a memory", () => {
    // Reported from a real screen in August, showing "Philadelphia Sep 14 -
    // now". An interval that starts in the future cannot end in the present,
    // and the whole timeline read as though Harbor had lost track of the date.
    //
    // Tense is computed against a clock passed in rather than stored, so it is
    // testable at all and so a row cannot rot between rebuilds.
    const beforeTheTrip = DEPARTS_AT - 30 * DAY;

    const ahead = presenceTimeline(store.db, DEFAULT_PRINCIPAL, {
      limit: 20,
      now: beforeTheTrip,
    });

    const boston = ahead.find((interval) => interval.place === "boston");

    assert.equal(boston?.tense, "future", "a trip that has not happened is not somewhere you have been");

    const during = presenceTimeline(store.db, DEFAULT_PRINCIPAL, {
      limit: 20,
      now: DEPARTS_AT + DAY,
    }).find((interval) => interval.place === "boston");

    assert.equal(during?.tense, "current");

    const after = presenceTimeline(store.db, DEFAULT_PRINCIPAL, {
      limit: 20,
      now: RETURNS_AT + 30 * DAY,
    }).find((interval) => interval.place === "boston");

    assert.equal(after?.tense, "past");
  });

  test("asking only for what is ahead does not return the past", () => {
    const ahead = presenceTimeline(store.db, DEFAULT_PRINCIPAL, {
      limit: 20,
      tense: "future",
      now: DEPARTS_AT - 30 * DAY,
    });

    assert.ok(ahead.length > 0, "the Boston trip is still to come");

    for (const interval of ahead) {
      assert.equal(interval.tense, "future");
    }
  });

  test("the timeline runs in order and does not overlap itself", () => {
    const intervals = presenceTimeline(store.db, DEFAULT_PRINCIPAL, { limit: 50 });

    assert.ok(intervals.length >= 3);

    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1];
      const current = intervals[index];

      assert.ok(previous !== undefined && current !== undefined);
      assert.ok(
        (previous.endsAt ?? Number.MAX_SAFE_INTEGER) <= current.startsAt,
        "one interval ends before the next begins",
      );
    }
  });
});

describe("shapes a real calendar actually has", () => {
  function withExtra(seed: (db: TestStore["db"], calendar: string, mail: string) => void): TestStore {
    const extra = openTestStore();

    seedTripFixture(extra.db);

    const calendar = (
      extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'apple-calendar'`).get() as {
        id: string;
      }
    ).id;

    const mail = (
      extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'imap'`).get() as {
        id: string;
      }
    ).id;

    seed(extra.db, calendar, mail);

    return extra;
  }

  function add(
    db: TestStore["db"],
    stream: string,
    externalId: string,
    fields: { title: string; body?: string; at: number; kind?: string; author?: string },
  ): void {
    upsertItem(db, {
      accountId: stream.slice(0, stream.lastIndexOf("/")),
      streamId: stream,
      externalId,
      kind: fields.kind ?? "event",
      title: fields.title,
      body: fields.body ?? null,
      ...(fields.author === undefined ? {} : { author: fields.author, direction: "inbound" as const }),
      participants: [],
      occurredAt: fields.at,
      endsAt: fields.kind === undefined ? fields.at + 2 * HOUR : null,
      raw: {},
    });
  }

  test("the same flight published twice is one trip, not two", () => {
    // Found on a real store, where one weekend in Chicago became three
    // identical trips: the airline mails an itinerary, its calendar feed
    // publishes an entry, and a second subscribed calendar publishes it again.
    // Each copy paired with a different copy of the return.
    const extra = withExtra((db, calendar) => {
      add(db, calendar, "dup-out", { title: "Flight PHL to BOS", body: "AA 1783", at: DEPARTS_AT + 180_000 });
      add(db, calendar, "dup-back", { title: "Flight BOS to PHL", body: "AA 1902", at: RETURNS_AT + 60_000 });
    });

    try {
      const detected = detectFrames(extra.db, new NoiseIndex(extra.db));
      const boston = detected.frames.filter((frame) => frame.kind === "trip" && frame.place === "boston");

      assert.equal(boston.length, 1, `expected one Boston trip, got ${String(boston.length)}`);
    } finally {
      extra.close();
    }
  });

  test("a journey with no return does not claim you never came home", () => {
    // The worst failure the real store produced. One unpaired flight in April
    // made every question after it answer "away in Boston" -- in August, four
    // months and several trips later. The sentence never changed, so nothing
    // about it looked wrong.
    const extra = withExtra((db, calendar) => {
      add(db, calendar, "orphan", {
        title: "Flight PHL to ORD",
        body: "AA 300",
        at: DEPARTS_AT - 100 * DAY,
      });
    });

    try {
      buildStories(extra.db, { principalId: DEFAULT_PRINCIPAL, timezone: "America/New_York" });

      const later = presenceAt(extra.db, DEFAULT_PRINCIPAL, DEPARTS_AT - 40 * DAY);

      assert.equal(later?.interval.state, "home", "an unfinished journey expires");
      assert.equal(later?.interval.basis, "inferred", "and what replaces it is a guess, marked as one");
    } finally {
      extra.close();
    }
  });

  test("the timeline does not begin before the person did", () => {
    // A contact card birthday, or a header some mail client wrote wrong,
    // produced a single "probably home" interval starting in October 2001.
    const extra = withExtra((db, _calendar, mail) => {
      add(db, mail, "ancient", {
        kind: "message",
        title: "old",
        body: "hello",
        at: Date.UTC(2001, 9, 13),
      });
    });

    try {
      buildStories(extra.db, { principalId: DEFAULT_PRINCIPAL, timezone: "America/New_York" });

      const timeline = presenceTimeline(extra.db, DEFAULT_PRINCIPAL, { limit: 10 });
      const first = timeline[0];

      assert.ok(first !== undefined);
      assert.ok(
        first.startsAt > Date.now() - 6 * 365 * DAY,
        "the timeline starts inside the horizon, not at the oldest stray timestamp",
      );
    } finally {
      extra.close();
    }
  });

  test("marketing mail naming the destination stays out", () => {
    // The rule that readmitted airline confirmations -- automated senders are
    // not noise -- also readmitted "Top 10 restaurants with a scenic view",
    // which mentioned the right city and shared a word with a booking.
    const extra = withExtra((db, _calendar, mail) => {
      for (let index = 0; index < 4; index += 1) {
        add(db, mail, `promo-${String(index)}`, {
          kind: "message",
          title: "Top 10 restaurants with a scenic view",
          body: "Great tables in Boston and Philadelphia this month. Book on opentable.",
          author: "deals@example-table.test",
          at: DEPARTS_AT - 20 * DAY + index * DAY,
        });
      }
    });

    try {
      buildStories(extra.db, { principalId: DEFAULT_PRINCIPAL, timezone: "America/New_York" });

      const promo = extra.db
        .prepare(`SELECT id FROM items WHERE external_id = 'promo-0'`)
        .get() as { id: string };

      const held = extra.db
        .prepare(`SELECT COUNT(*) AS n FROM story_nodes WHERE node_id = ?`)
        .get(promo.id) as { n: number };

      assert.equal(held.n, 0, "a circular is not part of a trip");
    } finally {
      extra.close();
    }
  });
});

describe("layers below the calendar", () => {
  test("a confirmation does not get to set the dates when the calendar has", () => {
    // Reported from a real store: a Boston weekend the calendar put on the 6th
    // started on the 3rd, because the booking email contained a fare-rule date
    // and the earliest date in a confirmation was being read as the departure.
    // A confirmation is *about* a journey; the calendar entry *is* one.
    const extra = openTestStore();

    try {
      seedTripFixture(extra.db);

      const mail = (
        extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'imap'`).get() as {
          id: string;
        }
      ).id;

      upsertItem(extra.db, {
        accountId: mail.slice(0, mail.lastIndexOf("/")),
        streamId: mail,
        externalId: "conf-early",
        kind: "message",
        direction: "inbound",
        title: "Trip confirmation LLPPVA",
        body:
          "Booked. Fares are held until August 17. Flight AA 1783 PHL to BOS " +
          "departs August 20. Return AA 1902 August 24.",
        author: "noreply@example-air.test",
        participants: ["me@example.net"],
        occurredAt: DEPARTS_AT - 25 * DAY,
        raw: {},
      });

      const detected = detectFrames(extra.db, new NoiseIndex(extra.db));
      const boston = detected.frames.filter(
        (frame) => frame.kind === "trip" && frame.place === "boston",
      );

      assert.equal(boston.length, 1, "one weekend is one trip");
      assert.equal(boston[0]?.spanStartsAt, DEPARTS_AT, "and the calendar sets its boundary");
    } finally {
      extra.close();
    }
  });

  test("a weekend away with no flight is still visible", () => {
    // The case that motivated the layer: no booking, no calendar entry, nothing
    // but somebody telling a friend they were on their way and later that they
    // were home. Never a story -- the evidence is far too thin to reorganise a
    // week around -- but it belongs on the timeline, marked as the guess it is.
    const signals: TravelSignal[] = [
      { at: DEPARTS_AT + 20 * DAY, kind: "leaving", place: null, matched: "heading up to", itemId: "a" },
      { at: DEPARTS_AT + 22 * DAY, kind: "returning", place: null, matched: "just got home", itemId: "b" },
    ];

    const trips = inferredTrips(signals);

    assert.equal(trips.length, 1);
    assert.equal(trips[0]?.startsAt, DEPARTS_AT + 20 * DAY);
    assert.ok(trips[0]?.evidence.includes("just got home"), "and it quotes what it read");
  });

  test("an errand is not a journey and a month is not one either", () => {
    const tooShort = inferredTrips([
      { at: 1_000_000, kind: "leaving", place: null, matched: "heading to", itemId: "a" },
      { at: 1_000_000 + 2 * HOUR, kind: "returning", place: null, matched: "back home", itemId: "b" },
    ]);

    assert.equal(tooShort.length, 0, "two hours is the shops");

    const tooLong = inferredTrips([
      { at: 1_000_000, kind: "leaving", place: null, matched: "heading to", itemId: "a" },
      { at: 1_000_000 + 40 * DAY, kind: "returning", place: null, matched: "back home", itemId: "b" },
    ]);

    assert.equal(tooLong.length, 0, "forty days is two journeys with the middle missing");
  });

  test("somebody else driving home does not move you", () => {
    // The direction rule, which does more work than any of the patterns. A
    // mailbox is full of other people announcing their journeys.
    const extra = openTestStore();

    try {
      seedTripFixture(extra.db);

      const chat = (
        extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'imessage'`).get() as {
          id: string;
        }
      ).id;

      upsertItem(extra.db, {
        accountId: chat.slice(0, chat.lastIndexOf("/")),
        streamId: chat,
        externalId: "theirs",
        kind: "message",
        direction: "inbound",
        title: MAYA,
        body: "driving home now, call you later",
        author: MAYA,
        participants: [MAYA],
        occurredAt: DEPARTS_AT + 30 * DAY,
        raw: {},
      });

      const signals = travelSignals(extra.db, 0);

      assert.ok(
        !signals.some((signal) => signal.itemId === "theirs"),
        "an inbound message is somebody else's evening",
      );
    } finally {
      extra.close();
    }
  });

  test("a metaphor does not relocate anybody", () => {
    const extra = openTestStore();

    try {
      seedTripFixture(extra.db);

      const chat = (
        extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'imessage'`).get() as {
          id: string;
        }
      ).id;

      upsertItem(extra.db, {
        accountId: chat.slice(0, chat.lastIndexOf("/")),
        streamId: chat,
        externalId: "figurative",
        kind: "message",
        direction: "outbound",
        title: MAYA,
        body: "really driving home the point that we need to ship it",
        participants: [MAYA],
        occurredAt: DEPARTS_AT + 30 * DAY,
        raw: {},
      });

      assert.ok(
        !travelSignals(extra.db, 0).some((signal) => signal.itemId === "figurative"),
        "driving home the point is not driving home",
      );
    } finally {
      extra.close();
    }
  });
});

describe("one picture, not several", () => {
  // The reported failure: a lakehouse weekend appeared under "what happened"
  // and was absent from "where you have been". Two answers to one question,
  // from a system meant to have a single picture.
  //
  // Everything the assembly needs is present and none of it is in the calendar
  // entry, which reads "gute?" and nothing else. The path has to run: position
  // admits the conversation immediately before it, that conversation names a
  // person, the person's name appearing in a *different* thread pulls that one
  // in, and that thread is the only thing in the store that says where any of
  // this happened.
  const LAKE = DEPARTS_AT + 25 * DAY;
  const JAMES = "+15552220001";
  const JAKE = "+15553330002";

  function seedLakehouse(): TestStore {
    const extra = openTestStore();

    seedTripFixture(extra.db);

    const calendar = (
      extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'apple-calendar'`).get() as {
        id: string;
      }
    ).id;

    const chat = (
      extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'imessage'`).get() as {
        id: string;
      }
    ).id;

    const put = (
      stream: string,
      externalId: string,
      fields: {
        kind?: string;
        title: string;
        body?: string;
        author?: string;
        thread?: string;
        people?: readonly string[];
        at: number;
        endsAt?: number;
      },
    ): void => {
      upsertItem(extra.db, {
        accountId: stream.slice(0, stream.lastIndexOf("/")),
        streamId: stream,
        externalId,
        kind: fields.kind ?? "event",
        title: fields.title,
        body: fields.body ?? null,
        ...(fields.author === undefined
          ? { direction: "outbound" as const }
          : { author: fields.author, direction: "inbound" as const }),
        threadId: fields.thread ?? null,
        participants: fields.people ?? [],
        occurredAt: fields.at,
        endsAt: fields.endsAt ?? null,
        raw: {},
      });
    };

    // A calendar entry with a name and nothing else. No place, no attendees.
    put(calendar, "gute", { title: "gute?", at: LAKE, endsAt: LAKE + 2 * DAY + HOUR });

    // A thread with James, the day before. Names the place, and names Luther,
    // who is not on this thread.
    put(chat, "g1", {
      kind: "message",
      title: JAMES,
      author: JAMES,
      thread: "chat-james",
      people: [JAMES],
      body: "you still good for the lakehouse in the poconos this weekend?",
      at: LAKE - DAY - 2 * HOUR,
    });
    put(chat, "g2", {
      kind: "message",
      title: JAMES,
      thread: "chat-james",
      people: [JAMES],
      // Faithful to the real message this fixture is drawn from, which named
      // the occasion as well as the people: "meeting luther and gute at a
      // lakehouse". That naming is what earns it a place in the story -- being
      // a text from a friend the day before is not, and must not be.
      body: "not around, meeting luther and gute at a lakehouse in the poconos",
      at: LAKE - DAY - HOUR,
    });

    // A different thread with Jake Luther, hours before. Arrival times, and
    // nothing a search would ever find: everybody in it already knows what it
    // is about.
    put(chat, "j1", {
      kind: "message",
      title: JAKE,
      thread: "chat-jake",
      people: [JAKE],
      body: "what time are you getting there? I can leave around 2",
      at: LAKE - 3 * HOUR,
    });
    put(chat, "j2", {
      kind: "message",
      title: JAKE,
      author: JAKE,
      thread: "chat-jake",
      people: [JAKE],
      body: "probably 5. bring the paddles",
      at: LAKE - 2 * HOUR,
    });

    return extra;
  }

  async function assemble(extra: TestStore): Promise<void> {
    // No vectors. The vector extension is loaded once per process and a second
    // store in the same run cannot reach it; nothing here depends on
    // similarity, so an embedder that declines is the honest stand-in.
    await derive(
      extra.db,
      { id: "none", model: "none", dims: 16, embed: (texts) => Promise.resolve(texts.map(() => new Float32Array(16))) },
      {},
    );
    resolveEntities(extra.db, {});

    for (const [handle, name] of [
      [JAMES, "James Owens"],
      [JAKE, "Jake Luther"],
    ] as const) {
      const row = extra.db
        .prepare(`SELECT entity_id FROM identifiers WHERE normalized LIKE ?`)
        .get(`%${handle.slice(-10)}`) as { entity_id: string } | undefined;

      if (row !== undefined) {
        setDisplayName(extra.db, row.entity_id, name);
      }
    }

    buildStories(extra.db, { principalId: DEFAULT_PRINCIPAL, timezone: "America/New_York" });
  }

  test("a thin calendar entry still assembles a story", async () => {
    const extra = seedLakehouse();

    try {
      await assemble(extra);

      const found = topStories(extra.db, DEFAULT_PRINCIPAL, { limit: 20, minSources: 1 });
      const lakehouse = found.find((story) => story.title === "gute?");

      assert.ok(lakehouse !== undefined, "an occasion with almost no anchors still gathers");
      assert.ok(lakehouse.memberCount >= 3, "including both conversations");
    } finally {
      extra.close();
    }
  });

  test("a name in one thread reaches the person in another", async () => {
    // Without this, Harbor knows who a message was *sent to* and nothing about
    // who it is *about*, and the thread with the man actually going is
    // unreachable from the sentence naming him.
    const extra = seedLakehouse();

    try {
      await assemble(extra);

      const lakehouse = topStories(extra.db, DEFAULT_PRINCIPAL, { limit: 20, minSources: 1 }).find(
        (story) => story.title === "gute?",
      );

      assert.ok(lakehouse !== undefined);

      const evidence = storyMembers(extra.db, lakehouse.id).flatMap((member) => member.evidence);

      assert.ok(
        evidence.some((line) => line.includes("Jake Luther")),
        "the person named in the text is named in the reasoning",
      );
    } finally {
      extra.close();
    }
  });

  test("what the story learned, the timeline knows", async () => {
    // The reported bug, stated directly. The place appears nowhere except in a
    // conversation that only joined on the second round, so this passes only if
    // the frame handed to presence is the one gathering produced rather than the
    // one detection guessed.
    const extra = seedLakehouse();

    try {
      await assemble(extra);

      const answer = presenceAt(extra.db, DEFAULT_PRINCIPAL, LAKE + DAY);

      assert.equal(answer?.interval.state, "away", "a weekend away is a weekend away");
      assert.equal(answer?.interval.place, "poconos", "and the timeline knows where");
    } finally {
      extra.close();
    }
  });

  test("an unrelated reminder near an occasion stays out of it", async () => {
    // Every one of these was admitted on a real store, each carrying the
    // sentence "three days before it starts, which is getting ready for it".
    // A note about a zucchini brought home from work, a note to check whether a
    // domain was available, and somebody's birthday who was not there.
    //
    // Position was made sufficient on its own to rescue "pack laptop", and as a
    // general rule it is indefensible: something is always about to happen.
    const extra = seedLakehouse();

    try {
      const reminders = (
        extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'apple-reminders'`).get() as {
          id: string;
        }
      ).id;

      const put = (externalId: string, title: string, at: number): void => {
        upsertItem(extra.db, {
          accountId: reminders.slice(0, reminders.lastIndexOf("/")),
          streamId: reminders,
          externalId,
          kind: "task",
          title,
          participants: [],
          occurredAt: at,
          state: "open",
          raw: {},
        });
      };

      put("zucc", "zucc", LAKE - 3 * DAY);
      put("domain", "buy harbor.ai", LAKE - 3 * DAY + HOUR);
      put("bday", "issy bday", LAKE - 2 * DAY - 12 * HOUR);
      put("phillies", "PHILLIES", LAKE - 21 * HOUR);

      await assemble(extra);

      const lakehouse = topStories(extra.db, DEFAULT_PRINCIPAL, { limit: 20, minSources: 1 }).find(
        (story) => story.title === "gute?",
      );

      assert.ok(lakehouse !== undefined);

      const held = new Set(
        storyMembers(extra.db, lakehouse.id).map((member) => member.ref.id),
      );

      for (const externalId of ["zucc", "domain", "bday", "phillies"]) {
        const row = extra.db
          .prepare(`SELECT id FROM items WHERE external_id = ?`)
          .get(externalId) as { id: string };

        assert.ok(!held.has(row.id), `${externalId} is not preparation for a lakehouse weekend`);
      }
    } finally {
      extra.close();
    }
  });

  test("a packing reminder the night before still joins", async () => {
    // The case position exists for, and the one the rule above must not break.
    // What distinguishes it was never that it was nearby -- it is that packing
    // is something you do *for* something.
    const extra = seedLakehouse();

    try {
      const reminders = (
        extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'apple-reminders'`).get() as {
          id: string;
        }
      ).id;

      upsertItem(extra.db, {
        accountId: reminders.slice(0, reminders.lastIndexOf("/")),
        streamId: reminders,
        externalId: "pack-cooler",
        kind: "task",
        title: "pack the cooler",
        participants: [],
        occurredAt: LAKE - 16 * HOUR,
        state: "open",
        raw: {},
      });

      await assemble(extra);

      const lakehouse = topStories(extra.db, DEFAULT_PRINCIPAL, { limit: 20, minSources: 1 }).find(
        (story) => story.title === "gute?",
      );

      const row = extra.db
        .prepare(`SELECT id FROM items WHERE external_id = 'pack-cooler'`)
        .get() as { id: string };

      assert.ok(
        lakehouse !== undefined &&
          storyMembers(extra.db, lakehouse.id).some((member) => member.ref.id === row.id),
        "a preparation-shaped task the night before belongs",
      );
    } finally {
      extra.close();
    }
  });

  test("ordinary chatter with a friend the day before stays out", async () => {
    // "get rich for us" -- rich meaning money, not a person -- from somebody
    // texted every day. Prep plus person admitted it, and two weak positives
    // multiplying into a confident wrong answer is the failure mode this whole
    // layer has to resist.
    const extra = seedLakehouse();

    try {
      const chat = (
        extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'imessage'`).get() as {
          id: string;
        }
      ).id;

      for (const [index, at] of [LAKE - 35 * HOUR, LAKE - 34 * HOUR].entries()) {
        upsertItem(extra.db, {
          accountId: chat.slice(0, chat.lastIndexOf("/")),
          streamId: chat,
          externalId: `chatter-${String(index)}`,
          kind: "message",
          direction: index === 0 ? "outbound" : "inbound",
          title: JAKE,
          ...(index === 0 ? {} : { author: JAKE }),
          threadId: "chat-chatter",
          participants: [JAKE],
          body: index === 0 ? "get rich for us" : "kk countin on ya",
          occurredAt: at,
          raw: {},
        });
      }

      await assemble(extra);

      const lakehouse = topStories(extra.db, DEFAULT_PRINCIPAL, { limit: 20, minSources: 1 }).find(
        (story) => story.title === "gute?",
      );

      assert.ok(lakehouse !== undefined);

      const transcripts = storyMembers(extra.db, lakehouse.id)
        .map((member) => extra.db
          .prepare(`SELECT transcript FROM episodes WHERE id = ?`)
          .get(member.ref.id) as { transcript: string } | undefined)
        .filter((row): row is { transcript: string } => row !== undefined);

      assert.ok(
        !transcripts.some((row) => row.transcript.includes("get rich for us")),
        "being with a familiar person near the same time is not evidence",
      );
    } finally {
      extra.close();
    }
  });

  test("a dinner out is not a period away", async () => {
    // The floor that keeps this from fragmenting every week into hours.
    const extra = seedLakehouse();

    try {
      const calendar = (
        extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'apple-calendar'`).get() as {
          id: string;
        }
      ).id;

      upsertItem(extra.db, {
        accountId: calendar.slice(0, calendar.lastIndexOf("/")),
        streamId: calendar,
        externalId: "dinner",
        kind: "event",
        title: "dinner in Boston",
        participants: [],
        occurredAt: LAKE + 10 * DAY,
        endsAt: LAKE + 10 * DAY + 3 * HOUR,
        raw: {},
      });

      await assemble(extra);

      const answer = presenceAt(extra.db, DEFAULT_PRINCIPAL, LAKE + 10 * DAY + HOUR);

      assert.notEqual(answer?.interval.place, "boston", "three hours is a night out");
    } finally {
      extra.close();
    }
  });
});

describe("what is coming", () => {
  // The worst failure Harbor has had, and the reason this surface is not the
  // story layer with a date filter on it.
  const SOON = DEPARTS_AT - 10 * DAY;

  /** Same shape the lakehouse tests use; kept local so the blocks stay independent. */
  async function assemble(extra: TestStore): Promise<void> {
    await derive(
      extra.db,
      { id: "none", model: "none", dims: 16, embed: (texts) => Promise.resolve(texts.map(() => new Float32Array(16))) },
      {},
    );
    resolveEntities(extra.db, {});
    buildStories(extra.db, { principalId: DEFAULT_PRINCIPAL, timezone: "America/New_York" });
  }

  function seedCalendar(): TestStore {
    const extra = openTestStore();

    seedTripFixture(extra.db);

    const calendar = (
      extra.db.prepare(`SELECT id FROM streams WHERE connector_id = 'apple-calendar'`).get() as {
        id: string;
      }
    ).id;

    const put = (externalId: string, title: string, at: number, endsAt: number, body?: string): void => {
      upsertItem(extra.db, {
        accountId: calendar.slice(0, calendar.lastIndexOf("/")),
        streamId: calendar,
        externalId,
        kind: "event",
        title,
        body: body ?? null,
        participants: [],
        occurredAt: at,
        endsAt,
        raw: {},
      });
    };

    // Nothing texted about it, no booking, no evidence of any kind.
    put("smith", "Smith cousin weekend", SOON + 2 * DAY, SOON + 3 * DAY);

    // A wedding, as calendars actually record one: three entries.
    const addr = "Location: The McKelvey Residence, Sewickley, PA 15143";
    put("w1", "Jeremy & Tatum's Welcome Party", SOON + 40 * DAY + 19 * HOUR, SOON + 40 * DAY + 22 * HOUR, addr);
    put("w2", "Jeremy & Tatum's Ceremony", SOON + 41 * DAY + 14 * HOUR, SOON + 41 * DAY + 16 * HOUR, addr);
    put("w3", "Jeremy & Tatum's Reception", SOON + 41 * DAY + 18 * HOUR, SOON + 41 * DAY + 23 * HOUR, addr);

    return extra;
  }

  test("a calendar entry with no evidence at all still shows up", async () => {
    // "Smith cousin weekend", two days away, appeared nowhere: it gathered no
    // cross-source evidence so it was not a story, and the one surface meant to
    // stop somebody forgetting what is ahead was the one place it was
    // invisible -- precisely because it was uncomplicated.
    const extra = seedCalendar();

    try {
      await assemble(extra);

      const ahead = upcoming(extra.db, { principalId: DEFAULT_PRINCIPAL, now: SOON, days: 120 });

      assert.ok(
        ahead.some((entry) => entry.title === "Smith cousin weekend"),
        "completeness is the requirement here, not interestingness",
      );
    } finally {
      extra.close();
    }
  });

  test("a wedding spread over three entries is one thing", async () => {
    // Four cards for one weekend, none of which said it was a wedding. Nobody
    // experiences that as four things.
    const extra = seedCalendar();

    try {
      await assemble(extra);

      const detected = detectFrames(extra.db, new NoiseIndex(extra.db));

      const wedding = detected.frames.filter((frame) =>
        frame.spine.some((ref) => {
          const row = extra.db
            .prepare(`SELECT external_id FROM items WHERE id = ?`)
            .get(ref.id) as { external_id: string } | undefined;

          return row?.external_id === "w2";
        }),
      );

      assert.equal(wedding.length, 1, "one weekend, one frame");
      assert.equal(wedding[0]?.spine.length, 3, "carrying all three entries");
    } finally {
      extra.close();
    }
  });

  test("a work trip with only an address is still travel", async () => {
    // The Concur case: a calendar entry with a city and state in the notes and
    // no flight anywhere. It belongs with the trips, not in a list of errands.
    const extra = seedCalendar();

    try {
      await assemble(extra);

      const ahead = upcoming(extra.db, { principalId: DEFAULT_PRINCIPAL, now: SOON, days: 120 });
      const wedding = ahead.find((entry) => entry.title.includes("Jeremy"));

      assert.equal(wedding?.kind, "travel");
      assert.equal(wedding?.place, "Sewickley", "the town from the address, readably");
    } finally {
      extra.close();
    }
  });

  test("soonest first", async () => {
    const extra = seedCalendar();

    try {
      await assemble(extra);

      const ahead = upcoming(extra.db, { principalId: DEFAULT_PRINCIPAL, now: SOON, days: 120 });

      for (let index = 1; index < ahead.length; index += 1) {
        assert.ok(
          (ahead[index - 1]?.startsAt ?? 0) <= (ahead[index]?.startsAt ?? 0),
          "a list of things you are about to forget is useless in any other order",
        );
      }
    } finally {
      extra.close();
    }
  });
});

describe("naming a story", () => {
  test("a two line reply is split into a label and a sentence", () => {
    const parsed = parseNaming(
      "TITLE: Jeremy and Tatum's wedding weekend\nSUMMARY: You have a welcome party, ceremony and reception in Sewickley.",
    );

    assert.equal(parsed.title, "Jeremy and Tatum's wedding weekend");
    assert.ok(parsed.summary?.startsWith("You have a welcome party"));
  });

  test("a title that is really a sentence is refused", () => {
    // A model that ignores the word limit produces something that is a summary,
    // and using it as a heading makes the surface unreadable.
    const parsed = parseNaming(
      "TITLE: You are going to a wedding in Sewickley over the weekend of October 16th\nSUMMARY: Fine.",
    );

    assert.equal(parsed.title, null);
  });

  test("a reply in the wrong shape yields nothing rather than nonsense", () => {
    const parsed = parseNaming("Sure! Here is a summary of the events you asked about.");

    assert.equal(parsed.title, null);
    assert.equal(parsed.summary, null);
  });
});

describe("anchors", () => {
  test("a node's anchors are typed rather than a bag of words", () => {
    const resolver = new NodeResolver(store.db);
    const ref: NodeRef = { kind: "item", id: itemFor("trip-evt-out") };
    const node = resolver.node(ref);

    assert.ok(node !== null);

    const anchors = anchorsOf(store.db, node, { terms: new TermIndex(store.db) });
    const kinds = new Set(anchors.map((anchor) => anchor.kind));

    assert.ok(kinds.has("place"), "the event knows it is about a place");
    assert.ok(kinds.has("route"), "and that the place has a direction");
    assert.ok(kinds.has("ref"), "and that it carries a flight number");
  });

  test("anchors are persisted, not recomputed on read", () => {
    const stored = anchorsFor(store.db, { kind: "item", id: itemFor("trip-evt-out") });

    assert.ok(stored.length > 0, "the pass wrote them");
    assert.ok(
      stored.some((anchor) => anchor.kind === "place" && anchor.value === "boston"),
      "including the destination",
    );
  });

  test("a place is one anchor however many ways the text names it", () => {
    const node = loadNode(store.db, { kind: "item", id: itemFor("trip-mail-air") });

    assert.ok(node !== null);

    const anchors = anchorsOf(store.db, node, { terms: new TermIndex(store.db) });
    const boston = anchors.filter((anchor) => anchor.kind === "place" && anchor.value === "boston");

    assert.equal(boston.length, 1, "BOS and Boston are one place, not two");
  });
});

describe("frames", () => {
  test("home falls back sensibly when there are no journeys", () => {
    assert.equal(homePlace([]), null);
  });

  test("a journey taken more than once is still a journey", () => {
    // Found on a store of forty thousand items, where it produced zero trips.
    // Somebody who flies the same route six times a year has six calendar
    // entries with the same title, and the recurrence detector counts titles.
    // A standup and a flight are indistinguishable to it; a route and a flight
    // number are what tell them apart.
    const repeated = openTestStore();

    try {
      seedTripFixture(repeated.db);

      const stream = repeated.db
        .prepare(`SELECT id FROM streams WHERE connector_id = 'apple-calendar'`)
        .get() as { id: string };

      const account = stream.id.slice(0, stream.id.lastIndexOf("/"));

      // Five more of the same flight, spread over the preceding year.
      for (let index = 0; index < 5; index += 1) {
        upsertItem(repeated.db, {
          accountId: account,
          streamId: stream.id,
          externalId: `repeat-out-${String(index)}`,
          kind: "event",
          title: "Flight PHL to BOS",
          body: "AA 1783 departs 6:45am",
          participants: [],
          occurredAt: DEPARTS_AT - (60 + index * 60) * DAY,
          endsAt: DEPARTS_AT - (60 + index * 60) * DAY + 2 * HOUR,
          raw: {},
        });
      }

      const noise = new NoiseIndex(repeated.db);
      const detected = detectFrames(repeated.db, noise);

      assert.ok(
        detected.report.trips >= 2,
        `a repeated route still produces journeys, got ${String(detected.report.trips)}`,
      );
    } finally {
      repeated.close();
    }
  });

  test("a journey is not also an occasion", () => {
    // Precedence: the frame kind that explains more of the calendar claims the
    // nodes it explains, or a flight becomes two stories.
    const noise = new NoiseIndex(store.db);
    const detected = detectFrames(store.db, noise);

    const outbound = nodeKey({ kind: "item", id: itemFor("trip-evt-out") });

    const occasions = detected.frames.filter((frame) => frame.kind === "occasion");

    assert.ok(
      !occasions.some((frame) => frame.spine.some((ref) => nodeKey(ref) === outbound)),
      "the outbound flight is a trip spine, not an occasion",
    );
  });
});
