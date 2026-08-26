/**
 * Places, and turning six ways of saying one into a single anchor.
 *
 * The relationship layer had no idea what a place was. It compared texts for
 * rare words, so "BOS", "Boston", and "Logan" were three unrelated tokens, and
 * the one that mattered most was actively suppressed: `logan` is also a
 * person's name, so the term index refused to let it carry an edge. Correct, on
 * its own terms, and it meant a flight to Boston could not find a conversation
 * about Boston.
 *
 * A place anchor fixes that by asking a different question. Not "is this word
 * rare" but "does this word name somewhere, and is it being used that way
 * here". `logan` next to `airport` or `flight` is a place; `logan` on its own in
 * a text from a stranger is a name, and stays one.
 *
 * The gazetteer is deliberately small and hand-checked rather than generated.
 * A big list of every populated place on earth turns "Nice", "Mobile", "Reading"
 * and "Of" into locations, and the false positives from that are far more
 * expensive than the coverage is worth. What is here is: airports a US traveller
 * actually uses, the cities they serve, and the states. Anything else gets
 * picked up as an ordinary topic term, which is the correct fallback.
 */

/** A canonical place, plus every way it might be written. */
interface PlaceEntry {
  /** The canonical key. Lowercase, no spaces: `new_york`. */
  readonly id: string;
  readonly display: string;
  /** IATA codes that resolve here. Matched case-sensitively as bare tokens. */
  readonly codes: readonly string[];
  /** Names and nicknames. Matched case-insensitively as whole words. */
  readonly names: readonly string[];
  /**
   * Names that are also ordinary words or common given names, and only count
   * as a place when travel vocabulary is nearby.
   *
   * This is the "logan" list, and it is the whole reason place extraction is
   * better than rare-word matching rather than just different from it.
   */
  readonly ambiguous?: readonly string[];
}

