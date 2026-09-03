/**
 * Frames: the thing a story is a story *about*.
 *
 * A frame is a hypothesis with a shape. Not "these nodes are similar" but "a
 * journey happened, from here to there, between these two moments, and these
 * people were on it". The shape is what lets everything else be judged against
 * something concrete instead of against whichever node happened to be nearby.
 *
 * Two frame kinds are built here.
 *
 *   **trip**      A journey away and, where there is one, the journey back. The
 *                 flagship, because a trip is the case where a person's life is
 *                 genuinely spread across every source at once: a booking in
 *                 mail, a flight on the calendar, an itinerary argued out over
 *                 two months of texts, and a reminder to pack the night before.
 *                 Nothing in the old design could assemble that, and the reason
 *                 was never tuning. It was that a trip has a *span*, and a
 *                 pairwise similarity graph has no way to represent one.
 *
 *   **occasion**  A calendar entry that is not travel. Dinner, a game, an
 *                 appointment. Narrower and far more common.
 *
 * The round-trip pairing is the part worth reading. Two flights are not two
 * stories; they are the ends of one. Getting that right is what makes the
 * return leg mean "and then I was home", which is the whole basis of the
 * presence timeline in presence.ts.
 */
import { anchorsByKind, valuesOf } from "./anchors.js";
import { mentionsTravel, placeById, placesIn, routesIn } from "./places.js";
import { anchorsFor } from "../store/anchors.js";
import { timezone } from "../kernel/time.js";
import { planFrames } from "./plan-frames.js";
import { NodeResolver, nodeKey } from "../store/nodes.js";
import type { DB } from "../kernel/db.js";
import type { GraphNode, NodeRef } from "../store/nodes.js";
import type { Anchor } from "./anchors.js";
import type { NoiseIndex } from "./noise.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * Bump to rebuild every story from anchors that are already on disk.
 *
 * Separate from ANCHOR_VERSION on purpose: changing how stories are assembled
 * should not cost a re-scan of text, and changing how text is read should.
 */
export const STORY_VERSION = 1;

export type FrameKind = "trip" | "occasion" | "plan";

/**
 * What a plan frame knows that no other frame kind does.
 *
 * Kept as its own object rather than widened into `Frame` because every field
 * here is meaningless for a journey, and three optional properties on the type
 * every frame shares is how a type stops describing anything.
 */
export interface PlanDetail {
  /** The conversation it was arranged in. */
  readonly episodeId: string;
  /** The words that proposed it. */
  readonly proposal: string;
  /** Everyone who said yes, the user included, by entity id where known. */
  readonly going: readonly { readonly id: string; readonly name: string }[];
  /** What the plan itself said about when, before anything resolved it. */
  readonly openedAt: number;
  readonly statedTime: string | null;
  /** Set once something narrower answered the question the plan left open. */
  readonly resolvedBy: NodeRef | null;
  readonly resolvedDisplay: string | null;
  readonly venuePhrases: readonly string[];
}

export interface Frame {
  /**
   * A natural key for this frame within one pass.
   *
   * Not the story id. Story ids are minted once and carried across rebuilds by
   * membership overlap, exactly as situations are, because an identity derived
   * from contents changes when the contents do and that is the one property an
   * identity may not have.
   */
  readonly key: string;
  readonly kind: FrameKind;
  readonly title: string | null;
  /** Canonical place id the frame is centred on. */
  readonly place: string | null;
  readonly placeDisplay: string | null;
  /** The occasion itself: departure to return, or the event's own hours. */
  readonly spanStartsAt: number;
  readonly spanEndsAt: number;
  /** Nodes that constitute the frame rather than merely belonging to it. */
  readonly spine: readonly NodeRef[];
  readonly anchors: readonly Anchor[];
  /** True when a journey out was found with no journey back. */
  readonly openEnded: boolean;
  /** Present only on a plan, or on an occasion that absorbed one. */
  readonly plan?: PlanDetail | undefined;
}

interface Journey {
  readonly ref: NodeRef;
  readonly node: GraphNode;
  readonly at: number;
  readonly endsAt: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly anchors: readonly Anchor[];
}

