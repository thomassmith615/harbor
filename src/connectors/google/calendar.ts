/**
 * The Google Calendar connector.
 *
 * Deliberately the second source, and deliberately one with different sync
 * mechanics from Gmail. Gmail hands out a single monotonic `historyId` for the
 * whole mailbox; Calendar hands out one `syncToken` per calendar, invalidates
 * them with a 410, and reports deletions as events whose status is cancelled.
 * Nothing about that fits Gmail's shape, which is the point: the connector
 * interface had to survive it without being widened.
 *
 * The cursor for this stream is a JSON map of calendar id to sync token. The
 * framework stores it as an opaque string and never looks inside.
 */
import { UpstreamError } from "../../kernel/errors.js";
import { utcOffset } from "../../kernel/time.js";
import { CursorExpiredError } from "../types.js";
import { plausibleTime } from "../../store/items.js";
import type { ItemUpsert } from "../../store/items.js";
import type { SourceConnector, SyncBatch, SyncContext } from "../types.js";

const API = "https://www.googleapis.com/calendar/v3";

export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"] as const;

/** How far back an initial ingest reaches. Older history is rarely worth the calls. */
const BACKFILL_YEARS = 3;

export interface CalendarSummary {
  readonly id: string;
  readonly summary?: string;
  readonly primary?: boolean;
  readonly selected?: boolean;
  readonly accessRole?: string;
  readonly timeZone?: string;
}

export interface CalendarEventTime {
  readonly dateTime?: string;
  readonly date?: string;
  readonly timeZone?: string;
}

export interface CalendarAttendee {
  readonly email?: string;
  readonly displayName?: string;
  readonly responseStatus?: string;
  readonly organizer?: boolean;
  readonly self?: boolean;
}

export interface CalendarEvent {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly htmlLink?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly start?: CalendarEventTime;
  readonly end?: CalendarEventTime;
  readonly organizer?: { readonly email?: string; readonly displayName?: string };
  readonly attendees?: readonly CalendarAttendee[];
  readonly recurringEventId?: string;
  readonly iCalUID?: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Google error bodies are multi-kilobyte JSON documents that push the useful
 * hint off the screen. Pull out the message and drop the rest.
 */
function summarize(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message.length > 300 ? `${message.slice(0, 300)}...` : message;
    }
  } catch {
    // Not JSON. Fall through.
  }

  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

async function call<T>(token: string, path: string, scheme = "Bearer"): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(`${API}${path}`, { headers: { authorization: `${scheme} ${token}` } });
    } catch (cause: unknown) {
      lastError = cause;
      if (attempt === MAX_ATTEMPTS) {
        break;
      }
      await sleep(2 ** attempt * 250 + Math.random() * 250);
      continue;
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const body = await response.text();

    // 410 GONE is Calendar's way of saying the sync token is too old.
    if (response.status === 410) {
      throw new CursorExpiredError("Google Calendar");
    }

    if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
      await sleep(2 ** attempt * 400 + Math.random() * 400);
      continue;
    }

    throw new UpstreamError(
      `Calendar API ${path} returned ${String(response.status)}: ${summarize(body)}`,
      {
      status: response.status,
      hint:
        response.status === 403
          ? "Check that the Google Calendar API is enabled for this project."
          : response.status === 401
            ? "Credentials were rejected. Re-run `harbor auth google`."
            : undefined,
    });
  }

  throw new UpstreamError(`Calendar API ${path} failed after ${String(MAX_ATTEMPTS)} attempts`, {
    cause: lastError,
  });
}

export async function listCalendars(token: string): Promise<readonly CalendarSummary[]> {
  const calendars: CalendarSummary[] = [];
  let pageToken: string | null = null;

  for (;;) {
    const params = new URLSearchParams({ maxResults: "250" });
    if (pageToken !== null) {
      params.set("pageToken", pageToken);
    }

    const page: { items?: readonly CalendarSummary[]; nextPageToken?: string } = await call(
      token,
      `/users/me/calendarList?${params.toString()}`,
    );

    calendars.push(...(page.items ?? []));

    if (page.nextPageToken === undefined) {
      break;
    }
    pageToken = page.nextPageToken;
  }

  // Calendars you have unsubscribed from in the UI are noise, not data.
  return calendars.filter((calendar) => calendar.selected !== false);
}

