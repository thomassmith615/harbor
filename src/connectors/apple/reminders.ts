/**
 * Apple Reminders.
 *
 * The cheapest source in the project. Reminders are VTODO components on the
 * same CalDAV endpoint Harbor already talks to, using the same app-specific
 * password and the same ctag machinery, so this is a parser and a mapping
 * rather than a new integration.
 *
 * Worth having because a reminder is the one thing in the store that is
 * explicitly a commitment. Everything else is a message that might imply one.
 */
import { UpstreamError } from "../../kernel/errors.js";
import { localTimeToInstant } from "../../kernel/time.js";
import { CALDAV_ROOT, collectionCtag, dav, discoverHome, discoverPrincipal, listCollections } from "./dav.js";
import { escapeXml, findAll, findFirst, textOf } from "./xml.js";
import { parseLine, resolveTime, unescapeText, unfold } from "./ical.js";
import type { ICalProperty } from "./ical.js";
import { plausibleTime } from "../../store/items.js";
import type { ItemUpsert } from "../../store/items.js";
import type { SourceConnector, SyncBatch, SyncContext } from "../types.js";

export interface VTodo {
  readonly uid: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly status: string | null;
  readonly rrule: string | null;
  readonly recurrenceId: string | null;
  readonly due: ICalProperty | null;
  readonly completed: ICalProperty | null;
  readonly created: ICalProperty | null;
  readonly priority: number | null;
  readonly percent: number | null;
}

/**
 * VTODO components.
 *
 * Same folding and escaping rules as VEVENT, different component name and a
 * different set of properties. VALARM is skipped by depth, as it is in events.
 */
