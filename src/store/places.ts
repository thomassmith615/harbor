/**
 * Places as entities.
 *
 * `places.ts` is a gazetteer of eighty-eight US cities, hand-checked, and it is
 * the right shape for a journey: a trip goes to a city, cities are a closed set
 * at the resolution that matters, and a false positive there is loud. It is the
 * wrong shape for an evening. An evening goes to a bar with a proper name that
 * no gazetteer will ever contain, and Harbor's answer to that was to treat the
 * name as an ordinary topic word, which capped what it could be worth at a
 * hint.
 *
 * The consequence shows up in the graph rather than in search. Every linker
 * judges on a shared word, a shared person, or a shared identifier. Two nodes
 * about the same bar under two different names have none of the three: "the
 * bar" and "Great American Pub" share no token, and both `bar` and `pub` are
 * three letters, below the term index floor, so neither could be a token
 * anyway. The pair is generated and rejected, correctly, by every rule
 * available.
 *
 * Making a place an entity fixes that by changing what is being compared. Once
 * both nodes carry the same place id, a venue match is an exact join on a
 * primary key, the evidence line is "both are about Great American Pub", and
 * the person reading it can check it. That is the same move `entities.ts`
 * already made for people, where "Dave", "dave@work.com" and "+1 610 555 0182"
 * became one thing that nodes point at rather than three strings nodes
 * contain.
 *
 * ## How a venue phrase becomes a place
 *
 * Conservatively, and never on a common noun alone. "the bar" is not a place;
 * it is a reference to one, and which one depends entirely on who is speaking
 * and when. A place entity is only ever created from a name somebody could look
 * up: a proper noun with more than one token, or a single distinctive token
 * that appears with an address.
 *
 * A common-noun phrase is resolved rather than created. "the bar" attaches to a
 * place when something else in the same evening names one, which is exactly
 * what the plan resolver already does with time, and it stays unresolved
 * otherwise. An unresolved reference is the honest outcome for a conversation
 * that never said where.
 *
 * ## What this is not
 *
 * Not geocoding. Harbor has no coordinates, no map, no distance function, and
 * this file adds none. A place here is a name, its aliases, an address if
 * anybody stated one, and the nodes that mention it. That is enough to join on
 * and enough to say a true sentence about, which is the bar every claim in this
 * store has to clear.
 */
import { createEntity, findByIdentifier, upsertIdentifier } from "./entities.js";
import { recordAttribute } from "./attributes.js";
import { normalizeVenue, venueTokens } from "../derive/plans.js";
import type { DB } from "../kernel/db.js";
import type { Entity } from "./entities.js";

/**
 * Words that name a category of place rather than a place.
 *
 * A phrase made only of these is a reference, not a name, and must never become
 * an entity. The failure this prevents is the loud one: a single place called
 * "the bar" accumulating every unrelated evening in the store and asserting
 * they were all at the same venue.
 */
const COMMON_NOUNS = new Set([
  "bar", "pub", "tavern", "brewery", "restaurant", "diner", "cafe", "coffee",
  "shop", "club", "gym", "course", "range", "office", "house", "place", "game",
  "park", "beach", "airport", "station", "hotel", "store", "market", "mall",
  "school", "church", "hospital", "theater", "theatre", "stadium", "arena",
]);

/** Corporate suffixes that carry no distinguishing information. */
const SUFFIXES = new Set(["inc", "llc", "ltd", "co", "the", "and", "of", "at"]);

export function isCommonNounVenue(phrase: string): boolean {
  const tokens = normalizeVenue(phrase).split(" ").filter((token) => token.length > 0);

  return tokens.length > 0 && tokens.every((token) => COMMON_NOUNS.has(token));
}

/**
 * Whether a phrase is a name somebody could look up.
 *
 * Two content tokens, or one plus a category word. "Great American Pub" and
 * "Brennans" qualify; "the bar" and "a place" do not. Deliberately strict: a
 * place entity created from a phrase that is not a name is a magnet that
 * silently collects unrelated evenings, and there is no cheap way to notice it
 * afterwards.
 */
export function isNameableVenue(phrase: string): boolean {
  if (isCommonNounVenue(phrase)) {
    return false;
  }

  const tokens = normalizeVenue(phrase)
    .split(" ")
    .filter((token) => token.length >= 3 && !SUFFIXES.has(token));

  if (tokens.length === 0) {
    return false;
  }

  const distinctive = tokens.filter((token) => !COMMON_NOUNS.has(token));

  if (distinctive.length >= 2) {
    return true;
  }

  // One distinctive token plus a category word: "Brennans Bar". A lone
  // distinctive token ("Brennans") is accepted only if it is long enough to be
  // unlikely to collide, since a three letter proper noun and an abbreviation
  // are indistinguishable here.
  return distinctive.length === 1 && (tokens.length >= 2 || (distinctive[0]?.length ?? 0) >= 6);
}

