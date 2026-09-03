/**
 * Anchors: what a thing is *about*, in kinds a machine can compare.
 *
 * This file is the change the rest of the milestone rests on, so it is worth
 * being explicit about what was wrong before it.
 *
 * The relationship layer asked one question of every pair of nodes: do these
 * two texts share a word that is rare in this store? That is a coincidence
 * detector wearing the costume of a semantic one. It has no notion of what the
 * shared word *is*, so it cannot tell "both mention Boston" from "both mention
 * quarterly", and it has no notion of what a thing is about, so it cannot
 * notice that a calendar entry reading "Flight PHL to BOS" and a text reading
 * "landing at logan around 9am" are the same fact written twice with no word in
 * common at all.
 *
 * An anchor is a typed claim about a node: it happens at this place, it is about
 * this span of days, it carries this identifier, it involves this person. Two
 * nodes sharing an anchor share something specific, and the kind of the anchor
 * says how much that is worth. A shared identifier is near-proof. A shared place
 * is strong. A shared topic word is a hint, and only ever a hint, which is
 * exactly the demotion the old design could not express because topic overlap
 * was the only evidence it had.
 *
 * The anchors are also what makes an explanation readable. "Both mention
 * Boston, and this falls inside the trip window" is a sentence about the world.
 * "Both mention `fenway`, from different sources, 21 days apart" is a sentence
 * about a search index.
 */
import { datesIn } from "./dates.js";
import { anchorsOfPlan, readPlans, venuesIn, normalizeVenue } from "./plans.js";
import { timeHintsIn } from "./timing.js";
import { localityIn, mentionsTravel, placesIn, routesIn } from "./places.js";
import { entitiesOfNode } from "../store/nodes.js";
import type { DB } from "../kernel/db.js";
import type { GraphNode } from "../store/nodes.js";
import type { TermIndex } from "./terms.js";
import type { NameIndex } from "./mentions.js";

/**
 * Bump to re-extract every anchor from stored text.
 *
 * Independent of RELATIONSHIP_VERSION and of STORY_VERSION, for the reason
 * every other version column here exists separately: improving a place name
 * should cost a re-scan of text that is already on disk, and improving the way
 * stories are assembled should not.
 *
 * 2: people named in text became anchors, font stacks and tracking ids stopped
 * being topics, and person anchors started carrying a name rather than an
 * entity id. Every one of those changes what a node claims to be about, so the
 * anchors already on disk are wrong rather than merely older -- and the failure
 * mode of forgetting to bump this is the quiet one, where a rebuild appears to
 * run and nothing improves because nothing was re-read.
 *
 * 3: times of day, venues, plans and rosters. Every node in the store gains a
 * time_hint where it states an hour, which is a claim nothing could previously
 * make: dates.ts reads days and returns midnight, so a confirmation saying
 * 8:00 PM contributed the date and discarded the only part of it anybody cares
 * about on the evening in question.
 */
export const ANCHOR_VERSION = 3;

export type AnchorKind =
  | "place"
  | "date"
  | "ref"
  | "person"
  | "topic"
  | "route"
  /** A plan somebody proposed and others agreed to. Only ever on an episode. */
  | "plan"
  /** Somebody who said yes to a plan, as opposed to somebody who was present. */
  | "going"
  /** A time of day, as an interval. See timing.ts for why it is not a date. */
  | "time_hint"
  /** A place the gazetteer will never hold: a bar, a restaurant, a friend's house. */
  | "venue";

export interface Anchor {
  readonly kind: AnchorKind;
  /** Canonical, comparable. Two spellings of one thing give one value. */
  readonly value: string;
  /** What was actually written, or a readable form. For evidence lines. */
  readonly display: string;
  /** For dates: the span claimed. Null everywhere else. */
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly confidence: number;
}

/**
 * Airline codes, for reading a flight number with no keyword in front of it.
 *
 * The old reference extractor required the literal word "flight" immediately
 * before the code, which meant it read `Flight AA 4608` in an email and read
 * nothing at all from a calendar entry titled "Flight PHL to BOS" with `AA
 * 1783` in the body, because between the keyword and the code sat the route.
 * On the probe store that single gap cost the strongest edge available: the
 * airline's own confirmation and the calendar entry it created shared a flight
 * number and were never connected by it.
 *
 * A two-letter code plus digits is far too loose to accept unconditionally, so
 * it is accepted when the letters name a real carrier or when travel vocabulary
 * is present. Both together is not required; either alone is enough signal.
 */
