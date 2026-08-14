/**
 * A small store with known right answers.
 *
 * This exists because of how the last milestone was verified: by running the
 * whole pipeline against 218,000 real iMessages on one particular Mac and
 * reading the output. That loop takes half an hour, needs somebody's actual
 * life in it, and cannot be run by whoever is writing the code. Which is why
 * the relationship layer shipped twice with a defect that made its flagship
 * behaviour structurally impossible, and why both times it looked fine.
 *
 * So: four sources, a few dozen items, and every cross-source connection that
 * Harbor is supposed to find written down here as a fact rather than a hope.
 * The fixtures are deliberately tiny. They are not a sample of real data and
 * they are not a benchmark; they are a set of tripwires over the handful of
 * properties that are expensive to get wrong and invisible when they break.
 *
 * The cases are the ones that actually failed:
 *
 *   dinner    A text arranging a calendar entry that has no attendees. The
 *             original linker required a shared person, so this could never be
 *             found, and a personal calendar is almost entirely this shape.
 *
 *   trip      A booking email in March and a flight in August sharing only a
 *             confirmation code. Tests that reference matching still reaches
 *             across a distance no time window would allow.
 *
 *   dentist   A reminder and the email it covers, sharing no participants.
 *
 *   noise     A newsletter and an unrelated chat that must NOT be connected to
 *             anything. Half the value of a fixture is the edges it forbids.
 *
 *   venmo     Six identical payment notifications. On the first real run these
 *             chained into the top-ranked "situation" in the store: twenty
 *             receipts for one weekly transaction, every statement true and the
 *             whole thing worthless.
 *
 *   card      A contact card plus a payment to that person. Was a two-source
 *             situation spanning three days, because a card carries a timestamp
 *             and nothing that happened.
 *
 *   shore     One rare word shared between a conversation and a calendar entry,
 *             appearing often enough that the old solo-word bar of three
 *             rejected it. This is the shore-town question the product is for.
 */
import { saveAccount } from "../store/accounts.js";
import { ensureStream } from "../store/streams.js";
import { upsertItem } from "../store/items.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";

/** A fixed clock. Relative times make a test that passes in June fail in July. */
export const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface Fixture {
  readonly streams: Readonly<Record<string, string>>;
}

interface Seed {
  readonly stream: string;
  readonly externalId: string;
  readonly kind: string;
  readonly direction?: "inbound" | "outbound" | "internal";
  readonly threadId?: string | null;
  readonly title?: string | null;
  readonly body?: string | null;
  readonly author?: string | null;
  readonly participants?: readonly string[];
  readonly at: number;
  readonly endsAt?: number | null;
  readonly state?: string | null;
}

/**
 * The store, seeded.
 *
 * Four accounts because the mix is what makes the tests meaningful: a
 * conversational source, a mail source, a calendar with no attendees, and a
 * reminder list with no participants at all. Three of the four break at least
 * one assumption the original graph was built on.
 */
/** A stream id is `<accountId>/<connectorId>`, and the account is the prefix. */
function accountFor(streamId: string): string {
  return streamId.slice(0, streamId.lastIndexOf("/"));
}

export function seedFixture(db: DB): Fixture {
  const streams: Record<string, string> = {};

  const sources: readonly { readonly type: string; readonly label: string; readonly connector: string }[] = [
    { type: "imessage", label: "iMessage", connector: "imessage" },
    { type: "imap", label: "me@comcast.net", connector: "imap" },
    { type: "apple", label: "icloud-calendar", connector: "apple-calendar" },
    { type: "apple", label: "icloud-reminders", connector: "apple-reminders" },
    { type: "apple", label: "icloud-contacts", connector: "apple-contacts" },
  ];

  for (const source of sources) {
    const account = saveAccount(db, {
      sourceType: source.type,
      label: source.label,
      credentials: { accessToken: "fixture", refreshToken: "", expiresAt: 0, scope: "" },
    });

    streams[source.connector] = ensureStream(db, account.id, source.connector).id;
  }

  for (const seed of SEEDS) {
    const streamId = streams[seed.stream];

    if (streamId === undefined) {
      throw new Error(`Fixture references unknown stream ${seed.stream}`);
    }

    upsertItem(db, {
      accountId: accountFor(streamId),
      streamId,
      externalId: seed.externalId,
      kind: seed.kind,
      ...(seed.direction === undefined ? {} : { direction: seed.direction }),
      threadId: seed.threadId ?? null,
      title: seed.title ?? null,
      body: seed.body ?? null,
      author: seed.author ?? null,
      participants: seed.participants ?? [],
      occurredAt: seed.at,
      endsAt: seed.endsAt ?? null,
      state: seed.state ?? null,
      raw: { fixture: seed.externalId },
    });
  }

  return { streams };
}

/** The principal every fixture item belongs to. */
export const PRINCIPAL = DEFAULT_PRINCIPAL;

