/**
 * The scenario the story layer exists for, written down as a fixture.
 *
 * This is deliberately the exact case that was asked for, because it was also
 * the case the previous design could not do at any tuning:
 *
 *   a reminder to pack a laptop
 *   a flight from PHL to BOS hours later, on the calendar
 *   texts spread across two months working out what to do there
 *   a flight back, with a quiet week after it
 *
 * Run against the old relationship pass, this store produced exactly one
 * "situation": a conversation and the Red Sox calendar entry, joined because
 * both contained the word `fenway`. The flights, the airline confirmation and
 * both reminders were absent. Three separate mechanisms had to fail at once for
 * that, and each of them is now pinned by an assertion in stories.test.ts:
 *
 *   The reminder could not link. `tracks` needed two content words of five or
 *   more characters from the reminder to appear in the other node, and "pack
 *   laptop" yields one. It was arithmetic, not judgement.
 *
 *   The airline confirmation was excluded from content linking entirely,
 *   because nobody ever replies to an airline, and mail from a sender you never
 *   answer was treated as broadcast noise. The single most informative document
 *   in the trip was filtered out for being automated.
 *
 *   The opening conversation was out of range. Content matching reached sixty
 *   days and demoted anything past thirty to coincidence, and "are you actually
 *   coming out to boston in august" was written sixty-two days before the
 *   flight.
 *
 * The noise here matters as much as the signal. A newsletter run, a recurring
 * standup, and a cold text from a stranger who mentions Boston are all present
 * and all forbidden from joining the trip.
 */
import { saveAccount } from "../store/accounts.js";
import { ensureStream } from "../store/streams.js";
import { upsertItem } from "../store/items.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";

/** A fixed clock. Relative times make a test that passes in June fail in July. */
export const TRIP_NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Departure. Everything in the scenario is described relative to this. */
export const DEPARTS_AT = TRIP_NOW + 7 * DAY + 10 * HOUR;
export const RETURNS_AT = TRIP_NOW + 11 * DAY + 18 * HOUR;

export const MAYA = "+15551230077";
export const STRANGER = "+15550199501";

