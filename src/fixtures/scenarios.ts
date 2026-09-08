/**
 * The adversarial suite.
 *
 * Every scenario here is a case where similarity is right about the pairs and
 * wrong about the event. That is the point: a case Harbor fails because it did
 * not find something is a recall problem and mostly a matter of reach, and a
 * case Harbor fails because it fused two occurrences that genuinely resemble
 * each other is a modelling problem, which is what this pass is about.
 *
 * The hard negatives are as carefully built as the positives. Two dinners at
 * the same restaurant with the same three people a fortnight apart share every
 * feature any pairwise scorer has: the venue, the roster, the language, the
 * time of day, the day of the week. Nothing distinguishes them except that they
 * are two evenings, and the only signal for that is that their times are
 * disjoint. A system whose notion of an event is "things that resemble each
 * other" cannot represent the difference at all.
 *
 * Written in relative minutes from an anchor, because these cases are entirely
 * about temporal structure and absolute timestamps make that unreadable.
 */
import { DAY_MINUTES, WEEK_MINUTES, type Scenario } from "./coordination.js";

/** Thursday 27 August 2026, 8:00pm America/New_York. */
const ANCHOR = Date.UTC(2026, 7, 28, 0, 0, 0);
const TZ = "America/New_York";

const DAVE = "Dave Mullen";
const SAM = "Sam Ortiz";
const NINA = "Nina Patel";
const CREW = [DAVE, SAM, NINA];

/**
 * The known-good case: an evening arranged in chat, confirmed by mail, with a
 * reminder, and nothing to connect them but a time and a venue.
 */
const barNight: Scenario = {
  name: "bar-night",
  about: "one evening across four sources sharing no vocabulary",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "bn-1", source: "chat", at: -135, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "who's going to the bar later" },
    { id: "bn-2", source: "chat", at: -131, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "im in" },
    { id: "bn-3", source: "chat", at: -127, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "8ish?" },
    { id: "bn-4", source: "chat", at: -123, thread: "crew", title: "Bar Crew", people: CREW, body: "yeah I'm going" },
    { id: "bn-5", source: "mail", at: -85, thread: "ot", from: "reservations@opentable.com", title: "Your reservation at Great American Pub is confirmed", body: "Great American Pub\n123 Fayette St, Conshohocken PA\nThursday, August 27 at 8:00 PM\nParty of 4\nConfirmation: OT7741208" },
    { id: "bn-6", source: "reminders", at: -20, title: "wallet", body: "wallet", state: "open" },
  ],
  gold: { events: [{ name: "bar night", members: ["bn-1", "bn-2", "bn-3", "bn-4", "bn-5", "bn-6"] }] },
};

/**
 * The same three people, the same restaurant, a fortnight apart.
 *
 * The case that breaks similarity outright, and the reason connected components
 * cannot be the definition of an event. Every pairwise feature agrees across
 * the two evenings and every one of them is correct. Only the times disagree,
 * and a pairwise scorer that penalised a fourteen day gap would also refuse the
 * planning conversation that legitimately precedes a trip by two months.
 */
const repeatedDinner: Scenario = {
  name: "repeated-dinner",
  about: "same venue, same people, two weeks apart: two events, not one",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "rd-1", source: "chat", at: -180, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "dinner at Marconi Tavern tonight?" },
    { id: "rd-2", source: "chat", at: -176, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "im in" },
    { id: "rd-3", source: "mail", at: -120, thread: "ot1", from: "reservations@opentable.com", title: "Your reservation at Marconi Tavern is confirmed", body: "Marconi Tavern\nThursday, August 27 at 7:30 PM\nParty of 3\nConfirmation: OT1000001" },

    { id: "rd-4", source: "chat", at: 2 * WEEK_MINUTES - 180, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "dinner at Marconi Tavern tonight?" },
    { id: "rd-5", source: "chat", at: 2 * WEEK_MINUTES - 176, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "im in" },
    { id: "rd-6", source: "mail", at: 2 * WEEK_MINUTES - 120, thread: "ot2", from: "reservations@opentable.com", title: "Your reservation at Marconi Tavern is confirmed", body: "Marconi Tavern\nThursday, September 10 at 7:30 PM\nParty of 3\nConfirmation: OT1000002" },
  ],
  gold: {
    events: [
      { name: "dinner 1", members: ["rd-1", "rd-2", "rd-3"] },
      { name: "dinner 2", members: ["rd-4", "rd-5", "rd-6"] },
    ],
  },
};

