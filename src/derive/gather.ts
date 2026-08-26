/**
 * Gathering: deciding what belongs to a frame.
 *
 * This is the inversion the milestone is for, so it is worth stating plainly
 * against what it replaces.
 *
 * **Before.** Draw an edge between any two nodes that resemble each other, then
 * take connected components. Membership was transitive: a node joined a
 * situation by resembling *some other member*, not by having anything to do
 * with the situation. That is single-linkage clustering, and it chains. A text
 * about a restaurant links to a calendar entry about the restaurant, which
 * links to another text that mentions the same street, which links to a mail
 * about a parking ticket, and the "situation" is now four unrelated things with
 * a true sentence attached to every hop. Every guard against that -- a size
 * ceiling, a required spine kind, a two-source minimum -- attacks the symptom
 * and costs real stories on the way.
 *
 * **Now.** A frame states what it is about: a place, a span of days, a set of
 * people, a set of identifiers. Every candidate is scored against *the frame's
 * anchors*, never against another member. Nothing is transitive, so nothing
 * chains, and the size ceiling stops being load-bearing: a trip with sixty
 * pieces of evidence is a well-evidenced trip rather than a runaway component.
 *
 * The scoring is additive with one hard rule on top: two independent kinds of
 * evidence, or one decisive kind. That rule is the whole quality control. A
 * shared rare word alone can never admit anything, which is precisely the
 * failure mode the old `about_same` linker produced most of the graph from.
 */
import { anchorFrequency, anchorsForAll, holdersOf } from "../store/anchors.js";
import { nodeKey } from "../store/nodes.js";
import { withinSpan } from "./dates.js";
import type { DB } from "../kernel/db.js";
import type { GraphNode, NodeRef, NodeResolver } from "../store/nodes.js";
import type { Anchor } from "./anchors.js";
import type { Frame } from "./frames.js";
import type { NoiseIndex } from "./noise.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * How far back a trip reaches for its own planning.
 *
 * Four months, and the length is the point. The old content window was sixty
 * days with a rule that one shared word beyond thirty was coincidence, which
 * meant a conversation that opened "are you actually coming out to boston in
 * august" two months before the flight was structurally unreachable. It was
 * also the single most informative message in the store.
 *
 * A window this wide is only affordable because the frame supplies the context
 * a pair could not. "Mentions Boston, sixty-two days before a flight to Boston,
 * with someone who is on the trip" is not a coincidence at any distance. The
 * window is wide because the evidence is specific, not instead of it.
 */
const TRIP_LEAD_MS = 120 * DAY;
const TRIP_TAIL_MS = 14 * DAY;

/** An occasion is planned over days, not months. */
const OCCASION_LEAD_MS = 21 * DAY;
const OCCASION_TAIL_MS = 5 * DAY;

/**
 * How long before departure counts as getting ready.
 *
 * This window is the reason "pack laptop" works, and it is a different kind of
 * evidence from everything else here: not what the reminder says, but where it
 * sits. A task three hours before a flight is about the flight even when it
 * shares no word with it, and no amount of text comparison will ever discover
 * that, because there is nothing in common to discover.
 *
 * The old `tracks` linker could not have found it under any tuning. It required
 * two content words of five or more characters from the reminder to appear in
 * the other node; "pack laptop" yields exactly one such word, so the pair was
 * rejected by arithmetic before any judgement was made.
 */
const PREP_WINDOW_MS = 30 * HOUR;

/**
 * What a reminder has to look like before position alone admits it.
 *
 * Position was made sufficient on its own to rescue "pack laptop", and as a
 * general rule it is indefensible. On a real store every reminder inside three
 * days of any occasion joined it: a note about a zucchini brought home from
 * work, a note to check whether a domain was available, somebody's birthday.
 * Each one arrived carrying the sentence "three days before it starts, which is
 * getting ready for it", which is the worst kind of wrong output -- confident,
 * specific, and false.
 *
 * The thing that actually distinguished "pack laptop" was never that it was
 * nearby. It was that packing is what you do *for* something. So a reminder
 * joins on position when it is shaped like preparation and sits within a day or
 * so; otherwise it needs corroboration like anything else.
 *
 * Getting this wrong in the other direction is cheap: a genuine preparation
 * task phrased unusually is missed, and the story is slightly thinner. Getting
 * it wrong in this direction is expensive, because it teaches somebody that the
 * reasoning is decorative.
 */
