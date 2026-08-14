/**
 * iCalendar parsing, for the subset CalDAV actually returns.
 *
 * Two things make this smaller than it looks. The server expands recurrences
 * for us, so there is no RRULE engine here. And expanded instances are
 * required to be in UTC, so the TZID minefield mostly disappears; the exception
 * is all-day events, which carry a bare DATE and mean local midnight.
 *
 * The line format is the part people get wrong. Lines fold at 75 octets and
 * continue with a leading space or tab, and unfolding has to happen before any
 * other parsing or a long SUMMARY silently loses its middle.
 */

export interface ICalProperty {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

export interface VEvent {
  readonly uid: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly status: string | null;
  readonly organizer: string | null;
  readonly attendees: readonly string[];
  readonly start: ICalProperty | null;
  readonly end: ICalProperty | null;
  readonly recurrenceId: string | null;
  readonly lastModified: string | null;
  readonly url: string | null;
}

/** Undoes RFC 5545 line folding. Must run before anything else touches the text. */
export function unfold(source: string): readonly string[] {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines: string[] = [];

  for (const raw of normalized.split("\n")) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
      continue;
    }

    lines.push(raw);
  }

  return lines.filter((line) => line.trim().length > 0);
}

/** Text values escape commas, semicolons, backslashes, and newlines. */
export function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export function parseLine(line: string): ICalProperty | null {
  // The colon that separates name+params from value is the first one that is
  // not inside a quoted parameter value.
  let colon = -1;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ":" && !inQuotes) {
      colon = index;
      break;
    }
  }

  if (colon === -1) {
    return null;
  }

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const pieces = head.split(";");
  const name = (pieces[0] ?? "").toUpperCase();
  const params: Record<string, string> = {};

  for (const piece of pieces.slice(1)) {
    const equals = piece.indexOf("=");

    if (equals === -1) {
      continue;
    }

    params[piece.slice(0, equals).toUpperCase()] = piece
      .slice(equals + 1)
      .replace(/^"|"$/g, "");
  }

  return { name, params, value };
}

function addressOf(property: ICalProperty | undefined): string | null {
  if (property === undefined) {
    return null;
  }

  const mailto = /^mailto:(.+)$/i.exec(property.value.trim());
  const address = mailto?.[1] ?? property.value.trim();
  const common = property.params["CN"];

  if (address.length === 0) {
    return common ?? null;
  }

  return common === undefined ? address : `${common} <${address}>`;
}

/** Every VEVENT in a document. VTIMEZONE and VALARM are skipped by nesting depth. */
export function parseEvents(source: string): readonly VEvent[] {
  const events: VEvent[] = [];

  let current: Map<string, ICalProperty[]> | null = null;
  let depth = 0;

  for (const line of unfold(source)) {
    const property = parseLine(line);

    if (property === null) {
      continue;
    }

    if (property.name === "BEGIN") {
      if (property.value.toUpperCase() === "VEVENT" && depth === 0) {
        current = new Map();
        depth = 1;
        continue;
      }

      if (current !== null) {
        // A VALARM inside the event. Skip its contents wholesale.
        depth += 1;
      }

      continue;
    }

    if (property.name === "END") {
      if (property.value.toUpperCase() === "VEVENT" && current !== null && depth === 1) {
        events.push(materialize(current));
        current = null;
        depth = 0;
        continue;
      }

      if (current !== null && depth > 1) {
        depth -= 1;
      }

      continue;
    }

    if (current === null || depth !== 1) {
      continue;
    }

    const existing = current.get(property.name) ?? [];
    existing.push(property);
    current.set(property.name, existing);
  }

  return events;
}

function materialize(properties: Map<string, ICalProperty[]>): VEvent {
  const first = (name: string): ICalProperty | undefined => properties.get(name)?.[0];
  const text = (name: string): string | null => {
    const property = first(name);
    return property === undefined ? null : unescapeText(property.value);
  };

  return {
    uid: text("UID") ?? "",
    summary: text("SUMMARY"),
    description: text("DESCRIPTION"),
    location: text("LOCATION"),
    status: text("STATUS"),
    organizer: addressOf(first("ORGANIZER")),
    attendees: (properties.get("ATTENDEE") ?? [])
      .map((property) => addressOf(property))
      .filter((entry): entry is string => entry !== null),
    start: first("DTSTART") ?? null,
    end: first("DTEND") ?? null,
    recurrenceId: first("RECURRENCE-ID")?.value ?? null,
    lastModified: text("LAST-MODIFIED"),
    url: text("URL"),
  };
}

/**
 * Resolves a DTSTART or DTEND to an instant.
 *
 * Three forms in practice. UTC with a Z, which is what expanded instances use.
 * A bare DATE, which means local midnight in the viewer's zone. And a local
 * datetime with a TZID, which should not appear post-expansion but is handled
 * by falling back to the store timezone rather than silently reading it as UTC.
 */
export function resolveTime(
  property: ICalProperty | null,
  timezone: string,
  localMidnight: (date: string, tz: string) => number,
): number | null {
  if (property === null) {
    return null;
  }

  const value = property.value.trim();

  if (property.params["VALUE"] === "DATE" || /^\d{8}$/.test(value)) {
    const year = value.slice(0, 4);
    const month = value.slice(4, 6);
    const day = value.slice(6, 8);
    return localMidnight(`${year}-${month}-${day}`, timezone);
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);

  if (match === null) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const [, year, month, day, hour, minute, second, zulu] = match;
  const stamp = `${year ?? ""}-${month ?? ""}-${day ?? ""}T${hour ?? ""}:${minute ?? ""}:${second ?? ""}`;

  if (zulu === "Z") {
    return Date.parse(`${stamp}Z`);
  }

  // Floating or TZID-qualified. Read it in the store's zone, which is right for
  // a floating time and close enough for the rare unexpanded TZID.
  const guess = Date.parse(`${stamp}Z`);
  const offset = offsetAt(guess, timezone);
  return Date.parse(`${stamp}${offset}`);
}

function offsetAt(ms: number, tz: string): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(new Date(ms))
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";

  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return match === null ? "+00:00" : `${match[1] ?? "+"}${match[2] ?? "00"}:${match[3] ?? "00"}`;
}