/**
 * Two different things arranged in one conversation, minutes apart.
 *
 * The episode is the unit Harbor anchors on, so both plans carry identical
 * people, an identical thread and overlapping text. Anything that treats a
 * conversation as being about one thing merges them.
 */
const twoPlansOneChat: Scenario = {
  name: "two-plans-one-chat",
  about: "one episode containing two separate arrangements",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "tp-1", source: "chat", at: -240, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "who's going to the bar tonight" },
    { id: "tp-2", source: "chat", at: -236, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "im in" },
    { id: "tp-3", source: "chat", at: -232, thread: "crew", title: "Bar Crew", people: CREW, body: "yeah I'm going" },
    { id: "tp-4", source: "chat", at: -228, thread: "crew", title: "Bar Crew", from: NINA, people: CREW, body: "also who wants to play golf saturday morning" },
    { id: "tp-5", source: "chat", at: -224, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "im down for golf" },
    { id: "tp-6", source: "mail", at: -180, thread: "ot", from: "reservations@opentable.com", title: "Your reservation at Great American Pub is confirmed", body: "Great American Pub\nThursday, August 27 at 8:00 PM\nParty of 3\nConfirmation: OT2000001" },
    { id: "tp-7", source: "mail", at: -170, thread: "golf", from: "tee@valleyforgegolf.com", title: "Tee time confirmed at Valley Forge Golf Club", body: "Saturday, August 29 at 9:00 AM\nConfirmation: VF88231" },
  ],
  gold: {
    events: [
      { name: "the bar", members: ["tp-1", "tp-2", "tp-3", "tp-6"] },
      { name: "golf", members: ["tp-4", "tp-5", "tp-7"] },
    ],
  },
};

/**
 * A plan that was cancelled and replaced by a different one.
 *
 * Supersession. The cancellation is not evidence about a second evening; it is
 * evidence that the first evening stopped existing. A system with no notion of
 * status has to either drop the cancellation or fuse both plans, and both are
 * wrong in ways a person would notice immediately.
 */
const cancelledAndReplaced: Scenario = {
  name: "cancel-and-replace",
  about: "a cancellation that ends one event and a replacement that starts another",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "cr-1", source: "chat", at: -300, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "dinner at Marconi Tavern at 7 tonight?" },
    { id: "cr-2", source: "chat", at: -296, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "im in" },
    { id: "cr-3", source: "mail", at: -280, thread: "ot", from: "reservations@opentable.com", title: "Your reservation at Marconi Tavern is confirmed", body: "Marconi Tavern\nThursday, August 27 at 7:00 PM\nParty of 3\nConfirmation: OT3000001" },
    { id: "cr-4", source: "mail", at: -150, thread: "ot", from: "reservations@opentable.com", title: "Your reservation at Marconi Tavern has been cancelled", body: "Cancelled: Marconi Tavern, Thursday August 27 at 7:00 PM\nConfirmation: OT3000001" },
    { id: "cr-5", source: "chat", at: -140, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "marconi cancelled on us, great american pub at 8 instead?" },
    { id: "cr-6", source: "chat", at: -136, thread: "crew", title: "Bar Crew", people: CREW, body: "yeah I'm going" },
    { id: "cr-7", source: "mail", at: -120, thread: "ot2", from: "reservations@opentable.com", title: "Your reservation at Great American Pub is confirmed", body: "Great American Pub\nThursday, August 27 at 8:00 PM\nParty of 3\nConfirmation: OT3000002" },
  ],
  gold: {
    events: [
      { name: "cancelled dinner", members: ["cr-1", "cr-2", "cr-3", "cr-4"] },
      { name: "replacement", members: ["cr-5", "cr-6", "cr-7"] },
    ],
  },
};

/**
 * A suggestion nobody took up.
 *
 * There is no event here. The whole scenario is a hard negative, and the
 * failure it catches is a system that treats a proposal as an occurrence
 * because a proposal has a shape it recognises.
 */