const PREPARATION_SHAPED =
  /\b(?:pack|packing|bring|grab|take|charge|print|download|confirm|check\s?in|book|reserve|rent|buy|pick\s?up|drop\s?off|return|laundry|cash|passport|visa|ticket|tickets|boarding|itinerary|directions|gas|snacks|cooler|sunscreen|swimsuit|towel|charger|adapter|headphones|meds|prescription|sitter|feed|water\s+the|key|keys|address|code)\b/i;

/** And how close it has to be for that shape to be enough. */
const PREP_POSITIONAL_MS = 26 * HOUR;

/**
 * How long before something a conversation counts as arranging it.
 *
 * Two windows, because "this is evidence" and "this is enough on its own" are
 * different questions and collapsing them costs one or the other. Inside the
 * tight window a conversation is admitted on position alone -- the messages
 * sorting out arrival times name nothing and there is no second kind of
 * evidence to ask for. Between the two it still counts, at the same weight,
 * but something else has to corroborate: a person who is going, a place that
 * matches, a subject the occasion is already known to be about.
 *
 * A day and a half out is where plans actually get made. A reminder three days
 * early is still preparation; a text three days early is usually about
 * something else, which is why this stays well short of the window for tasks.
 */
const CHATTER_PREP_MS = 14 * HOUR;
const CHATTER_WINDOW_MS = 36 * HOUR;

/** And how long after getting back still belongs to the trip. */
const AFTERMATH_WINDOW_MS = 48 * HOUR;

/** Score needed to join, when the evidence is ordinary. */
const ADMIT_SCORE = 0.6;

/** Kinds of evidence needed alongside that score. */
const ADMIT_KINDS = 2;

/** A single piece of evidence this strong admits on its own. */
const DECISIVE_SCORE = 0.95;

/** Nothing gathers more than this. A story is evidence, not an archive. */
const MAX_MEMBERS = 60;

/**
 * A place on more than this share of the store is where you live.
 *
 * Home is on everything and therefore distinguishes nothing. Discounted rather
 * than excluded, because "Philadelphia" on a restaurant booking during a
 * Philadelphia weekend is still worth something.
 */
const UBIQUITOUS_PLACE_SHARE = 0.05;

/**
 * What a place is worth once you are standing in it.
 *
 * The subtlest false positive this design has, and it took a fixture to find:
 * during the Boston trip, a cold sales text mentioning the Boston area scored
 * "mentions Boston" plus "was said during it" and walked straight in. Both
 * statements are true and the conclusion is wrong.
 *
 * The reason is that co-location is not evidence. While you are in Boston,
 * *everything* around you mentions Boston, so the anchor stops discriminating
 * at exactly the moment it looks strongest. Naming the destination weeks
 * beforehand is a real signal; naming it while you are there is small talk.
 */
const CO_LOCATED_PLACE_POINTS = 0.15;

export type MemberRole = "spine" | "evidence" | "preparation" | "aftermath";

export interface Contribution {
  /** The kind of evidence. Distinct kinds are what the admission rule counts. */
  readonly kind: string;
  readonly points: number;
  /** A sentence a person can check. */
  readonly evidence: string;
}

export interface Member {
  readonly ref: NodeRef;
  readonly role: MemberRole;
  readonly score: number;
  readonly contributions: readonly Contribution[];
}

export interface Rejection {
  readonly ref: NodeRef;
  readonly title: string | null;
  readonly score: number;
  readonly reason: string;
  readonly contributions: readonly Contribution[];
}

export interface GatherResult {
  readonly frame: Frame;
  readonly members: readonly Member[];
  /** Near misses, for `harbor story --why`. Only populated when asked for. */
  readonly rejected: readonly Rejection[];
}

export interface GatherContext {
  readonly resolver: NodeResolver;
  readonly noise: NoiseIndex;
  readonly selfEntityId: string | null;
  /** Where the person lives, so a frame can tell "away" from "here". */
  readonly home?: string | null | undefined;
  /** Keep near misses. Costs memory, so only the explain path asks. */
  readonly explain?: boolean;
}