const PLACES: readonly PlaceEntry[] = [
  { id: "philadelphia", display: "Philadelphia", codes: ["PHL"], names: ["philadelphia", "philly"] },
  {
    id: "boston",
    display: "Boston",
    codes: ["BOS"],
    names: ["boston"],
    ambiguous: ["logan"],
  },
  {
    id: "new_york",
    display: "New York",
    codes: ["JFK", "LGA", "EWR"],
    names: ["new york", "nyc", "manhattan", "brooklyn", "newark"],
  },
  { id: "washington", display: "Washington DC", codes: ["DCA", "IAD", "BWI"], names: ["washington dc", "dulles"] },
  { id: "chicago", display: "Chicago", codes: ["ORD", "MDW"], names: ["chicago"], ambiguous: ["ohare", "o'hare", "midway"] },
  { id: "los_angeles", display: "Los Angeles", codes: ["LAX", "BUR", "SNA"], names: ["los angeles"] },
  { id: "san_francisco", display: "San Francisco", codes: ["SFO", "OAK", "SJC"], names: ["san francisco", "oakland"] },
  { id: "seattle", display: "Seattle", codes: ["SEA"], names: ["seattle"] },
  { id: "denver", display: "Denver", codes: ["DEN"], names: ["denver"] },
  { id: "austin", display: "Austin", codes: ["AUS"], names: ["austin"] },
  { id: "dallas", display: "Dallas", codes: ["DFW", "DAL"], names: ["dallas", "fort worth"] },
  { id: "houston", display: "Houston", codes: ["IAH", "HOU"], names: ["houston"] },
  { id: "atlanta", display: "Atlanta", codes: ["ATL"], names: ["atlanta"] },
  { id: "miami", display: "Miami", codes: ["MIA", "FLL"], names: ["miami", "fort lauderdale"] },
  { id: "orlando", display: "Orlando", codes: ["MCO"], names: ["orlando"] },
  { id: "phoenix", display: "Phoenix", codes: ["PHX"], names: ["phoenix"] },
  { id: "las_vegas", display: "Las Vegas", codes: ["LAS"], names: ["las vegas"], ambiguous: ["vegas"] },
  { id: "san_diego", display: "San Diego", codes: ["SAN"], names: ["san diego"] },
  { id: "portland", display: "Portland", codes: ["PDX"], names: ["portland"] },
  { id: "minneapolis", display: "Minneapolis", codes: ["MSP"], names: ["minneapolis"] },
  { id: "detroit", display: "Detroit", codes: ["DTW"], names: ["detroit"] },
  { id: "charlotte", display: "Charlotte", codes: ["CLT"], names: ["charlotte"] },
  { id: "nashville", display: "Nashville", codes: ["BNA"], names: ["nashville"] },
  { id: "new_orleans", display: "New Orleans", codes: ["MSY"], names: ["new orleans"] },
  { id: "pittsburgh", display: "Pittsburgh", codes: ["PIT"], names: ["pittsburgh"] },
  { id: "baltimore", display: "Baltimore", codes: [], names: ["baltimore"] },
  { id: "raleigh", display: "Raleigh", codes: ["RDU"], names: ["raleigh", "durham"] },
  { id: "salt_lake_city", display: "Salt Lake City", codes: ["SLC"], names: ["salt lake city"] },
  { id: "st_louis", display: "St Louis", codes: ["STL"], names: ["st louis", "saint louis"] },
  { id: "kansas_city", display: "Kansas City", codes: ["MCI"], names: ["kansas city"] },
  { id: "cleveland", display: "Cleveland", codes: ["CLE"], names: ["cleveland"] },
  { id: "columbus", display: "Columbus", codes: ["CMH"], names: ["columbus"] },
  { id: "indianapolis", display: "Indianapolis", codes: ["IND"], names: ["indianapolis"] },
  { id: "milwaukee", display: "Milwaukee", codes: ["MKE"], names: ["milwaukee"] },
  { id: "sacramento", display: "Sacramento", codes: ["SMF"], names: ["sacramento"] },
  { id: "tampa", display: "Tampa", codes: ["TPA"], names: ["tampa"] },
  { id: "buffalo", display: "Buffalo", codes: ["BUF"], names: ["buffalo"] },
  { id: "richmond", display: "Richmond", codes: ["RIC"], names: ["richmond"] },
  { id: "hartford", display: "Hartford", codes: ["BDL"], names: ["hartford"] },
  { id: "providence", display: "Providence", codes: ["PVD"], names: ["providence"] },
  { id: "albany", display: "Albany", codes: ["ALB"], names: ["albany"] },
  { id: "syracuse", display: "Syracuse", codes: ["SYR"], names: ["syracuse"] },
  { id: "rochester", display: "Rochester", codes: ["ROC"], names: ["rochester"] },
  { id: "burlington", display: "Burlington", codes: ["BTV"], names: ["burlington"] },
  { id: "portland_me", display: "Portland ME", codes: ["PWM"], names: ["portland maine"] },
  { id: "london", display: "London", codes: ["LHR", "LGW", "STN"], names: ["london", "heathrow", "gatwick"] },
  { id: "paris", display: "Paris", codes: ["CDG", "ORY"], names: ["paris"] },
  { id: "dublin", display: "Dublin", codes: ["DUB"], names: ["dublin"] },
  { id: "amsterdam", display: "Amsterdam", codes: ["AMS"], names: ["amsterdam"] },
  { id: "rome", display: "Rome", codes: ["FCO"], names: ["rome"] },
  { id: "madrid", display: "Madrid", codes: ["MAD"], names: ["madrid"] },
  { id: "barcelona", display: "Barcelona", codes: ["BCN"], names: ["barcelona"] },
  { id: "lisbon", display: "Lisbon", codes: ["LIS"], names: ["lisbon"] },
  { id: "berlin", display: "Berlin", codes: ["BER"], names: ["berlin"] },
  { id: "tokyo", display: "Tokyo", codes: ["NRT", "HND"], names: ["tokyo"] },
  { id: "toronto", display: "Toronto", codes: ["YYZ"], names: ["toronto"] },
  { id: "vancouver", display: "Vancouver", codes: ["YVR"], names: ["vancouver"] },
  { id: "montreal", display: "Montreal", codes: ["YUL"], names: ["montreal"] },
  { id: "mexico_city", display: "Mexico City", codes: ["MEX"], names: ["mexico city"] },
  { id: "honolulu", display: "Honolulu", codes: ["HNL"], names: ["honolulu"] },
  { id: "anchorage", display: "Anchorage", codes: ["ANC"], names: ["anchorage"] },
  { id: "wildwood", display: "Wildwood", codes: [], names: ["wildwood"] },
  { id: "cape_may", display: "Cape May", codes: [], names: ["cape may"] },
  { id: "stowe", display: "Stowe", codes: [], names: ["stowe"] },
  { id: "asbury_park", display: "Asbury Park", codes: [], names: ["asbury park"] },
  { id: "outer_banks", display: "Outer Banks", codes: [], names: ["outer banks", "obx"] },
  // Places somebody drives to. No airport, no booking, no confirmation email --
  // and for a lot of people these are most of the trips they take. A gazetteer
  // built only from airports can only ever see the journeys that had tickets.
  { id: "poconos", display: "the Poconos", codes: [], names: ["poconos", "pocono"] },
  { id: "jersey_shore", display: "the Jersey Shore", codes: [], names: ["jersey shore", "lbi", "long beach island"] },
  { id: "ocean_city", display: "Ocean City", codes: [], names: ["ocean city"] },
  { id: "rehoboth", display: "Rehoboth", codes: [], names: ["rehoboth"] },
  { id: "catskills", display: "the Catskills", codes: [], names: ["catskills"] },
  { id: "adirondacks", display: "the Adirondacks", codes: [], names: ["adirondacks"] },
  { id: "berkshires", display: "the Berkshires", codes: [], names: ["berkshires"] },
  { id: "hamptons", display: "the Hamptons", codes: [], names: ["hamptons"] },
  { id: "finger_lakes", display: "the Finger Lakes", codes: [], names: ["finger lakes"] },
  { id: "lake_george", display: "Lake George", codes: [], names: ["lake george"] },
  { id: "cape_cod", display: "Cape Cod", codes: [], names: ["cape cod"] },
  { id: "shenandoah", display: "Shenandoah", codes: [], names: ["shenandoah"] },
];

