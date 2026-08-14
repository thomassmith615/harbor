/**
 * Time formatting.
 *
 * Every timestamp Harbor stores is epoch milliseconds, UTC, no exceptions.
 * Every timestamp Harbor *shows* is local, with the offset attached.
 *
 * The rule that matters: a model is never asked to do timezone arithmetic. It
 * was, briefly, and it silently reported the same message as 7:18 PM in one
 * run and 2:18 AM the next. Everything Harbor eventually wants to say
 * proactively is time-anchored ("a recruiter emailed you Friday at 4:47 PM"),
 * so a three-to-seven hour drift is not cosmetic.
 */

/** IANA zone. Override with HARBOR_TIMEZONE; otherwise the host's zone. */
export function timezone(): string {
  const configured = process.env["HARBOR_TIMEZONE"];
  if (configured !== undefined && configured.trim().length > 0) {
    return configured.trim();
  }

  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

function parts(ms: number, tz: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    map[part.type] = part.value;
  }
  return map;
}

/** UTC offset at that instant, as `-04:00`. Handles DST because it asks per instant. */
export function utcOffset(ms: number, tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  });

  const name =
    formatter.formatToParts(new Date(ms)).find((part) => part.type === "timeZoneName")?.value ??
    "GMT+00:00";

  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (match === null) {
    return "+00:00";
  }

  return `${match[1] ?? "+"}${match[2] ?? "00"}:${match[3] ?? "00"}`;
}

/**
 * The instant at which a given local wall-clock time occurs.
 *
 * The naive version reads the UTC offset at local midnight and reuses it for
 * the whole day. That is wrong on the two days a year the offset changes: on a
 * US fall-back Sunday, midnight is still EDT, so a 6:00am target built with a
 * -04:00 offset actually lands at 5:00am EST. The fix is one refinement pass,
 * recomputing the offset at the candidate instant rather than at midnight.
 *
 * Inside the ambiguous repeated hour there are two correct answers and this
 * returns the first. Nothing in Harbor schedules anything at 1:30am.
 */
export function localTimeToInstant(
  date: string,
  hour: number,
  minute: number,
  tz: string,
): number {
  const stamp = `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

  let offset = utcOffset(Date.parse(`${date}T00:00:00Z`), tz);
  let candidate = Date.parse(`${stamp}${offset}`);

  const refined = utcOffset(candidate, tz);

  if (refined !== offset) {
    offset = refined;
    candidate = Date.parse(`${stamp}${offset}`);
  }

  return candidate;
}

/** The local calendar date of an instant, as `YYYY-MM-DD`. */
export function localDate(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p["year"] ?? "0000"}-${p["month"] ?? "01"}-${p["day"] ?? "01"}`;
}

/** ISO 8601 in local time with offset: `2026-08-03T22:18:00-04:00`. */
export function localIso(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return (
    `${p["year"] ?? "0000"}-${p["month"] ?? "01"}-${p["day"] ?? "01"}` +
    `T${p["hour"] ?? "00"}:${p["minute"] ?? "00"}:${p["second"] ?? "00"}` +
    utcOffset(ms, tz)
  );
}

/**
 * How a person would say it: `Sun, Aug 3, 10:18 PM`, or `Sun, Aug 3, 2024,
 * 10:18 PM` when the year is not the current one.
 *
 * The year used to be omitted always, which made a coverage range read
 * "Mon, Jan 1 -> Sat, Jan 1" and left every search result ambiguous about
 * which August it meant. Including it unconditionally is noisy for this week's
 * calendar; including it only when it differs from now is what a person does.
 */
export function humanWhen(ms: number, tz: string, now: number = Date.now()): string {
  const year = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" });
  const sameYear = year.format(new Date(ms)) === year.format(new Date(now));

  return new Date(ms).toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Anchors the model so relative language ("last week") resolves correctly. */
export function nowContext(tz: string, now: number = Date.now()): string {
  return `The current time is ${humanWhen(now, tz)} (${localIso(now, tz)}). The user's timezone is ${tz}.`;
}

/** Local hour-of-day for an instant, 0 to 23. */
export function localHour(ms: number, tz: string): number {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));

  return Number.parseInt(value, 10);
}

/** 0 = Sunday. */
export function localWeekday(ms: number, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
    new Date(ms),
  );

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/**
 * The next weekday morning at `hour`, local.
 *
 * This is why something detected at 4:47pm on a Friday is mentioned on Monday
 * rather than at 4:48pm on a Friday. Detection time and delivery time are
 * different things, and conflating them is most of what makes a proactive
 * assistant feel like an interruption.
 */
export function nextUsefulMorning(from: number, tz: string, hour = 7): number {
  const DAY = 86_400_000;


  // Today's morning if we are still before it and it is a weekday.
  for (let offset = 0; offset <= 7; offset += 1) {
    const probe = from + offset * DAY;
    const weekday = localWeekday(probe, tz);

    if (weekday === 0 || weekday === 6) {
      continue;
    }

    const candidate = localTimeToInstant(localDate(probe, tz), hour, 0, tz);

    if (candidate > from) {
      return candidate;
    }
  }

  return from;
}

/**
 * Working hours, local. Outside these, something can wait until morning.
 *
 * Friday ends early on purpose. Nothing raised at 4:47pm on a Friday gets acted
 * on that day, so saying it then is an interruption with no upside; saying it
 * Monday at 7am is the same information at a moment it can be used.
 */
const WORKING_START = 7;
const WORKING_END = 18;
const FRIDAY_END = 15;

/**
 * When something detected now becomes worth saying.
 *
 * During a weekday daytime, that is immediately: batching a live problem until
 * tomorrow is its own kind of unhelpful. Outside those hours it is the next
 * weekday morning, which is what turns a Friday 4:47pm detection into a Monday
 * 7am mention rather than a Friday 4:48pm interruption.
 */
export function usefulFrom(now: number, tz: string): number {
  const weekday = localWeekday(now, tz);
  const hour = localHour(now, tz);

  const end = weekday === 5 ? FRIDAY_END : WORKING_END;

  if (weekday >= 1 && weekday <= 5 && hour >= WORKING_START && hour < end) {
    return now;
  }

  return nextUsefulMorning(now, tz, WORKING_START);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] ?? "KB"}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m ${String(seconds % 60)}s`;
  }

  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
