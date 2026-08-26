/**
 * Where the person is, over time.
 *
 * This is the layer that makes a whole class of question answerable, and the
 * old design had no place to put it. A relationship graph can say two things
 * are connected; it cannot say "you are back on Thursday and nothing is on the
 * calendar for a week after that", because being somewhere is not a connection
 * between two items. It is a state that holds over an interval, and intervals
 * had no representation anywhere in the store.
 *
 * The derivation is small and almost entirely negative space. A journey out
 * says you are away; the journey back says you are home; everything between two
 * trips is home by default. The interesting part is what *basis* each interval
 * has:
 *
 *   observed  A journey said so. A flight to Boston on the 20th is not an
 *             inference.
 *
 *   inferred  Nothing said otherwise. This is the default state and it is worth
 *             marking as weaker, because "no evidence of travel" and "evidence
 *             of no travel" are different claims and only one of them is true
 *             here. Harbor holds six months of one calendar; a road trip nobody
 *             wrote down is invisible and the honest answer is "probably home".
 *
 * The distinction is the whole reason this is safe to build on. A reminder
 * scheduled against an inferred home stretch is a reasonable guess; one
 * scheduled against an observed return is a fact.
 */
import { placeById } from "./places.js";
import { firstReturnAfter, inferredTrips, travelSignals } from "./signals.js";
import type { DB } from "../kernel/db.js";
import type { Frame } from "./frames.js";

const DAY = 86_400_000;

export type PresenceState = "home" | "away" | "transit";

/**
 * Whether an interval has happened, is happening, or is still ahead.
 *
 * The timeline was built without any notion of now, so a flight booked for
 * November sat in "where you have been" alongside a weekend in August. Both are
 * intervals and only one of them is a memory. Nothing else in Harbor conflates
 * a record with a plan, and a timeline of somebody's life is the last place it
 * should happen.
 */
export type PresenceTense = "past" | "current" | "future";
export type PresenceBasis = "observed" | "inferred";

export interface PresenceInterval {
  readonly id: string;
  readonly startsAt: number;
  /** Null means open ended: nothing says when this stops being true. */
  readonly endsAt: number | null;
  readonly place: string | null;
  readonly state: PresenceState;
  readonly basis: PresenceBasis;
  readonly storyId: string | null;
  readonly evidence: string;
  readonly tense: PresenceTense;
}

export interface PresenceReport {
  readonly intervals: number;
  readonly away: number;
  readonly home: string | null;
}

interface PresenceRow {
  readonly id: string;
  readonly starts_at: number;
  readonly ends_at: number | null;
  readonly place: string | null;
  readonly state: string;
  readonly basis: string;
  readonly story_id: string | null;
  readonly evidence: string;
}

function tenseOf(startsAt: number, endsAt: number | null, now: number): PresenceTense {
  if (startsAt > now) {
    return "future";
  }

  return endsAt === null || endsAt > now ? "current" : "past";
}

function toInterval(row: PresenceRow, now = Date.now()): PresenceInterval {
  return {
    tense: tenseOf(row.starts_at, row.ends_at, now),
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    place: row.place,
    state: row.state as PresenceState,
    basis: row.basis as PresenceBasis,
    storyId: row.story_id,
    evidence: row.evidence,
  };
}