const neverAccepted: Scenario = {
  name: "never-accepted",
  about: "a proposal with no acceptance is not an event",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "na-1", source: "chat", at: -200, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "we should get dinner at Marconi Tavern sometime" },
    { id: "na-2", source: "chat", at: -190, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "haha yeah" },
    { id: "na-3", source: "mail", at: -100, from: "news@example.com", title: "This week in Conshohocken dining", body: "Marconi Tavern reopens its patio at 8:00 PM Thursday. Unsubscribe." },
  ],
  gold: { events: [], unassigned: ["na-1", "na-2", "na-3"] },
};

/**
 * Two different evenings on the same night, with one person in both.
 *
 * Competition. Both hypotheses are live, both are plausible for the reminder
 * sitting between them, and a system that admits an observation to every
 * hypothesis it scores well against fuses them through that one node.
 */
const overlappingEvenings: Scenario = {
  name: "overlapping-evenings",
  about: "two events the same night that must not be joined by a shared person",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "oe-1", source: "chat", at: -300, thread: "crew", title: "Bar Crew", from: DAVE, people: [DAVE, SAM], body: "drinks at Great American Pub at 6?" },
    { id: "oe-2", source: "chat", at: -296, thread: "crew", title: "Bar Crew", from: SAM, people: [DAVE, SAM], body: "im in" },
    { id: "oe-3", source: "mail", at: -280, thread: "a", from: "reservations@opentable.com", title: "Your reservation at Great American Pub is confirmed", body: "Great American Pub\nThursday, August 27 at 6:00 PM\nParty of 2\nConfirmation: OT4000001" },

    { id: "oe-4", source: "chat", at: -290, thread: "family", title: "Nina Patel", from: NINA, people: [NINA], body: "still ok for the Bridgeport Rib House at 9 tonight?" },
    { id: "oe-5", source: "chat", at: -286, thread: "family", title: "Nina Patel", people: [NINA], body: "yeah I'm going" },
    { id: "oe-6", source: "mail", at: -270, thread: "b", from: "reservations@opentable.com", title: "Your reservation at Bridgeport Rib House is confirmed", body: "Bridgeport Rib House\nThursday, August 27 at 9:00 PM\nParty of 2\nConfirmation: OT4000002" },
  ],
  gold: {
    events: [
      { name: "drinks at six", members: ["oe-1", "oe-2", "oe-3"] },
      { name: "dinner at nine", members: ["oe-4", "oe-5", "oe-6"] },
    ],
  },
};

/**
 * A weekly standing meeting.
 *
 * Same title, same people, same hour, four weeks running. The right answer is
 * four events that are instances of one pattern, and the wrong answer that
 * every similarity measure produces is one enormous meeting.
 */
const recurringMeeting: Scenario = {
  name: "recurring-meeting",
  about: "four instances of a weekly pattern, not one meeting",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [0, 1, 2, 3].flatMap((week) => [
    {
      id: `rm-${String(week)}-cal`,
      source: "calendar" as const,
      at: week * WEEK_MINUTES,
      endsAt: week * WEEK_MINUTES + 30,
      title: "Platform sync",
      body: "Weekly platform sync",
    },
    {
      id: `rm-${String(week)}-note`,
      source: "reminders" as const,
      at: week * WEEK_MINUTES - 15,
      title: "platform sync notes",
      state: "open",
    },
  ]),
  gold: {
    events: [0, 1, 2, 3].map((week) => ({
      name: `sync week ${String(week)}`,
      members: [`rm-${String(week)}-cal`, `rm-${String(week)}-note`],
    })),
  },
};

/**
 * An acceptance that follows the wrong proposal.
 *
 * "sure" arrives after two questions and belongs to the second. Binding it by
 * proximity to the nearest preceding proposal is right here and wrong as often
 * as not, which is exactly why the binding needs to be a decision with evidence
 * rather than a rule about line numbers.
 */
