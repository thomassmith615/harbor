/**
 * The bar night: a plan that exists nowhere except in the agreeing.
 *
 * `trip.ts` is the scenario the story layer was built for, and it is the
 * favourable case: a journey has a calendar entry, a route, a flight number and
 * a span. Every one of those is a fully specified claim, and the whole anchor
 * design assumes at least one of them is present.
 *
 * This fixture is the unfavourable case, and it is the common one. Four people
 * agree to a thing in a group chat using no proper noun, no date and no
 * identifier. A restaurant confirms a table by mail. A reminder says one word.
 * Nothing anywhere is a calendar event, so under the current design no frame is
 * detected, nothing is gathered, and the four pieces stay four pieces.
 *
 * What makes it worth pinning as a fixture rather than describing:
 *
 *   The vocabulary does not overlap. The chat says "bar", the mail says
 *   "Great American Pub". Both words are under the term index's four character
 *   floor, so neither is even eligible to be a topic anchor, and no amount of
 *   tuning the rarity ceiling reaches them.
 *
 *   The time is stated as "later" and "8ish". `datesIn` reads neither, so the
 *   only node in the store carrying a real time for this evening is a
 *   confirmation email that the broadcast rule excludes from content linking.
 *
 *   The reminder is one word with no verb. It sits twenty minutes before the
 *   reservation, which `withinSpan`'s one hour slack reads as *during* rather
 *   than *before*, so the preparation branch never runs on it.
 *
 *   The roster is carried by three separate agreements ("im in", "same", "yeah
 *   I'm going") and, on a real phone, by tapbacks that the iMessage connector
 *   drops before the store ever sees them.
 *
 * `unrelated-*` is the forbidden half. A conversation about a rendering bug,
 * three hours before, joins on position alone under the current admission rules
 * and must not be a member of anything this fixture produces.
 */
import { saveAccount } from "../store/accounts.js";
import { ensureStream } from "../store/streams.js";
import { upsertItem } from "../store/items.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import { saveReaction } from "../store/reactions.js";
import type { DB } from "../kernel/db.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

/** The reservation. Thursday 27 August 2026, 8:00pm America/New_York. */
export const RESERVED_AT = Date.UTC(2026, 7, 28, 0, 0, 0);

/** When the group chat opens, a little over two hours before. */
export const CHAT_AT = RESERVED_AT - 2 * HOUR - 15 * MINUTE;

/** The reminder, twenty minutes ahead of the table. */
export const REMINDER_AT = RESERVED_AT - 20 * MINUTE;

export const DAVE = "Dave Mullen";
export const SAM = "Sam Ortiz";
export const NINA = "Nina Patel";

/** Everyone who agreed to go, the user included. */
export const GOING: readonly string[] = [DAVE, SAM, NINA];

export interface BarFixture {
  readonly streams: Readonly<Record<string, string>>;
  readonly principalId: string;
}

interface Seed {
  readonly stream: string;
  readonly id: string;
  readonly kind: string;
  readonly direction?: "inbound" | "outbound" | "internal";
  readonly thread?: string | null;
  readonly title?: string | null;
  readonly body?: string | null;
  readonly author?: string | null;
  readonly people?: readonly string[];
  readonly at: number;
  readonly endsAt?: number | null;
  readonly state?: string | null;
}

function accountFor(streamId: string): string {
  return streamId.slice(0, streamId.lastIndexOf("/"));
}

/**
 * Nina, who never types an answer.
 *
 * On a real phone a good share of a roster replies by tapping the message
 * rather than by writing one, and the connector used to drop every one of
 * those before the store existed. Seeded as a reaction rather than as a
 * message, because that is what it is.
 */
export function seedBarReactions(db: DB, streamId: string): void {
  saveReaction(db, {
    streamId,
    targetGuid: "bar-msg-0",
    author: NINA,
    kind: "like",
    occurredAt: CHAT_AT + 6 * MINUTE,
  });

  // And one on something else entirely, which must not put anybody anywhere.
  saveReaction(db, {
    streamId,
    targetGuid: "bar-msg-3",
    author: "Ken Adler",
    kind: "like",
    occurredAt: CHAT_AT + 14 * MINUTE,
  });
}

export function seedBarFixture(db: DB): BarFixture {
  const streams: Record<string, string> = {};

  const sources = [
    { type: "imessage", label: "iMessage", connector: "imessage" },
    { type: "imap", label: "me@example.net", connector: "imap" },
    { type: "apple", label: "icloud-calendar", connector: "apple-calendar" },
    { type: "apple", label: "icloud-reminders", connector: "apple-reminders" },
  ] as const;

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
      throw new Error(`Bar fixture references unknown stream ${seed.stream}`);
    }

    upsertItem(db, {
      accountId: accountFor(streamId),
      streamId,
      externalId: seed.id,
      kind: seed.kind,
      ...(seed.direction === undefined ? {} : { direction: seed.direction }),
      threadId: seed.thread ?? null,
      title: seed.title ?? null,
      body: seed.body ?? null,
      author: seed.author ?? null,
      participants: seed.people ?? [],
      occurredAt: seed.at,
      endsAt: seed.endsAt ?? null,
      state: seed.state ?? null,
      raw: { fixture: seed.id },
    });
  }

  return { streams, principalId: DEFAULT_PRINCIPAL };
}