export interface TripFixture {
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

export function seedTripFixture(db: DB): TripFixture {
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
      throw new Error(`Trip fixture references unknown stream ${seed.stream}`);
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

const SEEDS: readonly Seed[] = [
  // ---- the conversation, spread over two months --------------------------
  //
  // Sixty-two days before departure. The old content window was sixty, so this
  // exchange was structurally unreachable however plainly it was about the trip.
  {
    stream: "imessage",
    id: "trip-msg-1",
    kind: "message",
    direction: "inbound",
    thread: "chat-maya",
    title: MAYA,
    body: "so are you actually coming out to boston in august or what",
    author: MAYA,
    people: [MAYA],
    at: DEPARTS_AT - 62 * DAY,
  },
  {
    stream: "imessage",
    id: "trip-msg-2",
    kind: "message",
    direction: "outbound",
    thread: "chat-maya",
    title: MAYA,
    body: "yes! looking at flights now. probably the 20th through the 24th",
    people: [MAYA],
    at: DEPARTS_AT - 62 * DAY + HOUR,
  },

  // Forty days out. No date, no identifier: places and people only.
  {
    stream: "imessage",
    id: "trip-msg-3",
    kind: "message",
    direction: "inbound",
    thread: "chat-maya",
    title: MAYA,
    body: "we should do the freedom trail and definitely oysters at neptune",
    author: MAYA,
    people: [MAYA],
    at: DEPARTS_AT - 40 * DAY,
  },
  {
    stream: "imessage",
    id: "trip-msg-4",
    kind: "message",
    direction: "outbound",
    thread: "chat-maya",
    title: MAYA,
    body: "neptune oyster yes. and I want to see a game at fenway if we can",
    people: [MAYA],
    at: DEPARTS_AT - 40 * DAY + HOUR,
  },

  // Twelve days out, and the message that states the arrival.
  {
    stream: "imessage",
    id: "trip-msg-5",
    kind: "message",
    direction: "inbound",
    thread: "chat-maya",
    title: MAYA,
    body: "booked us fenway tickets for the 22nd. bring a jacket, it gets cold at night",
    author: MAYA,
    people: [MAYA],
    at: DEPARTS_AT - 12 * DAY,
  },
  {
    stream: "imessage",
    id: "trip-msg-6",
    kind: "message",
    direction: "outbound",
    thread: "chat-maya",
    title: MAYA,
    body: "landing at logan around 9am, I will just take the blue line into the city",
    people: [MAYA],
    at: DEPARTS_AT - 12 * DAY + HOUR,
  },

  // ---- the airline ------------------------------------------------------
  //
  // Never replied to, so the old broadcast rule excluded it from linking on
  // content. It carries the flight numbers that tie the calendar together.
  {
    stream: "imap",
    id: "trip-mail-air",
    kind: "message",
    direction: "inbound",
    thread: "t-air",
    title: "Your flight confirmation ZK4PQ2",
    body:
      "Confirmation ZK4PQ2. Flight AA 1783 departs PHL 6:45am and arrives BOS 8:10am. " +
      "Return AA 1902 departs BOS 4:20pm. Check in opens 24 hours before departure.",
    author: "noreply@example-air.test",
    people: ["me@example.net"],
    at: DEPARTS_AT - 30 * DAY,
  },

  // A hotel booking sharing nothing but the destination and the dates.
  {
    stream: "imap",
    id: "trip-mail-hotel",
    kind: "message",
    direction: "inbound",
    thread: "t-hotel",
    title: "Your Boston reservation is confirmed",
    body: "Four nights in Boston. Check in from 3pm. Reservation HQ77213 at the Seaport.",
    author: "reservations@example-hotel.test",
    people: ["me@example.net"],
    at: DEPARTS_AT - 28 * DAY,
  },

  // ---- the calendar -----------------------------------------------------
  {
    stream: "apple-calendar",
    id: "trip-evt-out",
    kind: "event",
    title: "Flight PHL to BOS",
    body: "AA 1783 departs 6:45am",
    people: [],
    at: DEPARTS_AT,
    endsAt: DEPARTS_AT + 2 * HOUR,
  },
  {
    stream: "apple-calendar",
    id: "trip-evt-fenway",
    kind: "event",
    title: "Red Sox game",
    body: "Fenway Park, with Maya",
    people: [],
    at: DEPARTS_AT + 2 * DAY,
    endsAt: DEPARTS_AT + 2 * DAY + 3 * HOUR,
  },
  {
    stream: "apple-calendar",
    id: "trip-evt-back",
    kind: "event",
    title: "Flight BOS to PHL",
    body: "AA 1902 departs 4:20pm",
    people: [],
    at: RETURNS_AT,
    endsAt: RETURNS_AT + 2 * HOUR,
  },

  // ---- the reminders ----------------------------------------------------
  //
  // Neither shares a word with anything else in the trip. Their evidence is
  // entirely positional: hours before a departure. This is the case the old
  // linker rejected by arithmetic.
  {
    stream: "apple-reminders",
    id: "trip-task-pack",
    kind: "task",
    title: "pack laptop",
    people: [],
    at: DEPARTS_AT - 6 * HOUR,
    state: "open",
  },
  {
    stream: "apple-reminders",
    id: "trip-task-charger",
    kind: "task",
    title: "grab headphones and charger",
    people: [],
    at: DEPARTS_AT - 5 * HOUR,
    state: "open",
  },

  // ---- things that must NOT join ----------------------------------------
  //
  // Half the value of a fixture is the memberships it forbids.

  // A stranger who mentions Boston, mid-trip. Right place, right week, and
  // nothing to do with the trip.
  {
    stream: "imessage",
    id: "trip-msg-cold",
    kind: "message",
    direction: "inbound",
    thread: "chat-cold",
    title: STRANGER,
    body:
      "Good afternoon! I have buyers looking in the Boston area and wondered if " +
      "you would consider selling. Happy to talk any time.",
    author: STRANGER,
    people: [STRANGER],
    at: DEPARTS_AT + DAY,
  },

  // A newsletter run. Same shape every week, so the noise index sees it.
  ...Array.from({ length: 8 }, (_, index) => ({
    stream: "imap",
    id: `trip-news-${String(index)}`,
    kind: "message",
    direction: "inbound" as const,
    thread: `t-news-${String(index)}`,
    title: "Your weekly roundup",
    body: "Five things worth reading this week, plus a note on productivity habits.",
    author: "news@example-letter.test",
    people: ["me@example.net"],
    at: DEPARTS_AT - (50 - index * 6) * DAY,
  })),

  // A recurring standup that happens to fall inside the trip week.
  ...Array.from({ length: 6 }, (_, index) => ({
    stream: "apple-calendar",
    id: `trip-standup-${String(index)}`,
    kind: "event",
    title: "Standup",
    body: null,
    people: [],
    at: DEPARTS_AT - (10 - index * 3) * DAY,
    endsAt: DEPARTS_AT - (10 - index * 3) * DAY + 1800000,
  })),

  // An unrelated dentist appointment well before any of this.
  {
    stream: "apple-calendar",
    id: "trip-evt-dentist",
    kind: "event",
    title: "Dentist cleaning",
    body: null,
    people: [],
    at: DEPARTS_AT - 45 * DAY,
    endsAt: DEPARTS_AT - 45 * DAY + HOUR,
  },
];