const SEEDS: readonly Seed[] = [
  // ---- dinner: a conversation that arranges an attendee-less calendar entry ----
  {
    stream: "imessage",
    externalId: "msg-dinner-1",
    kind: "message",
    direction: "inbound",
    threadId: "chat-kearney",
    title: "+15551230001",
    body: "are we still on for the Kearney thing saturday",
    author: "+15551230001",
    participants: ["+15551230001"],
    at: NOW - 6 * DAY,
  },
  {
    stream: "imessage",
    externalId: "msg-dinner-2",
    kind: "message",
    direction: "outbound",
    threadId: "chat-kearney",
    title: "+15551230001",
    body: "yes, dinner at the Kearneys, 7pm. bringing the rhubarb tart",
    participants: ["+15551230001"],
    at: NOW - 6 * DAY + HOUR,
  },
  {
    stream: "imessage",
    externalId: "msg-dinner-3",
    kind: "message",
    direction: "inbound",
    threadId: "chat-kearney",
    title: "+15551230001",
    body: "perfect, see you then",
    author: "+15551230001",
    participants: ["+15551230001"],
    at: NOW - 6 * DAY + 2 * HOUR,
  },
  {
    // No attendees, no author, typed by hand. The case that could not be found.
    stream: "apple-calendar",
    externalId: "evt-dinner",
    kind: "event",
    title: "Dinner at the Kearneys",
    body: null,
    participants: [],
    at: NOW - 2 * DAY,
    endsAt: NOW - 2 * DAY + 3 * HOUR,
  },

  // ---- trip: a booking in March, a flight in August, one shared code ----
  {
    stream: "imap",
    externalId: "mail-booking",
    kind: "message",
    direction: "inbound",
    threadId: "thread-booking",
    title: "Your trip confirmation",
    body:
      "Thanks for booking. Confirmation NKQ8ZT2 for two nights in Stowe. " +
      "Check in from 4pm.",
    author: "reservations@example-lodge.test",
    participants: ["me@comcast.net"],
    at: NOW - 150 * DAY,
  },
  {
    stream: "imap",
    externalId: "mail-flight",
    kind: "message",
    direction: "inbound",
    threadId: "thread-flight",
    title: "Itinerary update",
    body: "Your booking NKQ8ZT2 has been updated. Flight AA 4608 departs 6:10am.",
    author: "noreply@example-air.test",
    participants: ["me@comcast.net"],
    at: NOW - 9 * DAY,
  },

  // ---- dentist: a reminder and the mail it covers, sharing nobody ----
  {
    stream: "apple-reminders",
    externalId: "task-dentist",
    kind: "task",
    title: "Reschedule dentist appointment",
    body: null,
    participants: [],
    at: NOW - 4 * DAY,
    state: "open",
  },
  {
    stream: "imap",
    externalId: "mail-dentist",
    kind: "message",
    direction: "inbound",
    threadId: "thread-dentist",
    title: "About your appointment",
    body:
      "We need to reschedule your dentist appointment on the 19th. " +
      "Please call the office to pick a new time.",
    author: "front-desk@example-dental.test",
    participants: ["me@comcast.net"],
    at: NOW - 5 * DAY,
  },

  // ---- shore: one distinctive word, no second word to lean on ----
  {
    stream: "imessage",
    externalId: "msg-shore-1",
    kind: "message",
    direction: "inbound",
    threadId: "chat-shore",
    title: "+15551230009",
    body: "we got the Wildwood place again for the last week of August",
    author: "+15551230009",
    participants: ["+15551230009"],
    at: NOW - 20 * DAY,
  },
  {
    stream: "imessage",
    externalId: "msg-shore-2",
    kind: "message",
    direction: "outbound",
    threadId: "chat-shore",
    title: "+15551230009",
    body: "amazing, I will drive down friday",
    participants: ["+15551230009"],
    at: NOW - 20 * DAY + HOUR,
  },
  {
    stream: "apple-calendar",
    externalId: "evt-shore",
    kind: "event",
    title: "Wildwood",
    body: null,
    participants: [],
    at: NOW + 5 * DAY,
    endsAt: NOW + 8 * DAY,
  },

  // ---- card: reference data, not something that happened ----
  {
    stream: "apple-contacts",
    externalId: "card-myles",
    kind: "contact",
    title: "Myles Menowitz",
    body: "Myles Menowitz +15551230011",
    participants: ["+15551230011"],
    at: NOW - 40 * DAY,
  },
  {
    stream: "imap",
    externalId: "mail-myles",
    kind: "message",
    direction: "inbound",
    threadId: "thread-myles",
    title: "You paid Myles Menowitz $437.74",
    body: "You paid Myles Menowitz $437.74. View your transaction in the app.",
    author: "venmo@venmo.test",
    participants: ["me@comcast.net"],
    at: NOW - 37 * DAY,
  },

  // ---- venmo: a template, not twenty events ----
  ...Array.from({ length: 6 }, (_, index) => ({
    stream: "imap",
    externalId: `mail-venmo-${String(index)}`,
    kind: "message",
    direction: "inbound" as const,
    threadId: `thread-venmo-${String(index)}`,
    title: `You paid Christopher Hand $${String(10 + index)}.55`,
    body:
      `You paid Christopher Hand $${String(10 + index)}.55. ` +
      "View your transaction in the app.",
    author: "venmo@venmo.test",
    participants: ["me@comcast.net"],
    at: NOW - (60 - index * 7) * DAY,
  })),

  // ---- noise: must not connect to anything ----
  {
    stream: "imap",
    externalId: "mail-newsletter",
    kind: "message",
    direction: "inbound",
    threadId: "thread-newsletter",
    title: "This week in gardening",
    body:
      "Shop now for spring bulbs, 20% off. Limited time. Unsubscribe to stop " +
      "receiving these emails.",
    author: "news@example-garden.test",
    participants: ["me@comcast.net"],
    at: NOW - 3 * DAY,
  },
  {
    stream: "imessage",
    externalId: "msg-noise-1",
    kind: "message",
    direction: "inbound",
    threadId: "chat-other",
    title: "+15559990002",
    body: "haha ok",
    author: "+15559990002",
    participants: ["+15559990002"],
    at: NOW - 3 * DAY,
  },
  {
    stream: "imessage",
    externalId: "msg-noise-2",
    kind: "message",
    direction: "outbound",
    threadId: "chat-other",
    title: "+15559990002",
    body: "yeah",
    participants: ["+15559990002"],
    at: NOW - 3 * DAY + 60_000,
  },
];
