/**
 * Times that are not dates.
 *
 * `dates.ts` reads a day and returns midnight to midnight. That is the right
 * shape for a trip, whose unit genuinely is the day, and it is the wrong shape
 * for everything people actually arrange with each other. "later", "8ish",
 * "after work" and "tonight" all state a time, none of them states a date, and
 * `datesIn` returns nothing for all four. The store has had no way to represent
 * a time of day at all, which is why the single most informative node in an
 * evening -- a reservation stating 8:00 PM -- could contribute its date and had
 * to discard its hour.
 *
 * A hint is an *interval*, not an instant, and the width of the interval is the
 * whole point. "later" said at a quarter to six is a five hour window and
 * everybody understands it as one. "8:00 PM" on a confirmation is fifteen
 * minutes. Both are true statements about when something happens, and the only
 * difference that matters downstream is how much they narrow.
 *
 * That is what makes resolution possible without similarity. A conversation
 * that says "later" and a confirmation that says 8:00 PM share no word, no
 * place, no identifier and no person, and one of them is plainly an answer to
 * the other: the narrow interval falls inside the wide one, on the same
 * evening. Nothing in Harbor could previously express that sentence.
 *
 * Deliberately conservative. Every pattern here has to be one somebody would
 * recognise as a time if you read it back to them, because a hint that is wrong
 * does not merely fail to connect two things: it connects two wrong things and
 * writes a confident sentence underneath.
 */
import { localDate, localHour, localIso, localTimeToInstant } from "../kernel/time.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

export type TimeHintKind = "clock" | "vague";

export interface TimeHint {
  /** Canonical and comparable: the interval, rounded to the minute. */
  readonly value: string;
  /** What was actually written. For the evidence line. */
  readonly display: string;
  /** Earliest the thing could be. */
  readonly startsAt: number;
  /** Latest the thing could be. */
  readonly endsAt: number;
  readonly kind: TimeHintKind;
  readonly confidence: number;
}

/**
 * How wide a stated clock time is.
 *
 * "8:00 PM" from a restaurant is a booking and is exact. "8ish" and "around 8"
 * are somebody guessing, and treating them as exact would let a plan that said
 * 8ish refuse a table at 8:15.
 */
const EXACT_SLACK_MS = 15 * MINUTE;
const APPROXIMATE_SLACK_MS = 45 * MINUTE;

/**
 * The latest a vague evening plan can run.
 *
 * Two in the morning, local. Not midnight, because "later" said at ten at night
 * plainly means after ten, and a window that closes before the thing it
 * describes is worse than no window.
 */
const LATEST_HOUR = 26;

/** Nothing arranged in conversation is more than this far out. */
const MAX_HORIZON_MS = 36 * HOUR;

interface Window {
  readonly fromHour: number;
  readonly toHour: number;
  /** Days ahead of the day the text was written. */
  readonly dayOffset: number;
}

/**
 * The vague ones, in the order they must be tried.
 *
 * Longest first, because "tomorrow night" has to win against both "tomorrow"
 * and "night", and a shorter pattern matching first would give an interval a
 * day wide where a four hour one was stated.
 */
const VAGUE: readonly { readonly pattern: RegExp; readonly window: Window; readonly confidence: number }[] = [
  { pattern: /\btomorrow\s+(?:night|evening)\b/i, window: { fromHour: 17, toHour: 24, dayOffset: 1 }, confidence: 0.8 },
  { pattern: /\btomorrow\s+afternoon\b/i, window: { fromHour: 12, toHour: 17, dayOffset: 1 }, confidence: 0.8 },
  { pattern: /\btomorrow\s+morning\b/i, window: { fromHour: 6, toHour: 12, dayOffset: 1 }, confidence: 0.8 },
  { pattern: /\bthis\s+(?:evening|eve)\b/i, window: { fromHour: 17, toHour: 23, dayOffset: 0 }, confidence: 0.8 },
  { pattern: /\bthis\s+afternoon\b/i, window: { fromHour: 12, toHour: 17, dayOffset: 0 }, confidence: 0.8 },
  { pattern: /\bthis\s+morning\b/i, window: { fromHour: 6, toHour: 12, dayOffset: 0 }, confidence: 0.8 },
  { pattern: /\bafter\s+work\b/i, window: { fromHour: 17, toHour: 21, dayOffset: 0 }, confidence: 0.7 },
  { pattern: /\bto\s?night\b/i, window: { fromHour: 17, toHour: LATEST_HOUR, dayOffset: 0 }, confidence: 0.8 },
  { pattern: /\btomorrow\b/i, window: { fromHour: 8, toHour: 22, dayOffset: 1 }, confidence: 0.6 },
];