export interface EventPage {
  readonly events: readonly CalendarEvent[];
  readonly nextPageToken: string | null;
  readonly nextSyncToken: string | null;
}

export async function listEventPage(
  token: string,
  calendarId: string,
  options: {
    readonly syncToken?: string | null;
    readonly pageToken?: string | null;
    readonly timeMin?: string;
    readonly timeMax?: string;
  } = {},
): Promise<EventPage> {
  const params = new URLSearchParams({ maxResults: "250", singleEvents: "true" });

  if (options.syncToken !== undefined && options.syncToken !== null) {
    // timeMin and orderBy are rejected alongside syncToken; the token already
    // encodes the window the first pass established.
    params.set("syncToken", options.syncToken);
  } else {
    params.set("orderBy", "startTime");
    if (options.timeMin !== undefined) {
      params.set("timeMin", options.timeMin);
    }
    if (options.timeMax !== undefined) {
      params.set("timeMax", options.timeMax);
    }
  }

  if (options.pageToken !== undefined && options.pageToken !== null) {
    params.set("pageToken", options.pageToken);
  }

  const page: {
    items?: readonly CalendarEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  } = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);

  return {
    events: page.items ?? [],
    nextPageToken: page.nextPageToken ?? null,
    nextSyncToken: page.nextSyncToken ?? null,
  };
}

/**
 * All-day events carry a bare `date`, which means local midnight in the
 * calendar's zone, not UTC midnight. Reading it as UTC shifts every all-day
 * event onto the wrong day for anyone west of Greenwich.
 */
function localMidnight(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  return Date.parse(`${date}T00:00:00${utcOffset(guess, tz)}`);
}