/** The key a place is looked up by. Aliases all resolve to the same entity. */
function placeKey(phrase: string): string {
  return normalizeVenue(phrase)
    .split(" ")
    .filter((token) => token.length > 0 && !SUFFIXES.has(token))
    .join(" ");
}

export interface PlaceMatch {
  readonly entity: Entity;
  /** How the phrase reached this place, for an evidence line. */
  readonly via: "exact" | "alias" | "tokens";
}

/**
 * Finds the place a phrase names, if the store already knows it.
 *
 * Three attempts, weakest last. Token overlap is the one that earns its keep:
 * it is what makes "Great American" and "the Great American Pub" the same
 * place without either being written down as an alias of the other, and it
 * requires every content token of the shorter phrase to appear in the longer,
 * so "American Legion" does not match "Great American Pub".
 */
export function findPlace(db: DB, phrase: string): PlaceMatch | null {
  const key = placeKey(phrase);

  if (key.length === 0) {
    return null;
  }

  const exact = findByIdentifier(db, "name", key);

  if (exact !== null && exact.kind === "place") {
    return { entity: exact, via: "exact" };
  }

  const wanted = venueTokens(phrase);

  if (wanted.size === 0) {
    return null;
  }

  const rows = db
    .prepare(
      `SELECT e.id AS id, i.normalized AS name
       FROM entities e
       JOIN identifiers i ON i.entity_id = e.id AND i.kind = 'name'
       WHERE e.kind = 'place' AND e.merged_into IS NULL`,
    )
    .all() as { id: string; name: string }[];

  for (const row of rows) {
    const held = venueTokens(row.name);

    if (held.size === 0) {
      continue;
    }

    const [shorter, longer] = wanted.size <= held.size ? [wanted, held] : [held, wanted];

    let covered = true;

    for (const token of shorter) {
      if (!longer.has(token)) {
        covered = false;
        break;
      }
    }

    // One shared token is a coincidence unless it is the whole of both names.
    if (covered && (shorter.size >= 2 || wanted.size === held.size)) {
      const entity = findByIdentifier(db, "name", row.name);

      if (entity !== null) {
        return { entity, via: shorter === wanted ? "tokens" : "alias" };
      }
    }
  }

  return null;
}

export interface PlaceObservation {
  readonly phrase: string;
  readonly address?: string | null;
  readonly sourceKind?: string | null;
  readonly sourceId?: string | null;
  readonly observedAt: number;
  readonly confidence?: number;
}

/**
 * Finds or creates the place a phrase names.
 *
 * Returns null for anything that is a reference rather than a name, which is
 * the common case in conversation and is not a failure. The caller records an
 * unresolved venue anchor and something else in the same evening resolves it,
 * or nothing does.
 */
export function observePlace(db: DB, observation: PlaceObservation): Entity | null {
  const existing = findPlace(db, observation.phrase);

  if (existing !== null) {
    remember(db, existing.entity.id, observation);

    return existing.entity;
  }

  if (!isNameableVenue(observation.phrase)) {
    return null;
  }

  const entity = createEntity(db, "place", observation.phrase.trim(), `place:${placeKey(observation.phrase)}`);

  upsertIdentifier(db, {
    entityId: entity.id,
    kind: "name",
    value: observation.phrase.trim(),
    normalized: placeKey(observation.phrase),
    confidence: observation.confidence ?? 0.7,
    seenAt: observation.observedAt,
  });

  remember(db, entity.id, observation);

  return entity;
}

function remember(db: DB, entityId: string, observation: PlaceObservation): void {
  if (observation.address === undefined || observation.address === null) {
    return;
  }

  recordAttribute(db, {
    entityId,
    kind: "address",
    value: observation.address,
    confidence: 0.8,
    origin: "stated",
    sourceKind: observation.sourceKind ?? null,
    sourceId: observation.sourceId ?? null,
    observedAt: observation.observedAt,
  });
}

/**
 * Adds a name a place is also known by.
 *
 * The path by which "the bar" becomes findable: it is never an alias on its
 * own, but once a plan has resolved to a venue, the words that conversation
 * actually used are worth keeping against that place for the *next*
 * conversation. Common nouns are refused, permanently, for the reason at the
 * top of this file.
 */
export function addPlaceAlias(db: DB, entityId: string, phrase: string, at: number): boolean {
  if (isCommonNounVenue(phrase) || !isNameableVenue(phrase)) {
    return false;
  }

  const key = placeKey(phrase);
  const held = findByIdentifier(db, "name", key);

  if (held !== null && held.id !== entityId) {
    // The name already belongs to somebody else. Merging two places is a
    // decision with evidence behind it, and this function does not have any.
    return false;
  }

  upsertIdentifier(db, {
    entityId,
    kind: "name",
    value: phrase.trim(),
    normalized: key,
    confidence: 0.6,
    seenAt: at,
  });

  return true;
}