function leadFor(frame: Frame): number {
  return frame.kind === "trip" ? TRIP_LEAD_MS : OCCASION_LEAD_MS;
}

function tailFor(frame: Frame): number {
  return frame.kind === "trip" ? TRIP_TAIL_MS : OCCASION_TAIL_MS;
}

/**
 * Everything worth scoring against one frame.
 *
 * Built from anchor lookups rather than by scanning a time window, because the
 * window is four months wide and most of what is in it has nothing to do with
 * the trip. The exceptions are deliberate: nodes inside the span itself and
 * tasks just before it are pulled in by time alone, since those are the two
 * cases where a thing can belong without saying anything that would find it.
 */
function poolFor(db: DB, frame: Frame, context: GatherContext): ReadonlySet<string> {
  const pool = new Set<string>();
  const spine = new Set(frame.spine.map(nodeKey));

  const admit = (ref: NodeRef): void => {
    const key = nodeKey(ref);

    if (!spine.has(key)) {
      pool.add(key);
    }
  };

  // Identifiers reach across any distance in time. A booking made in March and
  // a boarding pass in August share a record locator and nothing else.
  for (const anchor of frame.anchors) {
    if (anchor.kind !== "ref") {
      continue;
    }

    for (const holder of holdersOf(db, "ref", anchor.value)) {
      admit(holder.ref);
    }
  }

  const from = frame.spanStartsAt - leadFor(frame);
  const to = frame.spanEndsAt + tailFor(frame);

  const inWindow = (ref: NodeRef): boolean => {
    const node = context.resolver.node(ref);

    return node !== null && node.occurredAt >= from && node.occurredAt <= to;
  };

  for (const anchor of frame.anchors) {
    if (anchor.kind === "ref") {
      continue;
    }

    // Topics are hints and are capped hard, because a common-ish word will
    // return its whole posting list and none of it can join on that alone.
    const limit = anchor.kind === "topic" ? 60 : 300;

    for (const holder of holdersOf(db, anchor.kind, anchor.value, limit)) {
      if (inWindow(holder.ref)) {
        admit(holder.ref);
      }
    }
  }

  // Anything at all that happened during the occasion.
  const during = db
    .prepare(
      `SELECT i.id AS id FROM items i
       JOIN streams s ON s.id = i.stream_id
       WHERE i.deleted_at IS NULL AND s.connector_id NOT IN ('imessage')
         AND i.occurred_at BETWEEN @from AND @to
       ORDER BY i.occurred_at LIMIT 300`,
    )
    .all({ from: frame.spanStartsAt - PREP_WINDOW_MS, to: frame.spanEndsAt + AFTERMATH_WINDOW_MS }) as {
    id: string;
  }[];

  for (const row of during) {
    admit({ kind: "item", id: row.id });
  }

  const episodes = db
    .prepare(
      `SELECT id FROM episodes
       WHERE starts_at BETWEEN @from AND @to
       ORDER BY starts_at LIMIT 300`,
    )
    .all({ from: frame.spanStartsAt - PREP_WINDOW_MS, to: frame.spanEndsAt + AFTERMATH_WINDOW_MS }) as {
    id: string;
  }[];

  for (const row of episodes) {
    admit({ kind: "episode", id: row.id });
  }

  return pool;
}

interface Scored {
  readonly ref: NodeRef;
  readonly node: GraphNode;
  readonly score: number;
  readonly kinds: ReadonlySet<string>;
  readonly contributions: readonly Contribution[];
  readonly role: MemberRole;
  /** Admitted on where it sits rather than what it says. */
  readonly positional: boolean;
}

/**
 * How much one candidate belongs to one frame, and why.
 *
 * Every branch that adds points also adds a sentence. That is not politeness:
 * an unexplained score cannot be argued with, and the entire reason this layer
 * is trustworthy is that a person can read the reasoning and say "no, that is
 * a different Boston".
 */
