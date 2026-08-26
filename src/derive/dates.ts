/**
 * Dates written in prose, resolved against when the prose was written.
 *
 * "the 20th through the 24th" is the single most useful sentence in a trip
 * conversation and the old pipeline could not see it at all: bare numbers are
 * stripped by the term extractor on purpose, because matching on them connects
 * every receipt with the same total. So the one message that actually stated
 * the shape of the trip contributed nothing.
 *
 * A date is not a topic and should never have been competing with topics. It is
 * an anchor: it says *when*, and when is half of what makes two things the same
 * story.
 *
 * Everything here resolves relative to the item's own timestamp, which is the
 * only context available and is almost always the right one. Someone writing
 * "the 20th" in June means this June or next month, never last year, so an
 * interpretation is chosen from the nearest candidates and anything more than
 * six months away is discarded rather than guessed at.
 */

const DAY = 86_400_000;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export interface DateHit {
  /** Midnight UTC on the first day named. */
  readonly startsAt: number;
  /** Midnight UTC on the last day named. Equal to `startsAt` for a single day. */
  readonly endsAt: number;
  /** What was written, for the evidence line. */
  readonly matched: string;
  /**
   * How sure we are this is a date at all.
   *
   * A named month with a day is not in doubt. A bare ordinal ("the 20th") is a
   * date but its month is inferred, so it is worth less.
   */
  readonly confidence: number;
}

/**
 * How far from the writing date an interpretation may land before it is junk.
 *
 * A hundred and fifty days, which is a little wider than the trip planning
 * window so a conversation at the far edge of it can still state a date. Wider
 * than that and "1/3" in a July email resolves to the previous January and
 * anchors a story six months away from anything it is about.
 */
const MAX_DRIFT_MS = 150 * DAY;

function startOfDay(ms: number): number {
  const date = new Date(ms);

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * The year that makes a month-and-day land nearest the reference time.
 *
 * A December email saying "January 3rd" means next year, and an April email
 * saying "December 12th" almost certainly means this one. Choosing the nearest
 * of the three candidates gets both right without any special-casing.
 */
function nearestYear(reference: number, month: number, day: number): number {
  const base = new Date(reference).getUTCFullYear();

  let best = base;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const year of [base - 1, base, base + 1]) {
    const candidate = Date.UTC(year, month, day);
    const distance = Math.abs(candidate - reference);

    if (distance < bestDistance) {
      bestDistance = distance;
      best = year;
    }
  }

  return best;
}

/**
 * The month that makes a bare ordinal land nearest, and slightly ahead.
 *
 * "the 20th" written on the 3rd means this month; written on the 25th it means
 * next. Biased forward by a week because people write about dates that have not
 * happened yet far more often than about ones that have.
 */
function nearestMonth(reference: number, day: number): { year: number; month: number } | null {
  const anchor = reference - 7 * DAY;
  const date = new Date(anchor);

  let best: { year: number; month: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let offset = -1; offset <= 2; offset += 1) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + offset;
    const candidate = Date.UTC(year, month, day);

    // Rejects the 31st of a 30-day month rather than letting it roll forward
    // into the next one, which would silently invent a date nobody wrote.
    if (new Date(candidate).getUTCDate() !== day) {
      continue;
    }

    const distance = Math.abs(candidate - anchor);

    if (distance < bestDistance) {
      bestDistance = distance;
      best = { year: new Date(candidate).getUTCFullYear(), month: new Date(candidate).getUTCMonth() };
    }
  }

  return best;
}

/**
 * A month named anywhere in the text, for resolving bare ordinals against.
 *
 * "probably the 20th through the 24th" is undatable on its own, and the message
 * two lines above it says "coming out to boston in august". People state the
 * month once and then stop repeating it, so a reader who only looks at the
 * sentence in front of them resolves the range to whatever month it happens to
 * be now. That is how the most explicit statement of a trip's dates anywhere in
 * the store resolved to June.
 */
function monthContextIn(text: string): number | null {
  const match = /\b(january|february|march|april|june|july|august|september|october|november|december)\b/i.exec(
    text,
  );

  if (match === null) {
    return null;
  }

  return MONTHS[(match[1] ?? "").toLowerCase()] ?? null;
}

/** `August 20`, `Aug 20th`, `20 August`. Optionally a range: `Aug 20-24`. */
const MONTH_DAY =
  /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:-|–|—|through|thru|to|until)\s*(\d{1,2})(?:st|nd|rd|th)?)?\b/gi;