function resolveTime(time: CalendarEventTime | undefined, tz: string): number | null {
  if (time === undefined) {
    return null;
  }

  if (time.dateTime !== undefined) {
    const parsed = Date.parse(time.dateTime);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (time.date !== undefined) {
    return localMidnight(time.date, time.timeZone ?? tz);
  }

  return null;
}

function attendeeAddresses(event: CalendarEvent): readonly string[] {
  const addresses: string[] = [];

  for (const attendee of event.attendees ?? []) {
    // Plain addresses only. Response status used to be appended here and it
    // made every attendee unparseable as an identity; it lives in `raw`, which
    // is where source-specific detail belongs.
    const address = attendee.email ?? attendee.displayName;
    if (address !== undefined && address.length > 0) {
      addresses.push(address);
    }
  }

  return addresses;
}

/**
 * Maps a Calendar event onto the universal item shape.
 *
 * Attendees map onto `participants` and the organizer onto `author` without
 * strain, which is the useful signal that the schema generalizes. Location,
 * recurrence rules, conferencing links, and response detail stay in `raw` and
 * will surface through a projection rather than through more columns.
 */
export function toItem(
  context: SyncContext,
  calendarId: string,
  event: CalendarEvent,
): ItemUpsert | null {
  const rawStart = resolveTime(event.start, context.timezone);

  if (rawStart === null) {
    return null;
  }

  // Events are allowed to be in the future; that is what a calendar is for.
  const start = plausibleTime(rawStart, Date.now(), { allowFuture: true });

  const end = resolveTime(event.end, context.timezone);
  const updated = event.updated === undefined ? null : Date.parse(event.updated);

  const descriptionParts: string[] = [];
  if (event.location !== undefined && event.location.length > 0) {
    descriptionParts.push(`Location: ${event.location}`);
  }
  if (event.description !== undefined && event.description.length > 0) {
    descriptionParts.push(event.description);
  }

  const body = descriptionParts.join("\n\n");

  return {
    accountId: context.accountId,
    streamId: context.streamId,
    // Event ids are unique per calendar, not per account.
    externalId: `${calendarId}:${event.id}`,
    kind: "event",
    // Direction is a messaging concept. An event does not have one.
    threadId: event.recurringEventId ?? null,
    title: event.summary ?? "(no title)",
    body: body.length === 0 ? null : body.slice(0, 8_000),
    snippet: event.location ?? (event.summary ?? null),
    author: event.organizer?.email ?? event.organizer?.displayName ?? null,
    participants: attendeeAddresses(event),
    occurredAt: start,
    endsAt: end,
    sourceUpdatedAt: updated !== null && Number.isFinite(updated) ? updated : null,
    uri: event.htmlLink ?? null,
    raw: { calendarId, event },
  };
}

/** The stream cursor: one sync token per calendar, stored as one opaque string. */
type CalendarCursor = Record<string, string>;

function parseCursor(cursor: string | null): CalendarCursor {
  if (cursor === null || cursor.length === 0) {
    return {};
  }

  try {
    return JSON.parse(cursor) as CalendarCursor;
  } catch {
    return {};
  }
}

export const calendarConnector: SourceConnector = {
  id: "calendar",
  sourceType: "google",
  label: "Google Calendar",
  scopes: CALENDAR_SCOPES,
  kinds: ["event"],

  async watermark(): Promise<string | null> {
    // Calendar's watermark only exists as the sync token handed back at the end
    // of a full pass, so there is nothing meaningful to capture up front. The
    // backfill below emits it as it goes.
    return null;
  },

  async *backfill(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch> {
    const calendars = await listCalendars(context.token);
    const tokens = parseCursor(cursor);

    // The engine decides the slice; the constant is only the fallback for a
    // caller that did not supply one.
    const timeMin = new Date(
      context.window?.since ?? Date.now() - BACKFILL_YEARS * 365 * 24 * 3_600_000,
    ).toISOString();

    const timeMax =
      context.window?.until === null || context.window?.until === undefined
        ? undefined
        : new Date(context.window.until).toISOString();

    for (const calendar of calendars) {
      // A calendar already carrying a sync token finished in an earlier run.
      if (tokens[calendar.id] !== undefined) {
        continue;
      }

      let pageToken: string | null = null;

      for (;;) {
        const page: EventPage = await listEventPage(context.token, calendar.id, {
          pageToken,
          timeMin,
          ...(timeMax === undefined ? {} : { timeMax }),
        });

        const upserts: ItemUpsert[] = [];
        const deletes: string[] = [];

        for (const event of page.events) {
          if (event.status === "cancelled") {
            deletes.push(`${calendar.id}:${event.id}`);
            continue;
          }

          const item = toItem(context, calendar.id, event);
          if (item !== null) {
            upserts.push(item);
          }
        }

        if (page.nextSyncToken !== null) {
          tokens[calendar.id] = page.nextSyncToken;
        }

        yield {
          upserts,
          deletes,
          cursor: JSON.stringify(tokens),
          progress: { total: null },
          note:
            page.nextPageToken === null
              ? `${calendar.summary ?? calendar.id}: complete`
              : undefined,
        };

        if (page.nextPageToken === null) {
          break;
        }
        pageToken = page.nextPageToken;
      }
    }
  },

  async *incremental(context: SyncContext, cursor: string): AsyncGenerator<SyncBatch> {
    const calendars = await listCalendars(context.token);
    const tokens = parseCursor(cursor);

    for (const calendar of calendars) {
      const syncToken = tokens[calendar.id];

      // A calendar added since the last run has no token, so it needs a first
      // pass rather than an incremental one. The engine handles that by
      // treating a missing token as a reason to backfill just this calendar.
      if (syncToken === undefined) {
        continue;
      }

      let pageToken: string | null = null;

      for (;;) {
        const page: EventPage = await listEventPage(context.token, calendar.id, {
          syncToken,
          pageToken,
        });

        const upserts: ItemUpsert[] = [];
        const deletes: string[] = [];

        for (const event of page.events) {
          if (event.status === "cancelled") {
            deletes.push(`${calendar.id}:${event.id}`);
            continue;
          }

          const item = toItem(context, calendar.id, event);
          if (item !== null) {
            upserts.push(item);
          }
        }

        if (page.nextSyncToken !== null) {
          tokens[calendar.id] = page.nextSyncToken;
        }

        yield {
          upserts,
          deletes,
          cursor: JSON.stringify(tokens),
          progress: { total: null },
        };

        if (page.nextPageToken === null) {
          break;
        }
        pageToken = page.nextPageToken;
      }
    }
  },
};