function score(
  db: DB,
  frame: Frame,
  ref: NodeRef,
  anchors: readonly Anchor[],
  context: GatherContext,
  corpusSize: number,
): Scored | null {
  const node = context.resolver.node(ref);

  if (node === null) {
    return null;
  }

  const contributions: Contribution[] = [];
  const kinds = new Set<string>();
  let total = 0;

  const add = (kind: string, points: number, evidence: string): void => {
    contributions.push({ kind, points, evidence });
    kinds.add(kind);
    total += points;
  };

  const frameRefs = new Set(
    frame.anchors.filter((a) => a.kind === "ref").map((a) => a.value),
  );
  const framePlaces = new Set(
    frame.anchors.filter((a) => a.kind === "place").map((a) => a.value),
  );
  const framePeople = new Set(
    frame.anchors.filter((a) => a.kind === "person").map((a) => a.value),
  );
  const frameTopics = new Map(
    frame.anchors.filter((a) => a.kind === "topic").map((a) => [a.value, a]),
  );

  for (const anchor of anchors) {
    if (anchor.kind === "ref" && frameRefs.has(anchor.value)) {
      add("ref", 1, `carries ${anchor.display}, the same reference as the booking`);
    }
  }

  const inSpan = withinSpan(node.occurredAt, frame.spanStartsAt, frame.spanEndsAt, HOUR);

  let placeMatched = false;

  for (const anchor of anchors) {
    if (anchor.kind !== "place" || !framePlaces.has(anchor.value)) {
      continue;
    }

    placeMatched = true;

    const frequency = anchorFrequency(db, "place", anchor.value);
    const ubiquitous = frequency > Math.max(20, corpusSize * UBIQUITOUS_PLACE_SHARE);
    const coLocated = inSpan && anchor.value === frame.place;

    if (ubiquitous) {
      add("place", 0.15, `mentions ${anchor.display}, which is on a lot of your things`);
    } else if (coLocated) {
      add(
        "place",
        CO_LOCATED_PLACE_POINTS,
        `mentions ${anchor.display}, but you were there at the time`,
      );
    } else {
      add("place", 0.5, `mentions ${anchor.display}`);
    }
  }

  // A booking that names the destination.
  //
  // The hotel confirmation shares no identifier with the flights and states no
  // date, so place is the only thing it has, and one kind of evidence is never
  // enough. What makes it different from a newsletter that mentions Boston is
  // that it is transactional: it carries a reservation code. Being a booking is
  // a second, independent kind of claim about the same trip.
  const booking = anchors.some(
    (anchor) =>
      anchor.kind === "ref" &&
      (anchor.value.startsWith("confirmation:") || anchor.value.startsWith("tracking:")),
  );

  if (booking && placeMatched && !kinds.has("ref")) {
    add("booking", 0.45, "is a booking naming where this is");
  }

  // A date the text *states*, as opposed to when the text was written. Someone
  // writing "the 20th through the 24th" in June is describing August, and that
  // sentence is the clearest statement of the trip's shape anywhere.
  for (const anchor of anchors) {
    if (anchor.kind !== "date" || anchor.startsAt === null || anchor.endsAt === null) {
      continue;
    }

    const overlaps =
      anchor.startsAt <= frame.spanEndsAt + DAY && anchor.endsAt >= frame.spanStartsAt - DAY;

    if (overlaps) {
      add("date", 0.45, `names ${anchor.display}, which is when this happens`);
      break;
    }
  }

  let role: MemberRole = "evidence";
  let positional = false;

  // How much a coincident message says about an occasion depends entirely on
  // how long the occasion is.
  //
  // Texting during a four day trip is ambient: you are living your life, and
  // most of what you say has nothing to do with being away. Texting during a
  // three hour dinner is almost certainly about the dinner. The old flat rate
  // treated both as the same weak signal, which is how a conversation about
  // arrival times, sent the afternoon of a weekend away, scored 0.15 and was
  // turned down while the event it was arranging sat two hours later.
  const spanMs = frame.spanEndsAt - frame.spanStartsAt;
  const brief = spanMs <= 36 * HOUR;

  if (inSpan) {
    const heavy = node.kind === "event" || node.kind === "task";

    if (heavy && frame.kind === "trip") {
      // Something you scheduled while you were away.
      //
      // Positional evidence, of the same class as the packing reminder and
      // justified the same way: you were physically in Boston, so a calendar
      // entry that happens there is part of being there. There is no second
      // kind of evidence to ask for, and asking would mean requiring the
      // Red Sox game to also say "Boston", which calendar entries never do.
      //
      // Safe only because repeating entries are filtered before scoring. A
      // standup falls inside the trip week too, and it is not a trip.
      positional = true;
      add("during", 0.5, "is on the calendar while you are away");
    } else if (heavy || brief) {
      add(
        "when",
        heavy ? 0.4 : 0.45,
        heavy ? "happens during it" : "was said while it was happening",
      );
    } else {
      add("when", 0.15, "was said during it");
    }
  }

  if (!inSpan) {
    const beforeBy = frame.spanStartsAt - node.occurredAt;
    const afterBy = node.occurredAt - frame.spanEndsAt;
    const heavy = node.kind === "task" || node.kind === "event";

    // The hours just before something are about it, whatever they contain.
    //
    // For a task this was already true and is what makes "pack laptop" work.
    // It is just as true of a conversation: the messages sorting out who is
    // driving and when they will arrive happen the day before, say nothing a
    // search would find, and are the most useful record of how the thing came
    // together. Conversations get a tighter window than tasks, because a
    // reminder three days early is still preparation and a text three days
    // early is usually about something else.
    const window = heavy ? PREP_WINDOW_MS : CHATTER_WINDOW_MS;

    if (beforeBy > 0 && beforeBy <= window) {
      role = "preparation";

      // What a conversation in the last few hours before something is worth.
      //
      // These messages are how a thing actually gets arranged -- who is
      // driving, what time, bring the paddles -- and they are unfindable by
      // content: they name nothing, because everyone in them already knows what
      // they are talking about. Position is the only evidence there is.
      //
      // It also breaks a deadlock that otherwise leaves thin occasions empty. A
      // calendar entry reading "gute?" carries almost no anchors, so nothing can
      // join it on subject, so it never learns a subject, so nothing ever joins.
      // Admitting the conversation immediately before it is the one move that
      // gets the first fact in the door; everything the frame then knows -- the
      // people, the place -- it learned from that.
      positional = heavy
        ? beforeBy <= PREP_POSITIONAL_MS && PREPARATION_SHAPED.test(node.text)
        : beforeBy <= CHATTER_PREP_MS;

      add(
        "prep",
        heavy ? 0.5 : 0.45,
        positional && heavy
          ? `${describeGap(beforeBy)} beforehand, and reads like getting ready for it`
          : `${describeGap(beforeBy)} before it starts`,
      );
    }

    if (heavy && afterBy > 0 && afterBy <= AFTERMATH_WINDOW_MS) {
      role = "aftermath";
      add("aftermath", 0.3, `${describeGap(afterBy)} after it ends`);
    }
  }

  const people: string[] = [];

  for (const anchor of anchors) {
    if (
      anchor.kind === "person" &&
      framePeople.has(anchor.value) &&
      anchor.value !== context.selfEntityId
    ) {
      people.push(anchor.display);
    }
  }

  if (people.length > 0) {
    // A person the frame learned about from its own evidence is a participant,
    // not a coincidence. Worth more than the flat rate an occasion uses.
    add(
      "person",
      frame.kind === "trip" ? 0.45 : 0.25,
      `is with ${people.slice(0, 3).join(", ")}`,
    );
  }

  const topicWords: string[] = [];

  for (const anchor of anchors) {
    if (anchor.kind !== "topic" || !frameTopics.has(anchor.value)) {
      continue;
    }

    topicWords.push(anchor.display);
  }

  if (topicWords.length > 0) {
    add(
      "topic",
      Math.min(0.5, 0.2 * topicWords.length),
      `mentions ${topicWords.slice(0, 3).join(", ")}`,
    );
  }

  return {
    ref,
    node,
    score: Number(total.toFixed(3)),
    kinds,
    contributions,
    role,
    positional,
  };
}