/** `20th through the 24th`, `the 20th to the 24th`, `20th-24th`. */
const ORDINAL_RANGE =
  /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\s*(?:-|–|—|through|thru|to|until)\s*(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/gi;

/** A lone `the 20th`. */
const ORDINAL = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;

/** `8/20`, `8/20/26`, `2026-08-20`. */
const NUMERIC = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;

function within(hit: DateHit, reference: number): boolean {
  return Math.abs(hit.startsAt - reference) <= MAX_DRIFT_MS;
}

/**
 * Every date and date range a piece of text names.
 *
 * Ranges are kept as ranges rather than flattened into two dates, because a
 * range is the thing that makes a trip a trip. "The 20th through the 24th" is
 * one fact about one span, and splitting it loses the only statement of length
 * anywhere in the store.
 */
export function datesIn(text: string, writtenAt: number): readonly DateHit[] {
  if (text.length === 0) {
    return [];
  }

  const hits: DateHit[] = [];
  const claimed: [number, number][] = [];
  const contextMonth = monthContextIn(text);

  /**
   * The month a bare ordinal belongs to.
   *
   * A month named elsewhere in the same text wins over proximity, because it
   * was stated deliberately and proximity is only ever a guess.
   */
  const resolveOrdinal = (day: number): { year: number; month: number } | null => {
    if (contextMonth !== null) {
      const year = nearestYear(writtenAt, contextMonth, day);
      const candidate = Date.UTC(year, contextMonth, day);

      if (new Date(candidate).getUTCDate() === day) {
        return { year, month: contextMonth };
      }
    }

    return nearestMonth(writtenAt, day);
  };

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([from, to]) => start < to && end > from);

  const claim = (match: RegExpMatchArray): boolean => {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (overlaps(start, end)) {
      return false;
    }

    claimed.push([start, end]);
    return true;
  };

  for (const match of text.matchAll(MONTH_DAY)) {
    if (!claim(match)) {
      continue;
    }

    const month = MONTHS[(match[1] ?? "").toLowerCase()];
    const day = Number.parseInt(match[2] ?? "", 10);

    if (month === undefined || !Number.isFinite(day) || day < 1 || day > 31) {
      continue;
    }

    const year = nearestYear(writtenAt, month, day);
    const startsAt = Date.UTC(year, month, day);

    if (new Date(startsAt).getUTCDate() !== day) {
      continue;
    }

    const lastRaw = match[3];
    const last = lastRaw === undefined ? day : Number.parseInt(lastRaw, 10);
    const endsAt = last >= day && last <= 31 ? Date.UTC(year, month, last) : startsAt;

    const hit: DateHit = { startsAt, endsAt, matched: match[0], confidence: 0.9 };

    if (within(hit, writtenAt)) {
      hits.push(hit);
    }
  }

  for (const match of text.matchAll(NUMERIC)) {
    if (!claim(match)) {
      continue;
    }

    let year: number;
    let month: number;
    let day: number;

    if (match[1] !== undefined) {
      year = Number.parseInt(match[1], 10);
      month = Number.parseInt(match[2] ?? "", 10) - 1;
      day = Number.parseInt(match[3] ?? "", 10);
    } else {
      month = Number.parseInt(match[4] ?? "", 10) - 1;
      day = Number.parseInt(match[5] ?? "", 10);

      const yearRaw = match[6];

      if (yearRaw === undefined) {
        year = nearestYear(writtenAt, month, day);
      } else {
        const parsed = Number.parseInt(yearRaw, 10);
        year = parsed < 100 ? 2000 + parsed : parsed;
      }
    }

    if (month < 0 || month > 11 || day < 1 || day > 31) {
      continue;
    }

    const startsAt = Date.UTC(year, month, day);

    if (new Date(startsAt).getUTCDate() !== day) {
      continue;
    }

    const hit: DateHit = { startsAt, endsAt: startsAt, matched: match[0], confidence: 0.85 };

    if (within(hit, writtenAt)) {
      hits.push(hit);
    }
  }

  for (const match of text.matchAll(ORDINAL_RANGE)) {
    if (!claim(match)) {
      continue;
    }

    const first = Number.parseInt(match[1] ?? "", 10);
    const last = Number.parseInt(match[2] ?? "", 10);

    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
      continue;
    }

    const resolved = resolveOrdinal(first);

    if (resolved === null) {
      continue;
    }

    const startsAt = Date.UTC(resolved.year, resolved.month, first);
    const endsAt = Date.UTC(resolved.year, resolved.month, last);

    const hit: DateHit = {
      startsAt,
      endsAt,
      matched: match[0],
      confidence: contextMonth === null ? 0.6 : 0.8,
    };

    if (within(hit, writtenAt)) {
      hits.push(hit);
    }
  }

  for (const match of text.matchAll(ORDINAL)) {
    if (!claim(match)) {
      continue;
    }

    const day = Number.parseInt(match[1] ?? "", 10);

    if (!Number.isFinite(day) || day < 1 || day > 31) {
      continue;
    }

    const resolved = resolveOrdinal(day);

    if (resolved === null) {
      continue;
    }

    const startsAt = Date.UTC(resolved.year, resolved.month, day);

    const hit: DateHit = {
      startsAt,
      endsAt: startsAt,
      matched: match[0],
      confidence: contextMonth === null ? 0.5 : 0.7,
    };

    if (within(hit, writtenAt)) {
      hits.push(hit);
    }
  }

  return hits;
}

/**
 * Whether a moment falls inside a span, with a day of slack at each end.
 *
 * Slack because a span written as "the 20th through the 24th" resolves to
 * midnight on both ends, and a return flight at 6pm on the 24th is inside the
 * trip by any human reading and outside it by eight decimal places.
 */
export function withinSpan(at: number, startsAt: number, endsAt: number, slackMs = DAY): boolean {
  return at >= startsAt - slackMs && at <= endsAt + slackMs;
}

export { startOfDay };
