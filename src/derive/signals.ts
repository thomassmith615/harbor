/**
 * Travel stated in passing.
 *
 * "driving home" is not a calendar entry, carries no identifier, names no date,
 * and is the most common way a person records a journey. Everything the story
 * layer reads is the exception: most trips are never booked through an airline,
 * most weekends away leave no artefact at all, and the only trace is somebody
 * telling a friend they are on their way.
 *
 * This is a deliberately weaker layer than the one in `frames.ts`, and the
 * weakness is the design rather than a shortfall of it. A signal has no
 * destination worth trusting, no duration, and no corroboration; promoting one
 * to a trip frame would let a sentence reorganise a week of somebody's life.
 * So signals never build stories. They do two narrower things, both of which
 * are about *bounding* claims that already exist:
 *
 *   They close journeys that were never closed. A flight out with no flight
 *   back leaves an interval running forward forever, and "back home finally"
 *   three days later ends it.
 *
 *   They stand in for journeys nobody recorded. A departure and a return with
 *   nothing between them is a period away, marked inferred and placed
 *   "somewhere else" unless the text happened to name where.
 *
 * The direction rule matters more than the vocabulary does. A signal only
 * counts from something the person wrote themselves: an inbound "driving home"
 * is somebody else's evening, and reading it as the user's is the kind of
 * mistake that puts a person in the wrong city for a week with a true sentence
 * as the evidence.
 */
import { placesIn } from "./places.js";
import type { DB } from "../kernel/db.js";

const DAY = 86_400_000;

export type SignalKind = "leaving" | "returning";

export interface TravelSignal {
  readonly at: number;
  readonly kind: SignalKind;
  /** Canonical place, when the sentence named one. Usually it did not. */
  readonly place: string | null;
  /** The phrase that matched, for the evidence line. */
  readonly matched: string;
  readonly itemId: string;
}

/**
 * Setting off.
 *
 * Present and future tense only. "we drove to Boston last month" is a memory,
 * and reading it as a departure dates the trip to whenever it was mentioned.
 */
const LEAVING = [
  /\b(?:i'?m|we'?re|im|were)\s+(?:on\s+(?:my|our)\s+way|heading|headed|driving|flying|riding|walking|going)\s+(?:up|down|out|over|off)?\s*to\b/i,
  /\b(?:heading|headed|driving|flying)\s+(?:up|down|out|over)\s+to\b/i,
  /\b(?:i'?m|we'?re|im|were)\s+(?:off|leaving|taking\s+off)\s+(?:to|for)\b/i,
  /\bon\s+(?:my|our)\s+way\s+to\b/i,
  /\bjust\s+(?:left|landed\s+in|got\s+(?:in|to))\b/i,
];

/**
 * Coming back.
 *
 * "home" carries the direction on its own, which is why these are more reliable
 * than departures: somebody saying they are heading home is saying where they
 * are going in a way that needs no gazetteer.
 */
const RETURNING = [
  /\b(?:i'?m|we'?re|im|were)\s+(?:on\s+(?:my|our)\s+way|heading|headed|driving|flying|walking)\s+(?:back\s+)?home\b/i,
  /\b(?:heading|headed|driving|flying|on\s+(?:my|our)\s+way)\s+back\s+(?:home|now)\b/i,
  /\b(?:just\s+)?(?:got|made\s+it|back)\s+home\b/i,
  /\bback\s+(?:in|to)\s+(?:town|philly|philadelphia)\b/i,
  /\balmost\s+home\b/i,
  /\bhome\s+(?:now|finally|at\s+last)\b/i,
];

/**
 * Phrases that use the vocabulary without meaning any of it.
 *
 * "on my way to figuring this out" and "driving home the point" are both
 * departures as far as a pattern is concerned. Cheap to exclude, and each one
 * left in is a person relocated by a metaphor.
 */
const FIGURATIVE =
  /\b(?:driving\s+home\s+the|on\s+(?:my|our)\s+way\s+to\s+(?:figuring|understanding|being|becoming|getting\s+better)|home\s+(?:page|screen|office|run|work|depot|team))\b/i;