function describeGap(ms: number): string {
  const hours = Math.round(Math.abs(ms) / HOUR);

  if (hours < 36) {
    return `${String(Math.max(1, hours))} hours`;
  }

  return `${String(Math.round(hours / 24))} days`;
}

/**
 * Whether a scored candidate is in.
 *
 * Three ways, and the third is the interesting one.
 *
 *   A decisive anchor on its own. A shared record locator is not a coincidence
 *   and needs no corroboration.
 *
 *   Enough score from enough *different kinds* of evidence. The kind count is
 *   what stops topic overlap from ever being sufficient: it is one kind, and it
 *   is capped below the admission score, so a node whose only claim is shared
 *   vocabulary cannot get in however many words it shares.
 *
 *   Sitting in a trip's preparation window. Position is the evidence, and there
 *   is no second kind to ask for; requiring one would be requiring the reminder
 *   to also mention Boston, which is exactly what reminders never do.
 */
function admits(
  scored: Scored,
  frame: Frame,
  broadcast: boolean,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  // Mass mail has to be transactional to belong.
  //
  // The rule that let the airline confirmation back in -- automated senders are
  // not noise -- also let in "Top 10 restaurants with a scenic view", which
  // mentioned Philadelphia and shared the word `opentable` with a booking, and
  // therefore cleared the two-kinds bar on nothing at all. Both are mail from a
  // sender nobody replies to; what separates them is that one is *about* a
  // specific trip and carries the identifier to prove it.
  //
  // So a broadcast joins on a reference, or on being a booking that names the
  // place, and never on subject matter. That is the narrowest rule that keeps
  // confirmations and drops circulars, and it costs a marketing email that
  // genuinely was about your weekend, which is a trade worth making.
  if (broadcast && !scored.kinds.has("ref") && !scored.kinds.has("booking")) {
    return {
      ok: false,
      reason: "is mass mail, and nothing in it ties to this beyond the subject",
    };
  }

  if (scored.score >= DECISIVE_SCORE && scored.kinds.has("ref")) {
    return { ok: true };
  }

  // Position. Getting ready for something, or being on the calendar during it.
  // Neither has a second kind of evidence to offer and neither needs one; see
  // the notes at PREP_WINDOW_MS and on the `during` branch.
  //
  // No longer trip-only. A short occasion has the same property and more
  // sharply: the hour before a dinner is about the dinner.
  if (scored.positional) {
    return { ok: true };
  }

  if (frame.kind === "trip" && scored.role === "preparation") {
    return { ok: true };
  }

  // Being with the same person, near the same time, is not evidence.
  //
  // Two weak positives multiply into a confident wrong answer here more than
  // anywhere else in the file. Somebody you text every day will always be
  // "involved", and something is always about to happen, so prep plus person
  // admitted every ordinary exchange in the day before an occasion: a joke
  // about work, a photograph of a dog. Beyond the few hours where position
  // speaks for itself, a conversation has to say something about the occasion --
  // its place, its dates, its subject, its identifiers -- and not merely have
  // happened near it with a familiar name attached.
  const aboutIt = ["place", "date", "topic", "ref", "booking", "during"].some((kind) =>
    scored.kinds.has(kind),
  );

  if (scored.role === "preparation" && !scored.positional && !aboutIt) {
    return {
      ok: false,
      reason: "happened shortly before, but says nothing that ties it to this",
    };
  }

  if (scored.score < ADMIT_SCORE) {
    return {
      ok: false,
      reason: `scored ${scored.score.toFixed(2)}, below the ${String(ADMIT_SCORE)} needed to belong`,
    };
  }

  if (scored.kinds.size < ADMIT_KINDS) {
    const only = [...scored.kinds][0] ?? "nothing";

    return {
      ok: false,
      reason: `only ${only} connects it, and one kind of evidence is never enough on its own`,
    };
  }

  return { ok: true };
}