/** Vocabulary that makes a calendar entry a journey rather than a meeting. */
const JOURNEY_WORDS =
  /\b(?:flight|flights|fly|flying|depart|departs|departure|arrive|arrives|arrival|airport|airline|nonstop|layover|train|amtrak|rail|drive\s+to|driving\s+to|road\s?trip)\b/i;

/**
 * How far apart the two halves of a round trip may be.
 *
 * Was forty-five days, on the theory that the place-mirroring constraint was
 * doing the real work. On a real calendar it was not: a Boston weekend paired
 * with a return leg twenty-seven days later, because the true return had been
 * consumed by a duplicate of the outbound and the next thing heading home was a
 * different trip entirely. Twenty-one days covers a long holiday and refuses to
 * span two of them.
 */
const RETURN_WINDOW_MS = 21 * DAY;

/** A journey with no return leg is assumed to last this long, for scoring. */
const OPEN_TRIP_MS = 4 * DAY;

/**
 * Journeys landing within this of each other, on the same route, are one leg.
 *
 * The same flight arrives in Harbor more than once and there is nothing wrong
 * with any of the copies: the airline mails an itinerary, the airline's calendar
 * feed publishes an entry, and a second calendar the person subscribes to
 * publishes it again. Undeduplicated, each copy became its own outbound and
 * paired with a different copy of the return, which is how one weekend in
 * Chicago became three identical trips sitting on top of each other.
 */
const SAME_LEG_MS = 12 * HOUR;

/**
 * How near a calendar leg has to be before mail describing the same trip is
 * treated as commentary rather than as a journey of its own.
 *
 * A week, because a confirmation's stated dates and the calendar entry the
 * airline generated should agree to the day, and when they do not it is the
 * email that has been misread.
 */
const CALENDAR_COVERS_MS = 7 * DAY;

/**
 * Every journey leg the store can see.
 *
 * Calendar events first, because an airline-generated calendar entry is the
 * most reliable statement of a journey that exists: it has a real departure
 * time, it usually names the route, and nobody wrote it by hand.
 *
 * Mail second, and deliberately only mail that both names a route and carries a
 * flight identifier. A marketing email from an airline mentions cities and
 * dates constantly, and admitting it here would invent a trip a month.
 */