const AIRLINES = new Set([
  "AA", "AC", "AF", "AS", "AV", "AY", "AZ", "BA", "B6", "BR", "CX", "CM", "DL",
  "EI", "EK", "EY", "F9", "FI", "G4", "HA", "IB", "JL", "KE", "KL", "LA", "LH",
  "LX", "NH", "NK", "OS", "OZ", "QF", "QR", "SK", "SQ", "SN", "SY", "TK", "TP",
  "TS", "UA", "UX", "VS", "VX", "WN", "WS", "Y4", "ZG",
]);

const FLIGHT_BARE = /\b([A-Z]{2})\s?(\d{2,4})\b/g;
const FLIGHT_KEYED = /\b(?:flight|flt)\s*#?\s*([A-Z]{2})\s?(\d{2,4})\b/gi;

const CONFIRMATION =
  /\b(?:confirmation|booking|reservation|order|itinerary|record\s+locator|pnr)\s*(?:number|code|#|no\.?)?\s*:?\s*([A-Z0-9]{6,})\b/gi;

const TRACKING = /\b(?:tracking|shipment)\s*#?\s*:?\s*(1Z[0-9A-Z]{16}|\d{10,22})\b/gi;

const MEETING = /\b(?:zoom\.us\/j\/(\d{9,})|meet\.google\.com\/([a-z]{3,}-[a-z]{3,}-[a-z]{3,}))/gi;

/** Captured by a pattern, but an English word rather than an identifier. */
const NOT_A_REFERENCE =
  /^(CONFIRMATION|BOOKING|RESERVATION|ITINERARY|ORDER|NUMBER|LOCATOR|DETAILS|SUMMARY)$/;

/**
 * Every identifier in a piece of text.
 *
 * Shared with the reference index so that the graph and the story layer cannot
 * disagree about what an identifier is. They disagreed once already, in the
 * cheapest possible way: two copies of a regular expression, one of which was
 * improved.
 */
export function referencesIn(text: string): readonly { readonly kind: string; readonly value: string }[] {
  if (text.trim().length === 0) {
    return [];
  }

  const found = new Map<string, { kind: string; value: string }>();

  const record = (kind: string, raw: string): void => {
    const value = raw.replace(/\s+/g, "").toUpperCase();

    if (value.length < 5 || !/\d/.test(value) || NOT_A_REFERENCE.test(value)) {
      return;
    }

    found.set(`${kind}:${value}`, { kind, value });
  };

  for (const match of text.matchAll(FLIGHT_KEYED)) {
    record("flight", `${match[1] ?? ""}${match[2] ?? ""}`);
  }

  const travel = mentionsTravel(text);

  for (const match of text.matchAll(FLIGHT_BARE)) {
    const carrier = (match[1] ?? "").toUpperCase();

    if (!AIRLINES.has(carrier) && !travel) {
      continue;
    }

    // A bare pair of capitals and digits inside a longer token is not a flight
    // number, and neither is a US state followed by a house number. Requiring
    // the carrier to be real removes most of it; requiring at least two digits
    // removes the rest.
    record("flight", `${carrier}${match[2] ?? ""}`);
  }

  for (const match of text.matchAll(CONFIRMATION)) {
    record("confirmation", match[1] ?? "");
  }

  for (const match of text.matchAll(TRACKING)) {
    record("tracking", match[1] ?? "");
  }

  for (const match of text.matchAll(MEETING)) {
    record("meeting", match[1] ?? match[2] ?? "");
  }

  return [...found.values()];
}

/** How many topic anchors one node may contribute. Topics are hints, not facts. */
const MAX_TOPICS = 10;

/**
 * Words that are rare in a mailbox without being about anything.
 *
 * The term index measures rarity, and rarity is a good proxy for meaning right
 * up until the corpus is full of HTML. On a real store a trip to Boston listed
 * `roboto`, `montserrat`, `pura` and `fb2605914` among the subjects it was
 * about: font stacks out of an inline stylesheet and a tracking id out of a
 * pixel. Every one of them is genuinely rare, and none of them is a topic.
 *
 * These are cheap to exclude and expensive to leave in, because a marketing
 * email joins a story on two of them and then reads as evidence.
 */
const BOILERPLATE = new Set([
  "roboto", "montserrat", "helvetica", "arial", "verdana", "georgia", "tahoma",
  "lato", "raleway", "oswald", "merriweather", "poppins", "inter", "nunito",
  "webkit", "moz", "sans", "serif", "monospace", "rgba", "nbsp", "doctype",
  "stylesheet", "viewport", "padding", "margin", "font", "colspan", "cellpadding",
  "cellspacing", "valign", "bgcolor", "href", "img", "src", "alt", "utm",
  "unsubscribe", "preferences", "newsletter", "privacy", "trademarks",
  "copyright", "reserved", "disclaimer", "viewing", "browser", "click",
  "webview", "mailto", "noreply", "donotreply", "pixel", "beacon", "tracking",
]);

/**
 * Whether a term is a word rather than an identifier.
 *
 * Anything mixing letters and digits is a code of some kind -- an order number,
 * a campaign id, a flight number that the reference extractor has already read
 * properly as a reference. As a *topic* it is noise, and worse than noise: it
 * is rare by construction, so it scores as though it were meaningful.
 */
function looksLikeWord(term: string): boolean {
  if (BOILERPLATE.has(term)) {
    return false;
  }

  if (/\d/.test(term)) {
    return false;
  }

  // No vowel at all, past four characters, is an acronym or a hash fragment.
  return term.length <= 4 || /[aeiouy]/.test(term);
}

export interface AnchorContext {
  readonly terms: TermIndex;
  /**
   * The user's timezone, because a time of day is meaningless without one.
   *
   * Optional so that callers testing extraction in isolation need not supply
   * it; every real pass does, and the fallback is UTC, which is wrong by
   * exactly the offset and would put an evening plan on the wrong day.
   */
  readonly timezone?: string | undefined;
  /**
   * People this store knows, so a name in a sentence can reach the person.
   *
   * Optional only so that callers testing extraction in isolation need not
   * build one; every real pass passes it, and without it a node knows who was
   * on it and not who it was about.
   */
  readonly names?: NameIndex | undefined;
}

/**
 * Everything a node claims to be about.
 *
 * Order is not significant and duplicates are collapsed by kind and value, so a
 * node that says "Boston" four times anchors on Boston once. That matters more
 * than it sounds: scoring counts distinct anchors, and a node that repeated
 * itself would otherwise outscore a node that said something once and meant it.
 */
export function anchorsOf(db: DB, node: GraphNode, context: AnchorContext): readonly Anchor[] {
  const found = new Map<string, Anchor>();

  const put = (anchor: Anchor): void => {
    const key = `${anchor.kind}:${anchor.value}`;
    const existing = found.get(key);

    if (existing === undefined || existing.confidence < anchor.confidence) {
      found.set(key, anchor);
    }
  };

  const text = node.text;

  for (const place of placesIn(text)) {
    put({
      kind: "place",
      value: place.id,
      display: place.display,
      startsAt: null,
      endsAt: null,
      confidence: 0.8,
    });
  }

  // Towns named in an address, which the gazetteer will never contain and which
  // both calendar connectors already write into the body as a `Location:` line.
  // Higher confidence than a name found in running prose, because an address
  // field is somebody stating where a thing is rather than mentioning a place.
  for (const place of localityIn(text)) {
    put({
      kind: "place",
      value: place.id,
      display: place.display,
      startsAt: null,
      endsAt: null,
      confidence: 0.85,
    });
  }

  for (const route of routesIn(text)) {
    put({
      kind: "route",
      value: `${route.from.id}>${route.to.id}`,
      display: `${route.from.display} to ${route.to.display}`,
      startsAt: null,
      endsAt: null,
      confidence: 0.9,
    });
  }

  for (const date of datesIn(text, node.occurredAt)) {
    put({
      kind: "date",
      value: `${String(date.startsAt)}-${String(date.endsAt)}`,
      display: date.matched,
      startsAt: date.startsAt,
      endsAt: date.endsAt,
      confidence: date.confidence,
    });
  }

  for (const reference of referencesIn(text)) {
    put({
      kind: "ref",
      value: `${reference.kind}:${reference.value}`,
      display: reference.value,
      startsAt: null,
      endsAt: null,
      confidence: 0.95,
    });
  }

  // A person anchor compares by entity id and displays by name. Storing the id
  // in both fields made every explanation read "involves e_2dbdfe6a1bf3558d45e5",
  // which is a true statement nobody can check.
  const nameOf = db.prepare(`SELECT display_name AS name FROM entities WHERE id = ?`);

  const self = (
    db.prepare(`SELECT id FROM entities WHERE kind = 'self' LIMIT 1`).get() as
      | { id: string }
      | undefined
  )?.id;

  for (const entityId of entitiesOfNode(db, node.ref)) {
    const row = nameOf.get(entityId) as { name: string | null } | undefined;

    put({
      kind: "person",
      value: entityId,
      display: row?.name ?? entityId,
      startsAt: null,
      endsAt: null,
      confidence: 0.7,
    });
  }

  // Who the text names, as opposed to who it was sent to.
  //
  // The same anchor kind as a participant on purpose. "Going with Luther" and a
  // thread whose header is Jake Luther are two statements about one person, and
  // treating them as different kinds of fact is what kept them apart.
  for (const mention of context.names?.mentions(text) ?? []) {
    if (mention.entityId === self) {
      continue;
    }

    put({
      kind: "person",
      value: mention.entityId,
      display: mention.displayName,
      startsAt: null,
      endsAt: null,
      confidence: mention.confidence,
    });
  }

  // Times of day, on every node.
  //
  // Not confined to conversations, and that is the point: the reason a plan
  // can be resolved at all is that a restaurant's confirmation states an hour,
  // and until now the only thing read out of it was the day.
  for (const hint of timeHintsIn(text, node.occurredAt, context.timezone ?? "UTC")) {
    put({
      kind: "time_hint",
      value: hint.value,
      display: hint.display,
      startsAt: hint.startsAt,
      endsAt: hint.endsAt,
      confidence: hint.confidence,
    });
  }

  // Places the gazetteer cannot hold.
  //
  // `places.ts` is eighty-eight US cities, hand-checked, and it is the right
  // shape for a trip: a journey goes to a city. An evening goes to a bar with
  // a proper name that no gazetteer will ever contain, and the correct failure
  // for that has been to treat it as an ordinary topic word, which capped what
  // it could be worth at a hint.
  for (const phrase of venuesIn(text)) {
    put({
      kind: "venue",
      value: normalizeVenue(phrase),
      display: phrase,
      startsAt: null,
      endsAt: null,
      confidence: 0.6,
    });
  }

  // And, on a conversation only, what was arranged in it.
  if (node.ref.kind === "episode") {
    // A name on a roster has to reach the person, or the roster is a list of
    // strings and every downstream question about who is going has to do
    // string matching against display names. `entities` is the only thing that
    // knows "Dave" and "Dave Mullen" are one person.
    const byName = db.prepare(
      `SELECT id FROM entities WHERE LOWER(display_name) = LOWER(?) LIMIT 1`,
    );

    for (const plan of readPlans(text, node.occurredAt, context.timezone ?? "UTC", node.ref.id)) {
      for (const anchor of anchorsOfPlan(plan)) {
        if (anchor.kind !== "going" || !anchor.value.startsWith("name:")) {
          put(anchor);
          continue;
        }

        // "Me" is the user, and the user is on their own roster. Saying an
        // evening is with three people when it is with three people and you is
        // a small wrongness that reads as a large one.
        const resolved =
          anchor.display.toLowerCase() === "me"
            ? self
            : (byName.get(anchor.display) as { id: string } | undefined)?.id;

        put({ ...anchor, value: resolved ?? anchor.value });
      }
    }
  }

  let topics = 0;

  for (const term of context.terms.distinctive(text)) {
    if (topics >= MAX_TOPICS) {
      break;
    }

    // A word that is also a place is already anchored as one, and counting it
    // twice would let a single mention of "Boston" satisfy the rule that says
    // two independent kinds of evidence are needed.
    if (found.has(`place:${term}`) || !looksLikeWord(term)) {
      continue;
    }

    put({
      kind: "topic",
      value: term,
      display: term,
      startsAt: null,
      endsAt: null,
      confidence: Math.min(0.6, 0.2 + context.terms.weight(term) / 30),
    });

    topics += 1;
  }

  return [...found.values()];
}

/** Anchors of one kind, as a set of values. The shape scoring wants. */
export function valuesOf(anchors: readonly Anchor[], kind: AnchorKind): ReadonlySet<string> {
  const values = new Set<string>();

  for (const anchor of anchors) {
    if (anchor.kind === kind) {
      values.add(anchor.value);
    }
  }

  return values;
}

export function anchorsByKind(anchors: readonly Anchor[], kind: AnchorKind): readonly Anchor[] {
  return anchors.filter((anchor) => anchor.kind === kind);
}