const ambiguousReply: Scenario = {
  name: "ambiguous-reply",
  about: "which proposal an acceptance answers",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "ar-1", source: "chat", at: -240, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "anyone want to hit the driving range thursday" },
    { id: "ar-2", source: "chat", at: -238, thread: "crew", title: "Bar Crew", from: NINA, people: CREW, body: "or we could just do dinner at Marconi Tavern at 8" },
    { id: "ar-3", source: "chat", at: -236, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "sure, dinner works" },
    { id: "ar-4", source: "chat", at: -234, thread: "crew", title: "Bar Crew", people: CREW, body: "im in for dinner too" },
    { id: "ar-5", source: "mail", at: -200, thread: "ot", from: "reservations@opentable.com", title: "Your reservation at Marconi Tavern is confirmed", body: "Marconi Tavern\nThursday, August 27 at 8:00 PM\nParty of 3\nConfirmation: OT5000001" },
  ],
  gold: {
    events: [{ name: "dinner", members: ["ar-2", "ar-3", "ar-4", "ar-5"] }],
    unassigned: ["ar-1"],
  },
};

/**
 * The same booking confirmed twice.
 *
 * One occurrence, two nearly identical mails, one of them a reminder sent the
 * morning of. They must land in one event and must not be counted as two.
 */
const duplicateConfirmations: Scenario = {
  name: "duplicate-confirmations",
  about: "two mails about one booking",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "dc-1", source: "chat", at: -600, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "dinner at Marconi Tavern at 8 tonight?" },
    { id: "dc-2", source: "chat", at: -596, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "im in" },
    { id: "dc-3", source: "mail", at: -580, thread: "ot", from: "reservations@opentable.com", title: "Your reservation at Marconi Tavern is confirmed", body: "Marconi Tavern\nThursday, August 27 at 8:00 PM\nParty of 3\nConfirmation: OT6000001" },
    { id: "dc-4", source: "mail", at: -240, thread: "ot", from: "reservations@opentable.com", title: "Reminder: your reservation at Marconi Tavern today", body: "Marconi Tavern\nThursday, August 27 at 8:00 PM\nParty of 3\nConfirmation: OT6000001" },
  ],
  gold: { events: [{ name: "dinner", members: ["dc-1", "dc-2", "dc-3", "dc-4"] }] },
};

/**
 * Two people called Dave.
 *
 * A work Dave and a friend Dave, arranging different things on the same day.
 * Name-based entity resolution fuses them and then everything downstream fuses
 * with it, which is the failure that does the most damage per mistake because
 * it corrupts the key other passes join on.
 */
const sameNameCollision: Scenario = {
  name: "same-name-collision",
  about: "two people with one name arranging two things",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "sn-1", source: "chat", at: -400, thread: "friend", title: "Dave Mullen", from: "Dave Mullen", people: ["Dave Mullen"], body: "beers at Great American Pub at 8?" },
    { id: "sn-2", source: "chat", at: -396, thread: "friend", title: "Dave Mullen", people: ["Dave Mullen"], body: "yeah I'm going" },

    { id: "sn-3", source: "mail", at: -390, thread: "work", from: "dave.chen@vendor.example", title: "Integration review Thursday", body: "Dave here. Can we do the integration review at 2:00 PM Thursday?" },
    { id: "sn-4", source: "calendar", at: -360, endsAt: -300, title: "Integration review", body: "with Dave Chen" },
  ],
  gold: {
    events: [
      { name: "beers", members: ["sn-1", "sn-2"] },
      { name: "review", members: ["sn-3", "sn-4"] },
    ],
  },
};

/**
 * An outbound and a return that are one trip, and a later flight that is not.
 *
 * The pairing rule that makes a journey out of two flights is one of the few
 * genuinely strong rules in the store, and it is strong because a return has a
 * reversed route. A third flight to the same city three months later shares the
 * route and is a different trip.
 */