/**
 * Words near a token that make a bare three-letter code or an ambiguous name
 * mean a place.
 *
 * Without this, `SAN`, `ORD` and `LAS` match inside ordinary prose and `logan`
 * matches every text from anyone called Logan. Requiring context costs recall on
 * a calendar entry that says only "BOS", and that is the right trade: a place
 * anchor is load-bearing evidence, and load-bearing evidence has to be right
 * more often than it is complete.
 */
const TRAVEL_CONTEXT =
  /\b(?:flight|flights|flying|fly|flew|depart|departs|departure|arrive|arrives|arrival|arriving|land|lands|landing|landed|airport|airline|terminal|gate|boarding|nonstop|layover|connection|itinerary|train|amtrak|rail|station|drive|driving|road\s?trip|hotel|airbnb|checkin|check-in|trip|travel|visiting|visit)\b/i;

/** `PHL to BOS`, `PHL - BOS`, `PHL → BOS`, `PHL/BOS`. */
const ROUTE = /\b([A-Z]{3})\s*(?:to|-|–|—|→|>|\/)\s*([A-Z]{3})\b/g;

const BY_CODE = new Map<string, PlaceEntry>();
const BY_NAME = new Map<string, PlaceEntry>();
const AMBIGUOUS = new Map<string, PlaceEntry>();

for (const place of PLACES) {
  for (const code of place.codes) {
    BY_CODE.set(code, place);
  }

  for (const name of place.names) {
    BY_NAME.set(name, place);
  }

  for (const name of place.ambiguous ?? []) {
    AMBIGUOUS.set(name, place);
  }
}

/** Longest first, so "new york" wins over a hypothetical "york". */
const NAMES_BY_LENGTH = [...BY_NAME.keys()].sort((a, b) => b.length - a.length);

export interface PlaceHit {
  /** Canonical place id. Two spellings of one city produce one of these. */
  readonly id: string;
  readonly display: string;
  /** What was actually written, for the evidence line. */
  readonly matched: string;
}

export function placeById(id: string): PlaceHit | null {
  const entry = PLACES.find((place) => place.id === id);

  return entry === undefined
    ? null
    : { id: entry.id, display: entry.display, matched: entry.display };
}

/**
 * A route stated as two codes, if the text states one.
 *
 * Worth its own function because it is the only place in Harbor that recovers
 * *direction*, and direction is what turns two flights into one round trip
 * rather than two unrelated journeys.
 */
export function routesIn(text: string): readonly { readonly from: PlaceHit; readonly to: PlaceHit }[] {
  const found: { from: PlaceHit; to: PlaceHit }[] = [];

  for (const match of text.matchAll(ROUTE)) {
    const from = BY_CODE.get(match[1] ?? "");
    const to = BY_CODE.get(match[2] ?? "");

    if (from === undefined || to === undefined || from.id === to.id) {
      continue;
    }

    found.push({
      from: { id: from.id, display: from.display, matched: match[1] ?? "" },
      to: { id: to.id, display: to.display, matched: match[2] ?? "" },
    });
  }

  return found;
}