export function parseTodos(source: string): readonly VTodo[] {
  const todos: VTodo[] = [];

  let current: Map<string, ICalProperty[]> | null = null;
  let depth = 0;

  for (const line of unfold(source)) {
    const property = parseLine(line);

    if (property === null) {
      continue;
    }

    if (property.name === "BEGIN") {
      if (property.value.toUpperCase() === "VTODO" && depth === 0) {
        current = new Map();
        depth = 1;
        continue;
      }

      if (current !== null) {
        depth += 1;
      }

      continue;
    }

    if (property.name === "END") {
      if (property.value.toUpperCase() === "VTODO" && current !== null && depth === 1) {
        todos.push(materialize(current));
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

  return todos;
}

function materialize(properties: Map<string, ICalProperty[]>): VTodo {
  const first = (name: string): ICalProperty | undefined => properties.get(name)?.[0];
  const text = (name: string): string | null => {
    const property = first(name);
    return property === undefined ? null : unescapeText(property.value);
  };

  const number = (name: string): number | null => {
    const raw = text(name);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    uid: text("UID") ?? "",
    summary: text("SUMMARY"),
    description: text("DESCRIPTION"),
    status: text("STATUS"),
    due: first("DUE") ?? null,
    completed: first("COMPLETED") ?? null,
    created: first("CREATED") ?? null,
    priority: number("PRIORITY"),
    percent: number("PERCENT-COMPLETE"),
    rrule: text("RRULE"),
    // An override for one occurrence of a repeating reminder. It shares a UID
    // with its parent, so without this the two collide on external id and
    // whichever arrives last wins, which is a plausible way for a completed
    // instance to look open.
    recurrenceId: text("RECURRENCE-ID"),
  };
}

function localMidnight(date: string, tz: string): number {
  return localTimeToInstant(date, 0, 0, tz);
}

/**
 * Reminder lists.
 *
 * The same home as calendars, filtered the other way: a collection that
 * supports VTODO is a list, one that supports VEVENT is a calendar. iCloud
 * returns both from one PROPFIND, which is why `listCollections` takes the
 * component it wants.
 */
async function lists(context: SyncContext): Promise<
  readonly { readonly url: string; readonly displayName: string; readonly ctag: string | null }[]
> {
  const authorization = `${context.authScheme} ${context.token}`;
  const principal = await discoverPrincipal(CALDAV_ROOT, authorization);
  const home = await discoverHome(CALDAV_ROOT, principal, authorization, "calendar");

  return await listCollections(CALDAV_ROOT, home, authorization, "VTODO");
}

async function fetchTodos(
  collectionUrl: string,
  authorization: string,
): Promise<readonly { readonly href: string; readonly data: string }[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const document = await dav({
    method: "REPORT",
    url: collectionUrl,
    authorization,
    depth: "1",
    body: escapeXml("") === "" ? body : body,
  });

  const found: { href: string; data: string }[] = [];

  for (const response of findAll(document, "response")) {
    const data = textOf(findFirst(response, "calendar-data"));

    if (data.length > 0) {
      found.push({ href: textOf(findFirst(response, "href")), data });
    }
  }

  return found;
}

function toItem(
  context: SyncContext,
  collectionUrl: string,
  listName: string,
  todo: VTodo,
): ItemUpsert | null {
  if (todo.uid.length === 0 || todo.summary === null) {
    return null;
  }

  const due = resolveTime(todo.due, context.timezone, localMidnight);
  const completed = resolveTime(todo.completed, context.timezone, localMidnight);
  const created = resolveTime(todo.created, context.timezone, localMidnight);

  // A reminder's moment is when it is due; failing that, when it was written.
  // Neither is a great answer for something that is really a standing
  // intention, but a due date is what a person would search for.
  const rawOccurred = due ?? created ?? completed;

  if (rawOccurred === null) {
    return null;
  }

  // A reminder can be due in the future; that is the point of a reminder.
  const occurredAt = plausibleTime(rawOccurred, Date.now(), { allowFuture: true });

  // Three signals, any of which means done. iCloud is inconsistent about which
  // it sends: some clients set STATUS, some only stamp COMPLETED, and some only
  // move PERCENT-COMPLETE to 100. Requiring one particular field is how a
  // reminder somebody ticked off stays open forever.
  const done =
    (todo.status ?? "").toUpperCase() === "COMPLETED" ||
    completed !== null ||
    (todo.percent ?? 0) >= 100;

  const lines: string[] = [];

  if (done) {
    lines.push("Completed");
  }
  if (todo.description !== null && todo.description.length > 0) {
    lines.push(todo.description);
  }

  return {
    accountId: context.accountId,
    streamId: context.streamId,
    // The recurrence id joins the key so an override does not overwrite its
    // parent. Absent for ordinary reminders, so their ids are unchanged.
    externalId:
      todo.recurrenceId === null
        ? `${collectionUrl}#${todo.uid}`
        : `${collectionUrl}#${todo.uid}#${todo.recurrenceId}`,
    kind: "task",
    threadId: null,
    title: todo.summary,
    body: lines.length === 0 ? null : lines.join("\n\n"),
    snippet: listName,
    author: null,
    participants: [],
    occurredAt,
    endsAt: null,
    // The state a reminder is really about. Kept out of `raw` on purpose:
    // "what have I still not done" is the question this source exists to
    // answer, and it cannot be asked of a gzipped payload.
    state: done ? "completed" : "open",
    dueAt: due,
    recurrence: todo.rrule,
    sourceUpdatedAt: completed,
    uri: null,
    raw: { list: listName, collectionUrl, todo, done },
  };
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

async function* walk(
  context: SyncContext,
  cursor: string | null,
  onlyChanged: boolean,
): AsyncGenerator<SyncBatch> {
  const authorization = `${context.authScheme} ${context.token}`;
  const known = parseCursor(cursor);
  const next: Record<string, { ctag: string | null }> = { ...known };

  let collections: Awaited<ReturnType<typeof lists>>;

  try {
    collections = await lists(context);
  } catch (cause: unknown) {
    throw new UpstreamError("Could not list reminder lists", { cause });
  }

  for (const collection of collections) {
    const current = collection.ctag ?? (await collectionCtag(collection.url, authorization));

    if (onlyChanged && current !== null && known[collection.url]?.ctag === current) {
      continue;
    }

    const resources = await fetchTodos(collection.url, authorization);
    const upserts: ItemUpsert[] = [];

    for (const resource of resources) {
      for (const todo of parseTodos(resource.data)) {
        const item = toItem(context, collection.url, collection.displayName, todo);

        if (item !== null) {
          upserts.push(item);
        }
      }
    }

    next[collection.url] = { ctag: current };

    yield {
      upserts,
      cursor: JSON.stringify(next),
      progress: { total: null },
      note: `${collection.displayName}: ${String(upserts.length)} reminders`,
    };
  }

  yield { upserts: [], cursor: JSON.stringify(next), progress: { total: null } };
}

export const appleRemindersConnector: SourceConnector = {
  id: "apple-reminders",
  sourceType: "apple",
  label: "Apple Reminders",
  scopes: [],
  kinds: ["task"],

  async watermark(): Promise<string | null> {
    return null;
  },

  async *backfill(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor, false);
  },

  async *incremental(context: SyncContext, cursor: string): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor, true);
  },
};