interface Round {
  readonly admitted: readonly Scored[];
  readonly rejected: readonly Rejection[];
}

/** One pass of pool, score, admit. */
function runRound(
  db: DB,
  frame: Frame,
  context: GatherContext,
  corpusSize: number,
): Round {
  const pool = poolFor(db, frame, context);

  const refs: NodeRef[] = [...pool].map((key) => {
    const split = key.indexOf(":");

    return {
      kind: key.slice(0, split) as NodeRef["kind"],
      id: key.slice(split + 1),
    };
  });

  const anchorsByNode = anchorsForAll(db, refs);

  const admitted: Scored[] = [];
  const rejected: Rejection[] = [];

  for (const ref of refs) {
    // A recurring notification is not a thing that happened, so it never joins
    // a story. Filtered here rather than scored and rejected, because the
    // rejection list is for near misses a person might argue with.
    if (ref.kind === "item" && context.noise.isRepeating(ref.id)) {
      continue;
    }

    const anchors = anchorsByNode.get(nodeKey(ref)) ?? [];
    const scored = score(db, frame, ref, anchors, context, corpusSize);

    if (scored === null) {
      continue;
    }

    const verdict = admits(
      scored,
      frame,
      ref.kind === "item" && context.noise.isBroadcast(ref.id),
    );

    if (verdict.ok) {
      admitted.push(scored);
    } else if (context.explain === true && scored.score > 0) {
      rejected.push({
        ref,
        title: scored.node.title,
        score: scored.score,
        reason: verdict.reason,
        contributions: scored.contributions,
      });
    }
  }

  return { admitted, rejected };
}