/**
 * The group chat, in order.
 *
 * Twelve messages, of which four matter and eight are the reason a whole
 * episode is the wrong unit to reason over: a charger, somebody's sister and
 * the game at nine all sit inside the same four hour window and contribute
 * anchors of exactly the same standing as the plan does.
 */
const CHAT: readonly (readonly [string | null, string])[] = [
  [DAVE, "who's going to the bar later"],
  [SAM, "lol depends who else"],
  [NINA, "my sister is in town but she can come"],
  [DAVE, "anyone seen my charger btw"],
  [SAM, "no"],
  [NINA, "the game is on at 9 too"],
  [DAVE, "im in"],
  [SAM, "same"],
  [NINA, "ok cool"],
  [DAVE, "8ish?"],
  [null, "yeah I'm going"],
  [NINA, "nice"],
];

const conversation: readonly Seed[] = CHAT.map(([who, body], index) => ({
  stream: "imessage",
  id: `bar-msg-${String(index)}`,
  kind: "message",
  direction: who === null ? ("outbound" as const) : ("inbound" as const),
  thread: "chat-barcrew",
  title: "Bar Crew",
  body,
  ...(who === null ? {} : { author: who }),
  people: GOING,
  at: CHAT_AT + index * 4 * MINUTE,
}));

/**
 * A conversation that must not join anything.
 *
 * Three hours before the reservation, with somebody the user talks to
 * constantly, about a rendering bug. Under the current admission rules it is
 * indistinguishable from the real one: both are episodes inside the chatter
 * window, both score 0.45 on position and nothing else.
 */
const unrelated: readonly Seed[] = [
  "did you ever hear back about the rendering bug",
  "no still waiting on the vendor",
  "brutal. my kid has a recital thursday so I might be offline",
  "haha good luck",
].map((body, index) => ({
  stream: "imessage",
  id: `unrelated-msg-${String(index)}`,
  kind: "message",
  direction: index % 2 === 0 ? ("inbound" as const) : ("outbound" as const),
  thread: "chat-ken",
  title: "Ken Adler",
  body,
  ...(index % 2 === 0 ? { author: "Ken Adler" } : {}),
  people: ["Ken Adler"],
  at: RESERVED_AT - 3 * HOUR + index * 5 * MINUTE,
}));

/** Enough ordinary traffic that rarity means something. */
const background: readonly Seed[] = Array.from({ length: 20 }, (_unused, index) => index + 1).flatMap(
  (day) => [
    {
      stream: "imap",
      id: `bar-noise-mail-${String(day)}`,
      kind: "message",
      direction: "inbound" as const,
      title: `Weekly digest ${String(day)}`,
      body: "Top 10 restaurants with a scenic view. Unsubscribe here.",
      author: "news@example.com",
      at: RESERVED_AT - day * DAY,
    },
    {
      stream: "imessage",
      id: `bar-noise-msg-${String(day)}`,
      kind: "message",
      direction: "inbound" as const,
      thread: "chat-mom",
      title: "Mom",
      body: "call me when you get a chance ok love you",
      author: "Mom",
      people: ["Mom"],
      at: RESERVED_AT - day * DAY - 3 * HOUR,
    },
  ],
);

const SEEDS: readonly Seed[] = [
  ...conversation,
  ...unrelated,
  ...background,

  // The only node in the store that states a real time for the evening, and
  // the only one that names the venue. Sent by an address nobody replies to,
  // which is what makes it a broadcast and therefore ineligible to join on
  // anything but a shared identifier.
  {
    stream: "imap",
    id: "bar-mail-1",
    kind: "message",
    direction: "inbound",
    thread: "thread-opentable",
    title: "Your reservation at Great American Pub is confirmed",
    body:
      "Your table is booked.\n\nGreat American Pub\n123 Fayette St, Conshohocken PA\n" +
      "Thursday, August 27 at 8:00 PM\nParty of 4\nConfirmation: OT7741208",
    author: "reservations@opentable.com",
    people: ["reservations@opentable.com"],
    at: CHAT_AT + 50 * MINUTE,
  },

  // One word, no verb, twenty minutes before the table.
  {
    stream: "apple-reminders",
    id: "bar-task-1",
    kind: "task",
    title: "wallet",
    body: "wallet",
    at: REMINDER_AT,
    state: "open",
  },
];