function journeysIn(
  db: DB,
  resolver: NodeResolver,
  noise: NoiseIndex,
  since: number,
): readonly Journey[] {
  const journeys: Journey[] = [];
  const seen = new Set<string>();

  const consider = (ref: NodeRef, fromMail: boolean): void => {
    if (seen.has(nodeKey(ref))) {
      return;
    }

    const node = resolver.node(ref);

    if (node === null) {
      return;
    }

    const text = node.text;

    if (!JOURNEY_WORDS.test(text) && !mentionsTravel(node.title ?? "")) {
      return;
    }

    const anchors = anchorsFor(db, ref);
    const routes = routesIn(text);
    const hasFlight = anchors.some(
      (anchor) => anchor.kind === "ref" && anchor.value.startsWith("flight:"),
    );

    // A journey you take repeatedly is still a journey every time.
    //
    // Caught on a store of forty thousand items: the recurrence detector counts
    // calendar entries sharing a title, and somebody who flies Philadelphia to
    // Denver six times a year has six entries called "Flight PHL to DEN". Every
    // one of them was written off as a template and the store produced zero
    // trips. A standup and a flight look identical to a title counter.
    //
    // What tells them apart is that a journey names a route or carries a flight
    // number, and a recurring meeting does neither. So repetition only
    // disqualifies an event that has no such evidence; with it, the event is a
    // journey however many times it has happened before.
    if (!fromMail && routes.length === 0 && !hasFlight && noise.isRepeating(ref.id)) {
      return;
    }

    // When a leg happens, which is not the same as when the item arrived.
    //
    // A calendar entry's timestamp *is* the departure. An email's timestamp is
    // when it landed in the mailbox, which for a confirmation is typically a
    // month early, and using it made the trip appear to start the day the
    // booking was made. That is not a tuning problem; a leg without a real
    // departure time is not a leg, so mail only produces one when it states a
    // date, and the stated date is what is used.
    let at = node.occurredAt;
    let endsAt = node.endsAt ?? node.occurredAt + 2 * HOUR;

    if (fromMail) {
      if (!hasFlight) {
        return;
      }

      // Which of a confirmation's many dates is the departure.
      //
      // A booking email is dense with them: when you booked, when to check in
      // by, when the fare rules expire, when each leg flies. Taking the
      // earliest picked one of the others, and a Boston weekend that the
      // calendar put on the 6th started on the 3rd because the email said so
      // somewhere.
      //
      // Two constraints, both of which are just what the word "departure"
      // means. It has not already happened when the confirmation arrives, and
      // it is written as a real date rather than a bare ordinal, since "the
      // 20th" in a fare rule is not a flight.
      const dated = anchors
        .filter(
          (anchor) =>
            anchor.kind === "date" &&
            anchor.startsAt !== null &&
            anchor.startsAt >= node.occurredAt - DAY &&
            anchor.confidence >= 0.8,
        )
        .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0))[0];

      if (dated?.startsAt === undefined || dated.startsAt === null) {
        return;
      }

      at = dated.startsAt;
      endsAt = dated.endsAt ?? dated.startsAt;
    }

    let from: string | null = null;
    let to: string | null = null;

    const route = routes[0];

    if (route !== undefined) {
      from = route.from.id;
      to = route.to.id;
    } else {
      // No explicit route. A single named place on a journey is a destination
      // far more often than an origin, because people write down where they
      // are going. Two places with no direction stated are left undirected
      // rather than guessed: a wrong direction inverts the presence timeline,
      // which is worse than not having one.
      const places = placesIn(text);

      if (places.length === 1) {
        to = places[0]?.id ?? null;
      } else if (places.length >= 2) {
        from = places[0]?.id ?? null;
        to = places[1]?.id ?? null;
      }
    }

    if (to === null && from === null) {
      return;
    }

    seen.add(nodeKey(ref));

    journeys.push({ ref, node, at, endsAt, from, to, anchors });
  };

  const events = db
    .prepare(
      `SELECT id FROM items
       WHERE kind = 'event' AND deleted_at IS NULL AND occurred_at >= ?
       ORDER BY occurred_at ASC`,
    )
    .all(since) as { id: string }[];

  for (const row of events) {
    consider({ kind: "item", id: row.id }, false);
  }

  // Everything above came from the calendar, which is the authority on when a
  // journey happened. Remember what it covers before letting mail add to it.
  const fromCalendar = [...journeys];

  const mail = db
    .prepare(
      `SELECT DISTINCT i.id FROM items i
       JOIN node_anchors a ON a.node_id = i.id AND a.node_kind = 'item'
       WHERE i.kind = 'message' AND i.deleted_at IS NULL AND i.occurred_at >= ?
         AND a.kind = 'ref' AND a.value LIKE 'flight:%'
       ORDER BY i.occurred_at ASC`,
    )
    .all(since) as { id: string }[];

  for (const row of mail) {
    consider({ kind: "item", id: row.id }, true);
  }

  // A confirmation is *about* a journey; the calendar entry *is* one.
  //
  // This is the distinction the layer was missing, and it is the one that
  // produced three overlapping Boston trips out of one weekend. Mail and
  // calendar were competing on equal footing, so a booking email and the flight
  // it booked each defined their own trip with their own boundaries, and the
  // email's boundaries were a guess assembled from whichever dates it happened
  // to contain.
  //
  // Mail may still define a journey -- plenty of trips never reach a calendar --
  // but only where the calendar is silent. Where both speak, the calendar wins
  // and the email becomes what it always was: evidence about a trip somebody
  // else already established.
  const kept = journeys.filter((journey) => {
    if (fromCalendar.includes(journey)) {
      return true;
    }

    return !fromCalendar.some(
      (leg) =>
        leg.to === journey.to && Math.abs(leg.at - journey.at) <= CALENDAR_COVERS_MS,
    );
  });

  return dedupe(kept.sort((a, b) => a.at - b.at));
}

/**
 * One leg per departure, however many sources published it.
 *
 * Keyed on the route and the departure hour rather than on the item, because
 * the copies are genuinely different records: different ids, different streams,
 * different titles, sometimes a timestamp minutes apart. What makes them the
 * same leg is that they describe one aeroplane.
 *
 * The copy that carries a flight number wins, since it is the one that can
 * still connect to the booking that produced it.
 */