function match(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const found = pattern.exec(text);

    if (found !== null) {
      return found[0];
    }
  }

  return null;
}

/**
 * Every travel statement the person made themselves.
 *
 * Outbound messages only. The direction filter is doing more work here than any
 * of the patterns: a mailbox is full of other people announcing their journeys,
 * and none of them says anything about where this person is.
 */
export function travelSignals(db: DB, since: number): readonly TravelSignal[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.title, i.body, i.occurred_at
       FROM items i
       WHERE i.kind = 'message' AND i.direction = 'outbound'
         AND i.deleted_at IS NULL AND i.occurred_at >= ?
       ORDER BY i.occurred_at ASC`,
    )
    .all(since) as { id: string; title: string | null; body: string | null; occurred_at: number }[];

  const signals: TravelSignal[] = [];

  for (const row of rows) {
    const text = `${row.title ?? ""} ${row.body ?? ""}`.trim();

    // A long message that mentions going somewhere is usually telling a story
    // about it. The signals worth reading are the short ones sent in transit.
    if (text.length === 0 || text.length > 300 || FIGURATIVE.test(text)) {
      continue;
    }

    const returning = match(text, RETURNING);

    if (returning !== null) {
      signals.push({
        at: row.occurred_at,
        kind: "returning",
        place: null,
        matched: returning.trim(),
        itemId: row.id,
      });

      continue;
    }

    const leaving = match(text, LEAVING);

    if (leaving !== null) {
      const places = placesIn(text);

      signals.push({
        at: row.occurred_at,
        kind: "leaving",
        place: places[0]?.id ?? null,
        matched: leaving.trim(),
        itemId: row.id,
      });
    }
  }

  return signals;
}

/** The longest a period away is assumed to run on text evidence alone. */
const MAX_INFERRED_TRIP_MS = 14 * DAY;

/** And the shortest, below which it is an errand rather than a journey. */
const MIN_INFERRED_TRIP_MS = 16 * 3_600_000;

export interface InferredTrip {
  readonly startsAt: number;
  readonly endsAt: number;
  readonly place: string | null;
  readonly evidence: string;
}

/**
 * Periods away that only the messages know about.
 *
 * A departure followed by a return, with nothing in between claiming otherwise.
 * The floor and ceiling are what keep this from being nonsense: an hour is a
 * trip to the shops, and a month is two journeys with the middle missing.
 *
 * These never become stories. They inform the presence timeline and are marked
 * inferred there, because "somebody said they were driving somewhere and later
 * said they were home" is real evidence and much weaker evidence than a
 * boarding pass, and a surface that renders the two identically is lying.
 */
export function inferredTrips(signals: readonly TravelSignal[]): readonly InferredTrip[] {
  const trips: InferredTrip[] = [];

  let open: TravelSignal | null = null;

  for (const signal of signals) {
    if (signal.kind === "leaving") {
      // A second departure replaces the first: legs of one journey, or the
      // earlier one was never a journey at all.
      open = signal;
      continue;
    }

    if (open === null) {
      continue;
    }

    const span = signal.at - open.at;

    if (span >= MIN_INFERRED_TRIP_MS && span <= MAX_INFERRED_TRIP_MS) {
      trips.push({
        startsAt: open.at,
        endsAt: signal.at,
        place: open.place,
        evidence: `you said "${open.matched}", then "${signal.matched}"`,
      });
    }

    open = null;
  }

  return trips;
}

/**
 * The first time the person said they were home after a moment.
 *
 * Used to close journeys that have no return leg, which is the single largest
 * source of wrong answers the presence layer has: an unpaired flight otherwise
 * runs to an assumed duration and stops, and if the person actually stayed
 * longer, every day after that is confidently wrong.
 */
export function firstReturnAfter(
  signals: readonly TravelSignal[],
  at: number,
  within: number,
): TravelSignal | null {
  for (const signal of signals) {
    if (signal.kind !== "returning" || signal.at <= at) {
      continue;
    }

    if (signal.at - at > within) {
      return null;
    }

    return signal;
  }

  return null;
}