/**
 * "later", which is the one that has to be measured from the speaker.
 *
 * Every other vague form names a part of the day and can be resolved against
 * the clock. "later" names no part of anything: it means after now, and how
 * long after depends entirely on what time it was when it was said. Said at
 * lunchtime it is the afternoon; said at six it is the evening. Resolving it to
 * a fixed evening window would be wrong half the time and confidently so.
 */
const LATER = /\b(?:later|in\s+a\s+bit|after\s+a\s+bit)\b/i;

/** The nearest a "later" can be. Long enough to leave the house. */
const LATER_FLOOR_MS = 45 * MINUTE;

/**
 * A clock time, in the three forms that are not guesses.
 *
 * A bare number is not among them. "8" on its own is a quantity far more often
 * than an hour, and admitting it made every mention of a price, a count or a
 * street number into a time. What rescues it is a marker: a meridiem, a colon,
 * an "ish", or a preposition in front of it.
 */
const CLOCK_MERIDIEM = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/gi;
const CLOCK_ISH = /\b(\d{1,2})(?::(\d{2}))?\s*(?:ish|-ish)\b/gi;
const CLOCK_PREPOSED = /\b(?:at|around|by|from)\s+(\d{1,2})(?::(\d{2}))\b/gi;
const CLOCK_PREPOSED_HOUR = /\b(?:at|around|by)\s+(\d{1,2})(?!\s*(?:%|st|nd|rd|th|:|\d))\b/gi;

function startOfLocalDay(at: number, tz: string, dayOffset: number): number {
  const base = localTimeToInstant(localDate(at, tz), 0, 0, tz);

  // Adding whole days in milliseconds crosses a DST boundary wrongly twice a
  // year, so the offset is re-resolved through the calendar date rather than
  // added to the instant.
  if (dayOffset === 0) {
    return base;
  }

  const shifted = new Date(base + dayOffset * 24 * HOUR);
  const date = `${String(shifted.getUTCFullYear())}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate(),
  ).padStart(2, "0")}`;

  return localTimeToInstant(localDate(Date.parse(`${date}T12:00:00Z`), tz), 0, 0, tz);
}

function atLocalHour(at: number, tz: string, dayOffset: number, hour: number, minute = 0): number {
  return startOfLocalDay(at, tz, dayOffset) + hour * HOUR + minute * MINUTE;
}

function intervalValue(startsAt: number, endsAt: number): string {
  return `${String(Math.round(startsAt / MINUTE))}-${String(Math.round(endsAt / MINUTE))}`;
}

/**
 * Which day a stated hour belongs to.
 *
 * Somebody writing "8pm" at half past six means tonight. Writing it at eleven
 * at night means tomorrow. The rule is the next occurrence of that hour, with
 * one exception: an hour up to two hours in the past is still today, because
 * "we said 8" gets written at five past eight constantly.
 */
function nextOccurrence(said: number, tz: string, hour: number, minute: number): number {
  const today = atLocalHour(said, tz, 0, hour, minute);

  if (today >= said - 2 * HOUR) {
    return today;
  }

  return atLocalHour(said, tz, 1, hour, minute);
}