function dedupe(journeys: readonly Journey[]): readonly Journey[] {
  const best = new Map<string, Journey>();

  for (const journey of journeys) {
    const key = `${journey.from ?? "?"}>${journey.to ?? "?"}:${String(
      Math.round(journey.at / SAME_LEG_MS),
    )}`;

    const held = best.get(key);

    if (held === undefined) {
      best.set(key, journey);
      continue;
    }

    const hasRef = (candidate: Journey): boolean =>
      candidate.anchors.some((anchor) => anchor.kind === "ref");

    if (hasRef(journey) && !hasRef(held)) {
      best.set(key, journey);
    }
  }

  return [...best.values()].sort((a, b) => a.at - b.at);
}

/**
 * Where the person lives, as far as the journeys can tell.
 *
 * The place that is most often departed from and most often returned to. This
 * is inferred rather than configured on purpose: asking someone to set their
 * home city is a setup step that will be skipped, and the answer is sitting in
 * the data.
 *
 * Ties and empty stores fall back to the origin of the earliest journey, which
 * is right far more often than it is wrong and is never catastrophic: getting
 * home wrong makes a trip's direction odd, not its membership.
 */
export function homePlace(journeys: readonly Journey[]): string | null {
  const score = new Map<string, number>();

  for (const journey of journeys) {
    if (journey.from !== null) {
      score.set(journey.from, (score.get(journey.from) ?? 0) + 1);
    }

    if (journey.to !== null) {
      score.set(journey.to, (score.get(journey.to) ?? 0) + 1);
    }
  }

  // A round trip contributes each end exactly once, so two legs leave home and
  // the destination tied. The tie-break is that you set off from home: the
  // origin of the earliest journey wins, which is right on a real store for the
  // same reason it is right here, and is deterministic either way.
  const firstOrigin = journeys[0]?.from ?? null;

  let best: string | null = null;
  let bestScore = 0;

  for (const [place, count] of [...score.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wins = count > bestScore || (count === bestScore && place === firstOrigin);

    if (wins) {
      bestScore = count;
      best = place;
    }
  }

  return best ?? firstOrigin;
}

/**
 * Journeys paired into trips.
 *
 * An outbound leg is one whose destination is not home. Its return is the next
 * leg that heads back to home, or that departs from where the outbound landed.
 * Consuming both means a four-leg holiday is two trips rather than one, which
 * is a limitation and the honest one: without knowing the person's intent,
 * two separate destinations really are two stories.
 */
function pairJourneys(
  journeys: readonly Journey[],
  home: string | null,
): readonly { readonly out: Journey; readonly back: Journey | null }[] {
  const pairs: { out: Journey; back: Journey | null }[] = [];
  const used = new Set<string>();

  for (const out of journeys) {
    if (used.has(nodeKey(out.ref))) {
      continue;
    }

    // A leg that goes home is a return with no outbound in view, which happens
    // constantly at the edge of the history window. Not a trip on its own.
    if (out.to !== null && home !== null && out.to === home) {
      continue;
    }

    if (out.to === null) {
      continue;
    }

    used.add(nodeKey(out.ref));

    // The best return, not the first one that fits.
    //
    // Taking the first match meant a weak signal that happened to be early beat
    // a strong one that was correct: any leg heading home inside the window
    // won, including the outbound of somebody's next trip. Departing from where
    // this leg landed is much better evidence than merely pointing home, so the
    // candidates are ranked and the nearest of the strongest wins.
    let back: Journey | null = null;
    let bestRank = 0;

    for (const candidate of journeys) {
      if (used.has(nodeKey(candidate.ref)) || candidate.at <= out.at) {
        continue;
      }

      if (candidate.at - out.at > RETURN_WINDOW_MS) {
        break;
      }

      const leavesDestination = candidate.from !== null && candidate.from === out.to;
      const returnsHome = home !== null && candidate.to === home;
      const mirrors = out.from !== null && candidate.to === out.from;

      const rank = leavesDestination && (returnsHome || mirrors)
        ? 3
        : leavesDestination
          ? 2
          : returnsHome || mirrors
            ? 1
            : 0;

      if (rank > bestRank) {
        bestRank = rank;
        back = candidate;
      }

      if (bestRank === 3) {
        break;
      }
    }

    if (back !== null) {
      used.add(nodeKey(back.ref));
    }

    pairs.push({ out, back });
  }

  return pairs;
}

function mergeAnchors(sets: readonly (readonly Anchor[])[]): readonly Anchor[] {
  const found = new Map<string, Anchor>();

  for (const set of sets) {
    for (const anchor of set) {
      const key = `${anchor.kind}:${anchor.value}`;
      const existing = found.get(key);

      if (existing === undefined || existing.confidence < anchor.confidence) {
        found.set(key, anchor);
      }
    }
  }

  return [...found.values()];
}

/**
 * Trip frames, one per journey out.
 *
 * The span runs from departure to the return's arrival. When there is no return
 * the span is left short and the frame is marked open-ended, which is what the
 * presence layer reads to say "away, and nothing says you came back".
 */
function tripFrames(
  db: DB,
  resolver: NodeResolver,
  noise: NoiseIndex,
  since: number,
): readonly Frame[] {
  const journeys = journeysIn(db, resolver, noise, since);

  if (journeys.length === 0) {
    return [];
  }

  const home = homePlace(journeys);
  const frames: Frame[] = [];

  for (const { out, back } of pairJourneys(journeys, home)) {
    const destination = out.to;

    if (destination === null || destination === home) {
      continue;
    }

    const place = placeById(destination);
    const spine = back === null ? [out.ref] : [out.ref, back.ref];

    const spanStartsAt = out.at;
    const spanEndsAt = back === null ? out.at + OPEN_TRIP_MS : back.endsAt;

    frames.push({
      key: `trip:${destination}:${String(spanStartsAt)}`,
      kind: "trip",
      title: place === null ? out.node.title : `${place.display} trip`,
      place: destination,
      placeDisplay: place?.display ?? null,
      spanStartsAt,
      spanEndsAt,
      spine,
      anchors: mergeAnchors([
        // Topics are dropped from a journey's own anchors. A flight's
        // vocabulary is "flight", "departs" and a time of day, which is true of
        // every journey anyone has ever taken and tells two of them apart never.
        // What a trip is *about* is learned in gather.ts from the evidence it
        // pulls in, not asserted here from a calendar title.
        out.anchors.filter((anchor) => anchor.kind !== "topic"),
        (back?.anchors ?? []).filter((anchor) => anchor.kind !== "topic"),
        [
          {
            kind: "place",
            value: destination,
            display: place?.display ?? destination,
            startsAt: null,
            endsAt: null,
            confidence: 0.95,
          },
        ],
      ]),
      openEnded: back === null,
    });
  }

  return mergeOverlapping(frames);
}

/**
 * Trips to one place that overlap in time are one trip.
 *
 * Deduplicating legs stops the same *flight* becoming two journeys. It does not
 * stop two genuinely different legs -- an outbound on the calendar and a second
 * one recovered from a booking email with slightly different dates -- from each
 * anchoring a trip to the same city on overlapping days. On a real store that
 * left three Boston trips for one weekend: Aug 3-9, Aug 5-9, Aug 6-10.
 *
 * Nobody is in Boston three times at once, so overlap plus a shared destination
 * is a contradiction rather than a coincidence, and the resolution is to keep
 * one trip carrying every spine.
 *
 * The surviving boundaries are the narrowest, not the union. A span is a claim
 * about when somebody was away, and widening it on the strength of the least
 * reliable member is how a four-day weekend became a week -- which then reaches
 * further back for evidence and pulls in more that does not belong. When the
 * sources disagree the tightest reading is the one least likely to be wrong.
 */
function mergeOverlapping(frames: readonly Frame[]): readonly Frame[] {
  const ordered = [...frames].sort((a, b) => a.spanStartsAt - b.spanStartsAt);
  const merged: Frame[] = [];

  for (const frame of ordered) {
    const previous = merged[merged.length - 1];

    const overlaps =
      previous !== undefined &&
      previous.place === frame.place &&
      frame.spanStartsAt <= previous.spanEndsAt;

    if (previous === undefined || !overlaps) {
      merged.push(frame);
      continue;
    }

    const spine = [...previous.spine];

    for (const ref of frame.spine) {
      if (!spine.some((held) => nodeKey(held) === nodeKey(ref))) {
        spine.push(ref);
      }
    }

    merged[merged.length - 1] = {
      ...previous,
      spanStartsAt: Math.max(previous.spanStartsAt, frame.spanStartsAt),
      spanEndsAt: Math.min(previous.spanEndsAt, frame.spanEndsAt),
      spine,
      anchors: mergeAnchors([previous.anchors, frame.anchors]),
      // Only open ended if nothing anywhere said when it finished.
      openEnded: previous.openEnded && frame.openEnded,
    };
  }

  return merged;
}

/**
 * How far apart two calendar entries can be and still be one occasion.
 *
 * A wedding is a welcome party on the Friday, a ceremony on the Saturday
 * afternoon and a reception on the Saturday evening, and on a real store those
 * were three stories plus a fourth called "Graber wedding" -- four cards for one
 * weekend, none of which said it was a wedding. Nobody experiences that as four
 * things.
 *
 * Contiguity alone is not enough to merge, or a week of unrelated weekday
 * meetings becomes one blob. The entries also have to share a place or a person,
 * which is what distinguishes a weekend somebody is spending together from a
 * calendar that merely has things on it.
 */
const OCCASION_GAP_MS = 20 * HOUR;

/**
 * Occasions that are really one occasion.
 *
 * Merged before gathering rather than after, so the combined frame gathers once
 * against everything it is about. Merging afterwards would mean each part had
 * already competed with the others for the same evidence.
 */
function clusterOccasions(frames: readonly Frame[]): readonly Frame[] {
  const ordered = [...frames].sort((a, b) => a.spanStartsAt - b.spanStartsAt);
  const merged: Frame[] = [];

  const peopleOf = (frame: Frame): ReadonlySet<string> =>
    new Set(frame.anchors.filter((a) => a.kind === "person").map((a) => a.value));

  for (const frame of ordered) {
    const previous = merged[merged.length - 1];

    if (previous === undefined) {
      merged.push(frame);
      continue;
    }

    const contiguous = frame.spanStartsAt - previous.spanEndsAt <= OCCASION_GAP_MS;

    if (!contiguous) {
      merged.push(frame);
      continue;
    }

    const samePlace =
      previous.place !== null && frame.place !== null && previous.place === frame.place;

    const theirs = peopleOf(frame);
    const shared = [...peopleOf(previous)].some((id) => theirs.has(id));

    if (!samePlace && !shared) {
      merged.push(frame);
      continue;
    }

    merged[merged.length - 1] = {
      ...previous,
      spanEndsAt: Math.max(previous.spanEndsAt, frame.spanEndsAt),
      spine: [...previous.spine, ...frame.spine],
      anchors: mergeAnchors([previous.anchors, frame.anchors]),
      place: previous.place ?? frame.place,
      placeDisplay: previous.placeDisplay ?? frame.placeDisplay,
    };
  }

  return merged;
}

/** An event shorter than this is a note to self, not an occasion. */
const MIN_TITLE_LENGTH = 3;

/**
 * Occasion frames: calendar entries that are not journeys.
 *
 * Deliberately not every calendar entry. A recurring standup is a template and
 * a story about it would be noise forty times a month, so the noise index
 * decides here exactly as it does for the graph.
 */
function occasionFrames(
  db: DB,
  resolver: NodeResolver,
  noise: NoiseIndex,
  since: number,
  claimed: ReadonlySet<string>,
  tripSpans: readonly (readonly [number, number])[],
): readonly Frame[] {
  const rows = db
    .prepare(
      `SELECT id FROM items
       WHERE kind = 'event' AND deleted_at IS NULL AND occurred_at >= ?
       ORDER BY occurred_at ASC`,
    )
    .all(since) as { id: string }[];

  const frames: Frame[] = [];

  for (const row of rows) {
    const ref: NodeRef = { kind: "item", id: row.id };

    if (claimed.has(nodeKey(ref)) || noise.isRepeating(row.id)) {
      continue;
    }

    const node = resolver.node(ref);

    if (node === null || (node.title ?? "").trim().length < MIN_TITLE_LENGTH) {
      continue;
    }

    // An occasion inside a journey is not a separate story.
    //
    // A ball game in Boston during the Boston trip is a thing that happened on
    // the trip, and promoting it to a story of its own splits one week of
    // someone's life into a trip they took and an unrelated evening they spent.
    // Worse, because a spine node always wins the competition in gather.ts, the
    // game would take itself out of the trip on the way past.
    //
    // Suppressed rather than merged afterwards, so that precedence lives in one
    // place: the frame kind that explains more of the calendar claims what it
    // explains, exactly as trips claim their own flights.
    const inTrip = tripSpans.some(([start, end]) => node.occurredAt >= start && node.occurredAt <= end);

    if (inTrip) {
      continue;
    }

    const anchors = anchorsFor(db, ref);
    const places = valuesOf(anchors, "place");
    const place = [...places][0] ?? null;

    frames.push({
      key: `occasion:${row.id}`,
      kind: "occasion",
      title: node.title,
      place,
      placeDisplay: place === null ? null : (placeById(place)?.display ?? null),
      spanStartsAt: node.occurredAt,
      spanEndsAt: node.endsAt ?? node.occurredAt + 2 * HOUR,
      spine: [ref],
      anchors,
      openEnded: false,
    });
  }

  return frames;
}

export interface FrameReport {
  readonly trips: number;
  readonly occasions: number;
  /** Plans read out of conversation. Zero of these existed before v0.52. */
  readonly plans: number;
  /** Of those, how many something in the store pinned to an hour. */
  readonly plansResolved: number;
  readonly home: string | null;
}

export interface DetectedFrames {
  readonly frames: readonly Frame[];
  readonly report: FrameReport;
}

/**
 * Every frame in the store, trips first.
 *
 * Trips run first and claim their journey legs so that a flight does not also
 * become an occasion. The ordering is the whole of the precedence rule: a
 * frame kind that explains more of the calendar wins the nodes it explains.
 */
export function detectFrames(
  db: DB,
  noise: NoiseIndex,
  options: {
    readonly since?: number | undefined;
    /** Needed to read a time of day. Defaults to the machine's own. */
    readonly timezone?: string | undefined;
    readonly now?: number | undefined;
  } = {},
): DetectedFrames {
  const resolver = new NodeResolver(db);
  const since = options.since ?? 0;
  const tz = options.timezone ?? timezone();

  const trips = tripFrames(db, resolver, noise, since);

  const claimed = new Set<string>();

  for (const frame of trips) {
    for (const ref of frame.spine) {
      claimed.add(nodeKey(ref));
    }
  }

  const occasions = clusterOccasions(occasionFrames(
    db,
    resolver,
    noise,
    since,
    claimed,
    trips.map((frame) => [frame.spanStartsAt, frame.spanEndsAt] as const),
  ));
  const journeys = journeysIn(db, resolver, noise, since);

  // Plans last, and folded into the calendar rather than competing with it.
  //
  // Precedence here is the same rule as everywhere else in this file: the
  // frame kind that explains more of the record claims what it explains. A
  // calendar entry for the same evening is a better spine than a conversation,
  // because somebody wrote it down deliberately -- so where both exist, the
  // occasion survives and takes the plan's roster with it. Two cards for one
  // Thursday night is the wedding failure again, and it was four cards then.
  const plans = planFrames(db, noise, {
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.now === undefined ? {} : { now: options.now }),
    timezone: tz,
  });

  const standalone: Frame[] = [];
  const absorbed = new Map<string, Frame>();

  for (const plan of plans) {
    const host = occasions.find(
      (occasion) =>
        plan.spanStartsAt <= occasion.spanEndsAt && plan.spanEndsAt >= occasion.spanStartsAt,
    );

    if (host === undefined) {
      standalone.push(plan);
      continue;
    }

    const held = absorbed.get(host.key) ?? host;

    absorbed.set(host.key, {
      ...held,
      spine: [...held.spine, ...plan.spine.filter((ref) => ref.kind === "episode")],
      anchors: mergeAnchors([held.anchors, plan.anchors]),
      plan: plan.plan,
    });
  }

  const merged = occasions.map((occasion) => absorbed.get(occasion.key) ?? occasion);

  return {
    frames: [...trips, ...merged, ...standalone],
    report: {
      trips: trips.length,
      occasions: merged.length,
      plans: plans.length,
      plansResolved: plans.filter((frame) => frame.plan?.resolvedBy != null).length,
      home: homePlace(journeys),
    },
  };
}

export { anchorsByKind, valuesOf };