const travelLegs: Scenario = {
  name: "travel-legs",
  about: "legs that pair into a trip, and one that must not",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "tl-1", source: "calendar", at: 5 * DAY_MINUTES, endsAt: 5 * DAY_MINUTES + 150, title: "Flight to Boston", body: "UA2231 PHL to BOS" },
    { id: "tl-2", source: "calendar", at: 8 * DAY_MINUTES, endsAt: 8 * DAY_MINUTES + 150, title: "Flight to Philadelphia", body: "UA2244 BOS to PHL" },
    { id: "tl-3", source: "mail", at: -20 * DAY_MINUTES, thread: "air", from: "no-reply@united.example", title: "Your trip to Boston is confirmed", body: "UA2231 PHL to BOS\nUA2244 BOS to PHL\nConfirmation: UA99881" },

    { id: "tl-4", source: "calendar", at: 100 * DAY_MINUTES, endsAt: 100 * DAY_MINUTES + 150, title: "Flight to Boston", body: "UA2231 PHL to BOS" },
    { id: "tl-5", source: "mail", at: 60 * DAY_MINUTES, thread: "air2", from: "no-reply@united.example", title: "Your trip to Boston is confirmed", body: "UA2231 PHL to BOS\nConfirmation: UA99999" },
  ],
  gold: {
    events: [
      { name: "boston trip", members: ["tl-1", "tl-2", "tl-3"] },
      { name: "later boston trip", members: ["tl-4", "tl-5"] },
    ],
  },
};

/**
 * People talking about a city you happen to be in.
 *
 * A colleague mentioning Boston during the week of a Boston trip is not
 * evidence about the trip, and a place anchor plus a date range is exactly the
 * pair of features that makes it look like one.
 */
const destinationChatter: Scenario = {
  name: "destination-chatter",
  about: "unrelated mentions of a destination during a trip",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "dch-1", source: "calendar", at: 0, endsAt: 150, title: "Flight to Boston", body: "UA2231 PHL to BOS" },
    { id: "dch-2", source: "calendar", at: 3 * DAY_MINUTES, endsAt: 3 * DAY_MINUTES + 150, title: "Flight to Philadelphia", body: "UA2244 BOS to PHL" },
    { id: "dch-3", source: "mail", at: -10 * DAY_MINUTES, thread: "air", from: "no-reply@united.example", title: "Your trip to Boston is confirmed", body: "UA2231 PHL to BOS\nUA2244 BOS to PHL\nConfirmation: UA77771" },

    { id: "dch-4", source: "chat", at: DAY_MINUTES, thread: "ken", title: "Ken Adler", from: "Ken Adler", people: ["Ken Adler"], body: "my sister just moved to Boston, she loves it" },
    { id: "dch-5", source: "chat", at: DAY_MINUTES + 4, thread: "ken", title: "Ken Adler", people: ["Ken Adler"], body: "nice" },
  ],
  gold: {
    events: [{ name: "boston trip", members: ["dch-1", "dch-2", "dch-3"] }],
    unassigned: ["dch-4", "dch-5"],
  },
};

/**
 * A meeting moved to a different hour on the same day.
 *
 * The reschedule is the same occurrence, unlike the cancellation above which
 * ends one and starts another. Telling those two apart is the whole test: both
 * involve a second time being stated for something already arranged.
 */
const rescheduled: Scenario = {
  name: "rescheduled",
  about: "a time change within one event, not a second event",
  timezone: TZ,
  anchor: ANCHOR,
  observations: [
    { id: "rs-1", source: "chat", at: -400, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "dinner at Marconi Tavern at 7 tonight?" },
    { id: "rs-2", source: "chat", at: -396, thread: "crew", title: "Bar Crew", from: SAM, people: CREW, body: "im in" },
    { id: "rs-3", source: "chat", at: -200, thread: "crew", title: "Bar Crew", from: DAVE, people: CREW, body: "moving it to 8, same place" },
    { id: "rs-4", source: "mail", at: -180, thread: "ot", from: "reservations@opentable.com", title: "Your reservation at Marconi Tavern has been updated", body: "Marconi Tavern\nThursday, August 27 at 8:00 PM\nParty of 3\nConfirmation: OT7000001" },
  ],
  gold: { events: [{ name: "dinner", members: ["rs-1", "rs-2", "rs-3", "rs-4"] }] },
};

export const SCENARIOS: readonly Scenario[] = [
  barNight,
  repeatedDinner,
  twoPlansOneChat,
  cancelledAndReplaced,
  neverAccepted,
  overlappingEvenings,
  recurringMeeting,
  ambiguousReply,
  duplicateConfirmations,
  sameNameCollision,
  travelLegs,
  destinationChatter,
  rescheduled,
];