/**
 * A twelve hour clock with no meridiem, read the way a person would.
 *
 * "8ish" in the evening is eight in the evening. The rule is to prefer the
 * reading that is soon: of the two candidate instants, the one that comes next
 * wins, which turns out to be what "half seven" and "at 9" mean in almost every
 * message anybody sends.
 */
function resolveAmbiguousHour(said: number, tz: string, hour: number, minute: number): number {
  if (hour === 0 || hour > 12) {
    return nextOccurrence(said, tz, hour % 24, minute);
  }

  const morning = nextOccurrence(said, tz, hour, minute);
  const evening = nextOccurrence(said, tz, (hour + 12) % 24, minute);

  return Math.min(morning, evening);
}

/**
 * Every time this text states, as intervals.
 *
 * `saidAt` is when it was written, and it is not optional: every form here is
 * relative to it, including the ones that look absolute. "8pm" is a different
 * instant depending on whether it was written in the morning or at midnight.
 */
export function timeHintsIn(text: string, saidAt: number, tz: string): readonly TimeHint[] {
  if (text.trim().length === 0) {
    return [];
  }

  const found = new Map<string, TimeHint>();

  // Two patterns reading one piece of text is two claims about one statement.
  // "at 8:00 PM" is matched by the meridiem rule and by the preposed rule, and
  // the second has no meridiem to go on, so it reads eight in the morning. Both
  // get stored, the store now holds a hint twelve hours from the truth, and a
  // plan can resolve against it. Spans are claimed in confidence order, exactly
  // as `dates.ts` claims them, and the strongest reading of a piece of text is
  // the only reading of it.
  const claimed: [number, number][] = [];

  const claim = (match: RegExpMatchArray): boolean => {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (claimed.some(([from, to]) => start < to && end > from)) {
      return false;
    }

    claimed.push([start, end]);
    return true;
  };

  const put = (hint: TimeHint): void => {
    // Beyond the horizon is a misreading, not a plan. A "time" resolving four
    // days out came from a number that was never a time.
    if (hint.startsAt > saidAt + MAX_HORIZON_MS || hint.endsAt < saidAt - 2 * HOUR) {
      return;
    }

    const held = found.get(hint.value);

    if (held === undefined || held.confidence < hint.confidence) {
      found.set(hint.value, hint);
    }
  };

  const clock = (
    match: RegExpMatchArray,
    hour: number,
    minute: number,
    slack: number,
    confidence: number,
    ambiguous: boolean,
  ): void => {
    if (!Number.isFinite(hour) || hour > 23 || minute > 59) {
      return;
    }

    const at = ambiguous
      ? resolveAmbiguousHour(saidAt, tz, hour, minute)
      : nextOccurrence(saidAt, tz, hour, minute);

    put({
      value: intervalValue(at - slack, at + slack),
      display: match[0].trim(),
      startsAt: at - slack,
      endsAt: at + slack,
      kind: "clock",
      confidence,
    });
  };

  for (const match of text.matchAll(CLOCK_MERIDIEM)) {
    if (!claim(match)) {
      continue;
    }

    const raw = Number.parseInt(match[1] ?? "", 10);
    const pm = (match[3] ?? "").toLowerCase() === "p";
    const hour = raw === 12 ? (pm ? 12 : 0) : pm ? raw + 12 : raw;

    clock(match, hour, Number.parseInt(match[2] ?? "0", 10), EXACT_SLACK_MS, 0.9, false);
  }

  for (const match of text.matchAll(CLOCK_ISH)) {
    if (!claim(match)) {
      continue;
    }

    clock(
      match,
      Number.parseInt(match[1] ?? "", 10),
      Number.parseInt(match[2] ?? "0", 10),
      APPROXIMATE_SLACK_MS,
      0.75,
      true,
    );
  }

  for (const match of text.matchAll(CLOCK_PREPOSED)) {
    if (!claim(match)) {
      continue;
    }

    clock(
      match,
      Number.parseInt(match[1] ?? "", 10),
      Number.parseInt(match[2] ?? "0", 10),
      EXACT_SLACK_MS,
      0.7,
      true,
    );
  }

  for (const match of text.matchAll(CLOCK_PREPOSED_HOUR)) {
    if (!claim(match)) {
      continue;
    }

    clock(match, Number.parseInt(match[1] ?? "", 10), 0, APPROXIMATE_SLACK_MS, 0.6, true);
  }

  for (const { pattern, window, confidence } of VAGUE) {
    const match = pattern.exec(text);

    if (match === null) {
      continue;
    }

    const startsAt = atLocalHour(saidAt, tz, window.dayOffset, window.fromHour);
    const endsAt = atLocalHour(saidAt, tz, window.dayOffset, window.toHour);

    // Said at nine in the evening, "tonight" starts now rather than at five.
    const from = window.dayOffset === 0 ? Math.max(startsAt, saidAt) : startsAt;

    if (endsAt <= from) {
      continue;
    }

    put({
      value: intervalValue(from, endsAt),
      display: match[0].trim(),
      startsAt: from,
      endsAt,
      kind: "vague",
      confidence,
    });
  }

  const later = LATER.exec(text);

  if (later !== null) {
    const from = saidAt + LATER_FLOOR_MS;

    // Whichever comes first: the end of the evening, or eight hours out. Said
    // at two in the afternoon "later" is not midnight.
    const endOfEvening = atLocalHour(saidAt, tz, 0, LATEST_HOUR);
    const to = Math.min(endOfEvening, saidAt + 8 * HOUR);

    if (to > from) {
      put({
        value: intervalValue(from, to),
        display: later[0].trim(),
        startsAt: from,
        endsAt: to,
        kind: "vague",
        confidence: 0.55,
      });
    }
  }

  return [...found.values()].sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * The narrowest hint, which is the one worth acting on.
 *
 * A message often carries two: "tonight, 8ish" states the evening and then
 * states the hour. They agree, and the hour is the useful one.
 */
export function narrowest(hints: readonly TimeHint[]): TimeHint | null {
  let best: TimeHint | null = null;

  for (const hint of hints) {
    const width = hint.endsAt - hint.startsAt;

    if (best === null || width < best.endsAt - best.startsAt) {
      best = hint;
    }
  }

  return best;
}

/**
 * Whether a stated time answers an open one.
 *
 * The asymmetry is the entire mechanism. A narrow interval falling inside a
 * wide one is an answer: "later" asked when, "8:00 PM" said when. Two wide
 * intervals overlapping is not an answer, because two vague statements about
 * the same evening tell each other nothing, and letting them count would make
 * every plan on a Thursday evidence for every other plan on that Thursday.
 */
export function resolves(open: TimeHint, stated: TimeHint): boolean {
  if (stated.kind !== "clock") {
    return false;
  }

  const openWidth = open.endsAt - open.startsAt;
  const statedWidth = stated.endsAt - stated.startsAt;

  if (statedWidth >= openWidth) {
    return false;
  }

  const middle = stated.startsAt + statedWidth / 2;

  return middle >= open.startsAt && middle <= open.endsAt;
}

/** How much a stated time narrows an open one, as a fraction. Nothing to all. */
export function narrowing(open: TimeHint, stated: TimeHint): number {
  const openWidth = Math.max(1, open.endsAt - open.startsAt);
  const statedWidth = Math.max(1, stated.endsAt - stated.startsAt);

  return Math.max(0, Math.min(1, 1 - statedWidth / openWidth));
}

/** `8:00 PM`, in the user's own timezone, for an evidence line. */
export function clockOf(at: number, tz: string): string {
  const hour = localHour(at, tz);

  // Through the timezone, not off the instant. Half the world is on a whole
  // hour offset and the rest of it is on Kathmandu time.
  const minute = Number.parseInt(localIso(at, tz).slice(14, 16), 10);
  const meridiem = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;

  return `${String(twelve)}:${String(minute).padStart(2, "0")} ${meridiem}`;
}
