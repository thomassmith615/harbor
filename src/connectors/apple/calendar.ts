/**
 * The Apple Calendar connector.
 *
 * Third source, third sync mechanic. Gmail has a monotonic `historyId`, Google
 * Calendar has a per-calendar `syncToken` invalidated with a 410, and CalDAV has
 * a `ctag` per collection that changes when anything inside changes and tells
 * you nothing about what.
 *
 * That last one is the crude option and it is the one iCloud implements most
 * reliably. So: read the ctag, and if it moved, re-query the window. Upserts
 * are content-hashed, so re-reading five hundred events writes zero rows when
 * nothing changed, and the cost is network rather than storage or derivation.
 * `sync-collection` (RFC 6578) would be the refinement; iCloud's support for it
 * is inconsistent enough that the crude path is the honest default.
 *
 * The connector interface did not have to widen to accommodate any of this,
 * which is the useful thing a third source proves.
 */
import { localTimeToInstant } from "../../kernel/time.js";
import {
  CALDAV_ROOT,
  collectionCtag,
  discoverHome,
  discoverPrincipal,
  fetchEvents,
  listCollections,
} from "./dav.js";
import { parseEvents, resolveTime } from "./ical.js";
import { plausibleTime } from "../../store/items.js";
import type { ItemUpsert } from "../../store/items.js";
import type { SourceConnector, SyncBatch, SyncContext } from "../types.js";
import type { VEvent } from "./ical.js";

/** How far back an initial ingest reaches, and how far forward. */
const BACKFILL_YEARS = 3;
const FORWARD_YEARS = 2;

function windowFor(
  now: number,
  requested: { since: number | null; until: number | null } | undefined,
): { readonly from: number; readonly to: number } {
  return {
    from: requested?.since ?? now - BACKFILL_YEARS * 365 * 86_400_000,
    // Calendars are the one source where the future matters, so an open-ended
    // window still reaches forward rather than stopping at today.
    to: requested?.until ?? now + FORWARD_YEARS * 365 * 86_400_000,
  };
}

function localMidnight(date: string, tz: string): number {
  return localTimeToInstant(date, 0, 0, tz);
}

/**
 * The stream cursor: one ctag per collection, plus the collection's name so a
 * calendar that gets renamed does not read as a new one.
 */
interface CalendarCursor {
  readonly [url: string]: { readonly ctag: string | null };
}

function parseCursor(cursor: string | null): Record<string, { ctag: string | null }> {
  if (cursor === null || cursor.length === 0) {
    return {};
  }

  try {
    return JSON.parse(cursor) as Record<string, { ctag: string | null }>;
  } catch {
    return {};
  }
}

function toItem(
  context: SyncContext,
  collectionUrl: string,
  displayName: string,
  event: VEvent,
): ItemUpsert | null {
  const rawStart = resolveTime(event.start, context.timezone, localMidnight);

  if (rawStart === null || event.uid.length === 0) {
    return null;
  }

  // Events reach into the future legitimately, but not to 2056. A single event
  // with a broken date became the store's stated coverage ceiling, which is
  // what the model reads to decide what it can and cannot see.
  const start = plausibleTime(rawStart, Date.now(), { allowFuture: true });
  const end = resolveTime(event.end, context.timezone, localMidnight);

  const descriptionParts: string[] = [];

  if (event.location !== null && event.location.length > 0) {
    descriptionParts.push(`Location: ${event.location}`);
  }

  if (event.description !== null && event.description.length > 0) {
    descriptionParts.push(event.description);
  }

  const body = descriptionParts.join("\n\n");

  // An expanded recurring instance shares a UID with its siblings, so the
  // recurrence id has to be part of the external id or every instance of a
  // weekly standup collapses onto one row.
  const externalId =
    event.recurrenceId === null
      ? `${collectionUrl}#${event.uid}`
      : `${collectionUrl}#${event.uid}#${event.recurrenceId}`;

  return {
    accountId: context.accountId,
    streamId: context.streamId,
    externalId,
    kind: "event",
    threadId: event.recurrenceId === null ? null : event.uid,
    title: event.summary ?? "(no title)",
    body: body.length === 0 ? null : body.slice(0, 8_000),
    snippet: event.location ?? event.summary,
    author: event.organizer,
    participants: event.attendees,
    occurredAt: start,
    endsAt: end,
    sourceUpdatedAt:
      event.lastModified === null ? null : (Date.parse(event.lastModified) || null),
    uri: event.url,
    raw: { calendar: displayName, collectionUrl, event },
  };
}

async function collections(context: SyncContext): Promise<
  readonly { readonly url: string; readonly displayName: string; readonly ctag: string | null }[]
> {
  const principal = await discoverPrincipal(CALDAV_ROOT, authHeader(context));
  const home = await discoverHome(CALDAV_ROOT, principal, authHeader(context), "calendar");
  return await listCollections(CALDAV_ROOT, home, authHeader(context), "VEVENT");
}

function authHeader(context: SyncContext): string {
  return `${context.authScheme} ${context.token}`;
}

async function* walk(
  context: SyncContext,
  cursor: string | null,
  onlyChanged: boolean,
): AsyncGenerator<SyncBatch> {
  const known = parseCursor(cursor);
  const next: Record<string, { ctag: string | null }> = { ...known };
  const { from, to } = windowFor(Date.now(), context.window);

  for (const collection of await collections(context)) {
    const current = collection.ctag ?? (await collectionCtag(collection.url, authHeader(context)));

    if (onlyChanged && current !== null && known[collection.url]?.ctag === current) {
      // Nothing in this calendar moved. The whole point of the ctag.
      continue;
    }

    const resources = await fetchEvents(collection.url, authHeader(context), from, to);
    const upserts: ItemUpsert[] = [];
    const deletes: string[] = [];

    for (const resource of resources) {
      for (const event of parseEvents(resource.data)) {
        if ((event.status ?? "").toUpperCase() === "CANCELLED") {
          deletes.push(`${collection.url}#${event.uid}`);
          continue;
        }

        const item = toItem(context, collection.url, collection.displayName, event);

        if (item !== null) {
          upserts.push(item);
        }
      }
    }

    next[collection.url] = { ctag: current };

    yield {
      upserts,
      deletes,
      cursor: JSON.stringify(next),
      progress: { total: null },
      note: `${collection.displayName}: ${String(upserts.length)} events`,
    };
  }

  // Calendars deleted upstream leave a stale cursor entry. Harmless, and
  // cleaning it up here keeps the cursor from growing forever.
  yield { upserts: [], cursor: JSON.stringify(next), progress: { total: null } };
}

export const appleCalendarConnector: SourceConnector = {
  id: "apple-calendar",
  sourceType: "apple",
  label: "Apple Calendar",
  // DAV has no scopes. Access is the credential.
  scopes: [],
  kinds: ["event"],

  async watermark(): Promise<string | null> {
    // Ctags are per collection and only meaningful once read alongside the
    // data, so there is no single up-front watermark to capture.
    return null;
  },

  async *backfill(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor, false);
  },

  async *incremental(context: SyncContext, cursor: string): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor, true);
  },
};

export type { CalendarCursor };