/**
 * What the frame learned about itself from its own evidence.
 *
 * A calendar entry for a flight has no attendees. None. So a trip frame starts
 * out knowing where it goes and when, and knowing nothing whatsoever about who
 * is on it -- which means the person test, one of the strongest signals
 * available, can never fire for exactly the frame kind that needs it most.
 *
 * The way out is that the trip finds out who it is with by looking at what it
 * already gathered. A conversation that joined on place and dates names the
 * person you are going to see, and once the frame knows that name it can
 * recognise the other eight conversations with them that said nothing
 * geographic at all.
 *
 * Two rules keep this from running away, and they are the whole reason it is
 * not the chaining this design exists to avoid:
 *
 *   People come only from conversations. Mail participants are senders and
 *   yourself; harvesting them would make the airline a trip participant and
 *   pull in every other itinerary it ever sent.
 *
 *   One round of it, and no more. Enrichment happens once and then scoring is
 *   final. Iterating to a fixed point is precisely how a frame walks off into
 *   the rest of the store one plausible hop at a time.
 */
function enrich(
  db: DB,
  frame: Frame,
  admitted: readonly Scored[],
  context: GatherContext,
): Frame {
  const learned = new Map<string, Anchor>();

  for (const anchor of frame.anchors) {
    learned.set(`${anchor.kind}:${anchor.value}`, anchor);
  }

  let added = 0;

  // Which topics the story is allowed to learn.
  //
  // Not all of them, and the distinction is between a word that names something
  // and a word that happens to be nearby.
  //
  //   A reminder is a note to yourself about an action you take. "pack laptop"
  //   describes you, not the trip. Harvested anyway, "laptop" became a trip
  //   topic on the strength of a reminder that had joined on position alone,
  //   and on the second round that reminder was told it belonged partly because
  //   it mentions laptop. True, circular, and on a real store it would have gone
  //   on to collect every unrelated mail about a laptop.
  //
  //   An event title is the opposite. Somebody typed "Red Sox game" to describe
  //   a real thing they were going to, so its distinctive words name part of the
  //   story and are trustworthy immediately.
  //
  //   Everything else -- mail, conversations -- needs a second member to say the
  //   same word before it counts, because one document's vocabulary is not a
  //   subject.
  const topicCount = new Map<string, number>();
  const topicAnchor = new Map<string, Anchor>();
  const named = new Set<string>();

  for (const scored of admitted) {
    const anchors = anchorsForAll(db, [scored.ref]).get(nodeKey(scored.ref)) ?? [];

    for (const anchor of anchors) {
      const key = `${anchor.kind}:${anchor.value}`;

      if (learned.has(key)) {
        continue;
      }

      // People come only from conversations; see above.
      if (anchor.kind === "person") {
        if (scored.ref.kind !== "episode" || anchor.value === context.selfEntityId) {
          continue;
        }

        learned.set(key, anchor);
        added += 1;
        continue;
      }

      if (anchor.kind === "topic") {
        if (scored.node.kind === "task") {
          continue;
        }

        if (scored.node.kind === "event") {
          named.add(key);
        }

        topicCount.set(key, (topicCount.get(key) ?? 0) + 1);
        topicAnchor.set(key, anchor);
      }
    }
  }

  for (const [key, count] of topicCount) {
    const anchor = topicAnchor.get(key);

    if (anchor === undefined || (count < 2 && !named.has(key))) {
      continue;
    }

    learned.set(key, anchor);
    added += 1;
  }

  // Where it happened, when the thing itself never said.
  //
  // This is the other half of the same problem as the people. A calendar entry
  // reading "gute?" has no location on it, so the frame was placeless, so it
  // could never appear on a timeline of where somebody had been -- while the
  // conversation attached to it said plainly that it was a lakehouse in the
  // Poconos. The story knew and the timeline did not, which is exactly the
  // seam that makes this feel like separate systems rather than one picture.
  //
  // Only from members that joined on something other than the place itself,
  // or the reasoning is circular, and never home: being at home is not
  // somewhere you went.
  let place = frame.place;
  let placeDisplay = frame.placeDisplay;

  if (place === null) {
    const counts = new Map<string, { display: string; n: number }>();

    for (const scored of admitted) {
      const anchors = anchorsForAll(db, [scored.ref]).get(nodeKey(scored.ref)) ?? [];

      for (const anchor of anchors) {
        if (anchor.kind !== "place" || anchor.value === context.home) {
          continue;
        }

        const held = counts.get(anchor.value);

        counts.set(anchor.value, {
          display: anchor.display,
          n: (held?.n ?? 0) + 1,
        });
      }
    }

    let best: { value: string; display: string; n: number } | null = null;

    for (const [value, held] of counts) {
      if (best === null || held.n > best.n) {
        best = { value, display: held.display, n: held.n };
      }
    }

    if (best !== null) {
      place = best.value;
      placeDisplay = best.display;
      added += 1;
    }
  }

  if (added === 0) {
    return frame;
  }

  return { ...frame, anchors: [...learned.values()], place, placeDisplay };
}