function displayOf(place: string | null): string {
  if (place === null) {
    return "somewhere else";
  }

  const known = placeById(place);

  if (known !== null) {
    return known.display;
  }

  // A place learned from a calendar address rather than from the gazetteer.
  // Its id is a normalised token -- `long_pond` -- and printing that raw makes
  // a real town look like a database key.
  return place
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Rebuilds the whole timeline.
 *
 * Whole rather than incrementally, because one new flight changes the state of
 * every day after it and there is no correct partial update. It is also cheap:
 * the input is the trips, of which there are tens, not the items, of which
 * there are hundreds of thousands.
 */
/**
 * How far back a timeline is worth having.
 *
 * Presence started at the oldest timestamp in the store, and on a real store
 * that was October 2001 -- a contact card birthday, or a header some mail
 * client wrote wrong twenty years ago. The result was a single "probably home"
 * interval covering a childhood. Five years is the horizon the product is for.
 */
const HORIZON_MS = 5 * 365 * DAY;

/**
 * How long an unfinished journey is assumed to last.
 *
 * A trip whose return was never found used to run to `null`, meaning "away, and
 * nothing says otherwise, forever". Since presence returned as soon as it hit
 * one, a single unpaired flight in April made every question after it answer
 * "away in Boston" -- in August, four months and several trips later, with the
 * person sitting at home. Confidently wrong, and wrong in the way that is
 * hardest to notice, because the sentence never changes.
 *
 * So an open journey now expires. It ends at the next journey if there is one,
 * and otherwise after this long, after which the honest answer is an inferred
 * home rather than an asserted elsewhere.
 */
const ASSUMED_TRIP_MS = 5 * DAY;

/** How long to keep looking for somebody saying they got home. */
const MAX_OPEN_MS = 30 * DAY;

/**
 * An interval as it goes to disk.
 *
 * Without `tense`, deliberately: whether something is past or upcoming changes
 * every day while the row does not, so it is computed on read. Storing it would
 * mean a timeline that silently rots until the next rebuild.
 */
type StoredInterval = Omit<PresenceInterval, "id" | "tense">;

interface Leg {
  readonly startsAt: number;
  readonly endsAt: number;
  readonly place: string | null;
  readonly open: boolean;
  /** Whether a journey said so, or only the messages did. */
  readonly observed: boolean;
  readonly evidence: string;
  /** The story this period is, when one was assembled for it. */
  readonly storyId: string | null;
}

/**
 * Trips flattened into a sequence that does not overlap itself.
 *
 * Frames are allowed to overlap; a timeline is not. Two trips to London whose
 * spans crossed produced two "away in London" intervals sitting on top of each
 * other, one of which had to be wrong and neither of which said which.
 *
 * Overlapping trips to the same place merge. Overlapping trips to different
 * places are a genuine contradiction in the calendar, and the earlier one is
 * truncated rather than dropped, because being somewhere and then somewhere
 * else is at least a shape a week can have.
 */
/**
 * The shortest an occasion can be and still mean you went somewhere.
 *
 * A dinner in another city is a night out, not a period away, and putting it on
 * the timeline would fragment every week into hours. Something that runs
 * overnight is different: you slept there.
 */
const AWAY_OCCASION_MS = 12 * 3_600_000;

function flatten(
  frames: readonly Frame[],
  home: string | null,
  db: DB,
  since: number,
  storyOf: ReadonlyMap<string, string>,
): readonly Leg[] {
  // What the person said about their own movements. Weaker than a journey and
  // read second, so it can only ever fill a silence or close something the
  // calendar left open.
  const signals = travelSignals(db, since);

  const fromTrips: Leg[] = [];

  for (const trip of frames) {
    // Not only journeys.
    //
    // A weekend at a lakehouse has no flight, no booking and no route, so it
    // was never a trip -- and it appeared under "what happened" while being
    // absent from "where you have been", which is two answers to one question
    // from a system that is supposed to have one picture. What makes something
    // a period away is not that an aeroplane was involved. It is that it ran
    // overnight and it happened somewhere that is not home.
    const awayOccasion =
      trip.kind === "occasion" &&
      trip.place !== null &&
      trip.place !== home &&
      trip.spanEndsAt - trip.spanStartsAt >= AWAY_OCCASION_MS;

    if (trip.kind !== "trip" && !awayOccasion) {
      continue;
    }

    // A journey out with no journey back used to expire after an assumed few
    // days, which is right when nothing else is known and wrong the moment
    // somebody has said "back home finally" on the Thursday. A statement beats
    // an assumption.
    const said = trip.openEnded
      ? firstReturnAfter(signals, trip.spanStartsAt, MAX_OPEN_MS)
      : null;

    fromTrips.push({
      startsAt: trip.spanStartsAt,
      endsAt: said?.at ?? (trip.openEnded ? trip.spanStartsAt + ASSUMED_TRIP_MS : trip.spanEndsAt),
      place: trip.place,
      open: trip.openEnded && said === null,
      observed: true,
      storyId: storyOf.get(trip.key) ?? null,
      evidence:
        trip.kind === "occasion"
          ? `${trip.title ?? "something"} ran overnight in ${displayOf(trip.place)}`
          : said !== null
            ? `a journey to ${displayOf(trip.place)}, and you said "${said.matched}"`
            : trip.openEnded
              ? `a journey to ${displayOf(trip.place)} with nothing saying when you came back`
              : `a journey to ${displayOf(trip.place)} and back`,
    });
  }

  // Periods away that only the messages know about. Dropped where a real
  // journey already covers them, since a boarding pass is the better witness.
  const fromText: Leg[] = inferredTrips(signals)
    .filter(
      (inferred) =>
        !fromTrips.some(
          (leg) => inferred.startsAt < leg.endsAt && inferred.endsAt > leg.startsAt,
        ),
    )
    .map((inferred) => ({
      startsAt: inferred.startsAt,
      endsAt: inferred.endsAt,
      place: inferred.place,
      open: false,
      observed: false,
      storyId: null,
      evidence: inferred.evidence,
    }));

  const trips = [...fromTrips, ...fromText].sort((a, b) => a.startsAt - b.startsAt);

  const legs: Leg[] = [];

  for (const leg of trips) {

    const previous = legs[legs.length - 1];

    if (previous === undefined || leg.startsAt > previous.endsAt) {
      legs.push(leg);
      continue;
    }

    if (previous.place === leg.place) {
      legs[legs.length - 1] = {
        ...previous,
        endsAt: Math.max(previous.endsAt, leg.endsAt),
        open: previous.open && leg.open,
      };

      continue;
    }

    legs[legs.length - 1] = { ...previous, endsAt: leg.startsAt, open: false };
    legs.push(leg);
  }

  return legs;
}

/**
 * Rebuilds the whole timeline.
 *
 * Whole rather than incrementally, because one new flight changes the state of
 * every day after it and there is no correct partial update. It is also cheap:
 * the input is the trips, of which there are tens, not the items, of which
 * there are hundreds of thousands.
 */
export function rebuildPresence(
  db: DB,
  principalId: string,
  frames: readonly Frame[],
  home: string | null,
  now: number,
  storyOf: ReadonlyMap<string, string> = new Map(),
): PresenceReport {
  const intervals: StoredInterval[] = [];

  const oldest = (
    db.prepare(`SELECT MIN(occurred_at) AS at FROM items WHERE deleted_at IS NULL`).get() as {
      at: number | null;
    }
  ).at;

  const legs = flatten(frames, home, db, now - HORIZON_MS, storyOf);
  let cursor = Math.max(oldest ?? now - HORIZON_MS, now - HORIZON_MS);

  for (const leg of legs) {
    if (leg.endsAt <= cursor) {
      continue;
    }

    const startsAt = Math.max(leg.startsAt, cursor);

    if (startsAt > cursor) {
      intervals.push({
        startsAt: cursor,
        endsAt: startsAt,
        place: home,
        state: "home",
        basis: "inferred",
        storyId: null,
        evidence: "nothing on the calendar says you went anywhere",
      });
    }

    intervals.push({
      startsAt,
      endsAt: leg.endsAt,
      place: leg.place,
      state: "away",
      basis: leg.observed ? "observed" : "inferred",
      storyId: leg.storyId,
      evidence: leg.evidence,
    });

    cursor = leg.endsAt;
  }

  const last = legs[legs.length - 1];

  // Only claim an open-ended present when the last journey is actually behind
  // us. A trip that has not happened yet says nothing about where somebody is
  // today, and "you came back and nothing says you left again" is a strange
  // thing to write about November.
  intervals.push({
    startsAt: cursor,
    endsAt: null,
    place: home,
    state: "home",
    // Home after a journey somebody actually took is observed. Home after a
    // period inferred from two text messages is inferred as well: a conclusion
    // is never firmer than what it was drawn from.
    basis: last !== undefined && !last.open && last.observed ? "observed" : "inferred",
    storyId: null,
    evidence:
      last === undefined
        ? "no journeys found at all, so home is the assumption"
        : last.open
          ? "the last journey never said when it ended, so this is a guess"
          : last.observed
            ? "you came back and nothing says you left again"
            : "you said you got home, and nothing says you left again",
  });

  return persist(db, principalId, intervals, now, home);
}

function persist(
  db: DB,
  principalId: string,
  intervals: readonly StoredInterval[],
  now: number,
  home: string | null,
): PresenceReport {
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM presence WHERE principal_id = ?`).run(principalId);

    const insert = db.prepare(
      `INSERT INTO presence
         (id, principal_id, starts_at, ends_at, place, state, basis, story_id, evidence, created_at)
       VALUES (@id, @principalId, @startsAt, @endsAt, @place, @state, @basis, @storyId, @evidence, @now)`,
    );

    intervals.forEach((interval, index) => {
      insert.run({
        id: `pre_${String(index).padStart(4, "0")}`,
        principalId,
        startsAt: interval.startsAt,
        endsAt: interval.endsAt,
        place: interval.place,
        state: interval.state,
        basis: interval.basis,
        storyId: interval.storyId,
        evidence: interval.evidence,
        now,
      });
    });
  });

  write();

  return {
    intervals: intervals.length,
    away: intervals.filter((interval) => interval.state === "away").length,
    home,
  };
}

export interface TimelineQuery {
  readonly since?: number;
  readonly limit?: number;
  /**
   * Which side of now to return.
   *
   * Separate queries rather than one list the caller filters, because "where
   * you have been" and "what is coming" are different questions that want
   * different orderings and belong in different places on a screen.
   */
  readonly tense?: "past" | "future" | "all";
  readonly now?: number;
}

export function presenceTimeline(
  db: DB,
  principalId: string,
  options: TimelineQuery = {},
): readonly PresenceInterval[] {
  const now = options.now ?? Date.now();
  const tense = options.tense ?? "all";

  const clauses = [`principal_id = @principalId`, `(ends_at IS NULL OR ends_at >= @since)`];

  if (tense === "past") {
    clauses.push(`starts_at <= @now`);
  } else if (tense === "future") {
    clauses.push(`starts_at > @now`);
  }

  const rows = db
    .prepare(
      `SELECT * FROM presence
       WHERE ${clauses.join(" AND ")}
       ORDER BY starts_at ASC LIMIT @limit`,
    )
    .all({
      principalId,
      since: options.since ?? 0,
      now,
      limit: options.limit ?? 50,
    }) as PresenceRow[];

  return rows.map((row) => toInterval(row, now));
}

export interface PresenceAnswer {
  readonly interval: PresenceInterval;
  /** How long this state holds from the moment asked about, in days. */
  readonly holdsForDays: number | null;
  /** What ends it, if anything does. */
  readonly endedBy: string | null;
}

/**
 * Where the person is at a moment, and for how long.
 *
 * The second half is the part worth having. "You are home" is barely useful;
 * "you are home, and nothing takes you away for eleven days" is the sentence
 * that lets something else make a decision -- which is exactly the case of a
 * return flight followed by an empty week.
 */
export function presenceAt(db: DB, principalId: string, at: number): PresenceAnswer | null {
  const row = db
    .prepare(
      `SELECT * FROM presence
       WHERE principal_id = ? AND starts_at <= ?
         AND (ends_at IS NULL OR ends_at > ?)
       ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(principalId, at, at) as PresenceRow | undefined;

  if (row === undefined) {
    return null;
  }

  const interval = toInterval(row, at);

  if (interval.endsAt === null) {
    return { interval, holdsForDays: null, endedBy: null };
  }

  const next = db
    .prepare(
      `SELECT * FROM presence
       WHERE principal_id = ? AND starts_at >= ?
       ORDER BY starts_at ASC LIMIT 1`,
    )
    .get(principalId, interval.endsAt) as PresenceRow | undefined;

  return {
    interval,
    holdsForDays: Math.max(0, Math.round((interval.endsAt - at) / DAY)),
    endedBy:
      next === undefined
        ? null
        : next.state === "away"
          ? `a journey to ${displayOf(next.place)}`
          : "coming home",
  };
}

/**
 * A sentence about where somebody is, for a model or a person to read.
 *
 * Deliberately hedged where the basis is inferred. A layer that says "you are
 * home" with the same confidence whether a flight proved it or nothing
 * contradicted it will eventually be wrong in a way nobody can trace.
 */
export function describePresence(answer: PresenceAnswer): string {
  const { interval, holdsForDays, endedBy } = answer;

  const where =
    interval.state === "away"
      ? `away in ${displayOf(interval.place)}`
      : `at home in ${displayOf(interval.place)}`;

  const hedge = interval.basis === "inferred" ? "probably " : "";

  if (holdsForDays === null) {
    return `${hedge}${where}, with nothing saying that changes`;
  }

  const until = endedBy === null ? "" : `, until ${endedBy}`;

  return `${hedge}${where} for about ${String(holdsForDays)} more days${until}`;
}

export { displayOf as describePlace };