/**
 * Every place named in a piece of text.
 *
 * Three passes, cheapest and safest first: explicit routes, then full names,
 * then bare codes and ambiguous names, which are only admitted when travel
 * vocabulary is present somewhere in the text.
 */
export function placesIn(text: string): readonly PlaceHit[] {
  if (text.length === 0) {
    return [];
  }

  const lower = text.toLowerCase();
  const hasContext = TRAVEL_CONTEXT.test(text);
  const found = new Map<string, PlaceHit>();

  for (const route of routesIn(text)) {
    found.set(route.from.id, route.from);
    found.set(route.to.id, route.to);
  }

  for (const name of NAMES_BY_LENGTH) {
    const entry = BY_NAME.get(name);

    if (entry === undefined || found.has(entry.id)) {
      continue;
    }

    // Whole words only. Otherwise "boston" matches inside "bostonian" and,
    // worse, short names match inside longer unrelated words.
    const pattern = new RegExp(`(?:^|[^\\p{L}])${escape(name)}(?:[^\\p{L}]|$)`, "u");

    if (pattern.test(lower)) {
      found.set(entry.id, { id: entry.id, display: entry.display, matched: name });
    }
  }

  if (!hasContext) {
    return [...found.values()];
  }

  for (const [name, entry] of AMBIGUOUS) {
    if (found.has(entry.id)) {
      continue;
    }

    const pattern = new RegExp(`(?:^|[^\\p{L}])${escape(name)}(?:[^\\p{L}]|$)`, "u");

    if (pattern.test(lower)) {
      found.set(entry.id, { id: entry.id, display: entry.display, matched: name });
    }
  }

  // Bare codes last and only with context, because three capital letters is the
  // single most dangerous pattern in this file: SAN, LAS, ORD, CLE and BUF are
  // all ordinary strings in a mailbox.
  for (const match of text.matchAll(/\b([A-Z]{3})\b/g)) {
    const entry = BY_CODE.get(match[1] ?? "");

    if (entry !== undefined && !found.has(entry.id)) {
      found.set(entry.id, { id: entry.id, display: entry.display, matched: match[1] ?? "" });
    }
  }

  return [...found.values()];
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * US state abbreviations, for reading a locality out of a street address.
 */
const STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

/** `..., Long Pond, PA 18334` and `..., Long Pond, PA`. */
const LOCALITY = /,\s*([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}),\s*([A-Z]{2})\b/g;

/**
 * The town named in a street address.
 *
 * The gazetteer is hand-checked, which means it knows the places somebody flies
 * to and none of the places they drive to. A lakehouse in Long Pond,
 * Pennsylvania is not in it and never will be, and neither is anywhere else
 * that matters to one person and nobody else.
 *
 * A calendar entry's location field is the way out. It is curated by whoever
 * wrote the invitation, it is nearly always a real address, and the town in it
 * is a real place name whether or not any list contains it. Reading it gives
 * Harbor a comparable place token for somewhere it has never heard of -- and
 * once that token exists, a text saying "long pond" matches an address nobody
 * had to enumerate in advance.
 *
 * Returned as a hit with a generated id rather than a gazetteer id, so two
 * events at the same town agree and nothing pretends to know more than the
 * address said.
 */
export function localityIn(text: string): readonly PlaceHit[] {
  const found = new Map<string, PlaceHit>();

  for (const match of text.matchAll(LOCALITY)) {
    const state = (match[2] ?? "").toUpperCase();

    if (!STATES.has(state)) {
      continue;
    }

    const town = (match[1] ?? "").trim();

    // A street line ends in a suffix, not a town: "511 Minsi Trl W, Long Pond"
    // splits correctly only because the town is what precedes the state.
    if (town.length < 3 || /\d/.test(town)) {
      continue;
    }

    const known = BY_NAME.get(town.toLowerCase());

    if (known !== undefined) {
      found.set(known.id, { id: known.id, display: known.display, matched: town });
      continue;
    }

    const id = town.toLowerCase().replace(/[^a-z]+/g, "_");

    found.set(id, { id, display: town, matched: town });
  }

  return [...found.values()];
}

/** Whether text talks about travelling, as opposed to merely naming a city. */
export function mentionsTravel(text: string): boolean {
  return TRAVEL_CONTEXT.test(text);
}