/**
 * Everything belonging to one frame.
 *
 * Two rounds: gather on what the frame knows, work out who and what it is
 * about from that, gather once more. Members are sorted by time rather than by
 * score, because a story is read as a sequence and the order it happened in is
 * the order that makes it a story.
 */
export function gather(
  db: DB,
  frame: Frame,
  context: GatherContext,
  corpusSize: number,
): GatherResult {
  const first = runRound(db, frame, context, corpusSize);
  const enriched = enrich(db, frame, first.admitted, context);

  const final = enriched === frame ? first : runRound(db, enriched, context, corpusSize);

  // One more pass over the frame's own description, using everything that ended
  // up in it. Not another round of scoring -- membership is settled -- but the
  // frame handed to the timeline should know what the story knows. Without
  // this, a place named only by a member admitted on the second round is
  // learned by nobody, which is the seam this whole change is about closing.
  const settled = enrich(db, enriched, final.admitted, context);

  const members: Member[] = frame.spine.map((ref) => ({
    ref,
    role: "spine" as const,
    score: 1,
    contributions: [{ kind: "spine", points: 1, evidence: "this is the thing itself" }],
  }));

  // Best evidence first when trimming to the ceiling, then back into time
  // order for reading.
  const admitted = [...final.admitted].sort((a, b) => b.score - a.score);

  for (const scored of admitted.slice(0, MAX_MEMBERS)) {
    members.push({
      ref: scored.ref,
      role: scored.role,
      score: scored.score,
      contributions: scored.contributions,
    });
  }

  const times = new Map<string, number>();

  for (const member of members) {
    const node = context.resolver.node(member.ref);
    times.set(nodeKey(member.ref), node?.occurredAt ?? 0);
  }

  members.sort((a, b) => (times.get(nodeKey(a.ref)) ?? 0) - (times.get(nodeKey(b.ref)) ?? 0));

  const rejected = [...final.rejected].sort((a, b) => b.score - a.score);

  return { frame: settled, members, rejected: rejected.slice(0, 25) };
}

export { ADMIT_SCORE, ADMIT_KINDS, PREP_WINDOW_MS, MAX_MEMBERS };
