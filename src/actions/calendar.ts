/**
 * Calendar write actions.
 *
 * Three, because scheduling is the daily-use pillar that needs them: create,
 * move, cancel. Each declares how to verify itself by reading the event back
 * from Google, not by trusting the response code.
 *
 * These need `calendar.events`, which is a genuine widening of what Harbor can
 * do to your account. It is requested only because these actions exist, and it
 * is the reason the approval gate in `types.ts` is not optional.
 */
import { UpstreamError } from "../kernel/errors.js";
import { localIso } from "../kernel/time.js";
import type { ActionContext, ActionSpec } from "./types.js";

const API = "https://www.googleapis.com/calendar/v3";

export const CALENDAR_WRITE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
] as const;

interface EventResource {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly htmlLink?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string };
}

async function call<T>(
  token: string,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    const body = await response.text();
    let message = body;

    try {
      message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
    } catch {
      // Not JSON.
    }

    throw new UpstreamError(
      `Calendar write ${path} returned ${String(response.status)}: ${message.slice(0, 300)}`,
      {
        status: response.status,
        hint:
          response.status === 403
            ? "Harbor may not have the calendar.events scope. Re-run `harbor auth google`."
            : undefined,
      },
    );
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function calendarId(args: Record<string, unknown>): string {
  const value = args["calendarId"];
  return typeof value === "string" && value.length > 0 ? value : "primary";
}

/** Within a minute counts as the same time; Google normalizes seconds. */
function sameInstant(a: string | undefined, b: string): boolean {
  if (a === undefined) {
    return false;
  }

  const left = Date.parse(a);
  const right = Date.parse(b);

  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 60_000;
}

export const createEvent: ActionSpec = {
  id: "calendar.create_event",
  connectorId: "calendar",
  description: "Create a calendar event.",
  scopes: CALENDAR_WRITE_SCOPES,

  summarize(args: Record<string, unknown>): string {
    const title = typeof args["title"] === "string" ? args["title"] : "(untitled)";
    const start = typeof args["start"] === "string" ? args["start"] : "?";
    const attendees = Array.isArray(args["attendees"]) ? (args["attendees"] as string[]) : [];

    return (
      `Create "${title}" starting ${start}` +
      (attendees.length === 0 ? "" : ` with ${attendees.join(", ")}`)
    );
  },

  async execute(context: ActionContext, args: Record<string, unknown>) {
    const start = requireString(args, "start");
    const end = requireString(args, "end");

    const attendees = Array.isArray(args["attendees"])
      ? (args["attendees"] as string[]).map((email) => ({ email }))
      : [];

    const event = await call<EventResource>(
      context.token,
      `/calendars/${encodeURIComponent(calendarId(args))}/events`,
      {
        method: "POST",
        body: {
          summary: requireString(args, "title"),
          ...(typeof args["description"] === "string"
            ? { description: args["description"] }
            : {}),
          ...(typeof args["location"] === "string" ? { location: args["location"] } : {}),
          start: { dateTime: start, timeZone: context.timezone },
          end: { dateTime: end, timeZone: context.timezone },
          ...(attendees.length === 0 ? {} : { attendees }),
        },
      },
    );

    return {
      externalId: event.id,
      detail: event.htmlLink ?? event.id,
    };
  },

  async verify(context: ActionContext, args: Record<string, unknown>, externalId: string) {
    const event = await call<EventResource>(
      context.token,
      `/calendars/${encodeURIComponent(calendarId(args))}/events/${encodeURIComponent(externalId)}`,
    );

    return (
      event.status !== "cancelled" &&
      event.summary === args["title"] &&
      sameInstant(event.start?.dateTime, requireString(args, "start"))
    );
  },
};

export const moveEvent: ActionSpec = {
  id: "calendar.move_event",
  connectorId: "calendar",
  description: "Change the time of an existing event.",
  scopes: CALENDAR_WRITE_SCOPES,

  summarize(args: Record<string, unknown>): string {
    const title = typeof args["title"] === "string" ? args["title"] : (args["eventId"] as string);
    return `Move "${String(title)}" to ${String(args["start"])}`;
  },

  async execute(context: ActionContext, args: Record<string, unknown>) {
    const eventId = requireString(args, "eventId");
    const start = requireString(args, "start");
    const end = requireString(args, "end");

    const event = await call<EventResource>(
      context.token,
      `/calendars/${encodeURIComponent(calendarId(args))}/events/${encodeURIComponent(eventId)}`,
      {
        method: "PATCH",
        body: {
          start: { dateTime: start, timeZone: context.timezone },
          end: { dateTime: end, timeZone: context.timezone },
        },
      },
    );

    return { externalId: event.id, detail: event.htmlLink ?? event.id };
  },

  async verify(context: ActionContext, args: Record<string, unknown>, externalId: string) {
    const event = await call<EventResource>(
      context.token,
      `/calendars/${encodeURIComponent(calendarId(args))}/events/${encodeURIComponent(externalId)}`,
    );

    return event.status !== "cancelled" && sameInstant(event.start?.dateTime, requireString(args, "start"));
  },
};

export const cancelEvent: ActionSpec = {
  id: "calendar.cancel_event",
  connectorId: "calendar",
  description: "Cancel an event.",
  scopes: CALENDAR_WRITE_SCOPES,

  summarize(args: Record<string, unknown>): string {
    const title = typeof args["title"] === "string" ? args["title"] : (args["eventId"] as string);
    return `Cancel "${String(title)}"`;
  },

  async execute(context: ActionContext, args: Record<string, unknown>) {
    const eventId = requireString(args, "eventId");

    await call(
      context.token,
      `/calendars/${encodeURIComponent(calendarId(args))}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );

    return { externalId: eventId, detail: "deleted" };
  },

  async verify(context: ActionContext, args: Record<string, unknown>, externalId: string) {
    try {
      const event = await call<EventResource>(
        context.token,
        `/calendars/${encodeURIComponent(calendarId(args))}/events/${encodeURIComponent(externalId)}`,
      );

      return event.status === "cancelled";
    } catch (error: unknown) {
      // A 404 or 410 is the event being gone, which is what we asked for.
      if (error instanceof UpstreamError && (error.status === 404 || error.status === 410)) {
        return true;
      }

      throw error;
    }
  },
};

export const CALENDAR_ACTIONS: readonly ActionSpec[] = [createEvent, moveEvent, cancelEvent];

/** Formats an instant the way these actions want it, for CLI convenience. */
export function toActionTime(ms: number, timezone: string): string {
  return localIso(ms, timezone);
}
