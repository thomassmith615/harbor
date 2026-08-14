/**
 * The connector registry.
 *
 * Adding a source is: implement SourceConnector, add one line here. Nothing
 * else in Harbor learns its name. That is the whole claim of the "sources, not
 * capabilities" design, and it is worth keeping this file boring enough that
 * the claim stays true.
 */
import { gmailConnector } from "./google/gmail.js";
import { calendarConnector } from "./google/calendar.js";
import { appleCalendarConnector } from "./apple/calendar.js";
import { appleContactsConnector } from "./apple/contacts.js";
import { appleRemindersConnector } from "./apple/reminders.js";
import { imessageConnector } from "./imessage/messages.js";
import { imapConnector } from "./imap/mail.js";
import { actionScopes } from "../actions/registry.js";
import type { SourceConnector } from "./types.js";

export const CONNECTORS: readonly SourceConnector[] = [
  gmailConnector,
  calendarConnector,
  appleCalendarConnector,
  appleContactsConnector,
  appleRemindersConnector,
  imessageConnector,
  imapConnector,
];

/** Source types Harbor can authenticate. */
export const SOURCE_TYPES: readonly string[] = [
  ...new Set(CONNECTORS.map((connector) => connector.sourceType)),
];

export function connectorsFor(sourceType: string): readonly SourceConnector[] {
  return CONNECTORS.filter((connector) => connector.sourceType === sourceType);
}

export function connectorById(id: string): SourceConnector | null {
  return CONNECTORS.find((connector) => connector.id === id) ?? null;
}

/**
 * Every scope a source type needs, which is what `harbor auth` requests.
 *
 * Write scopes come from the action registry rather than being listed on a
 * connector, so the moment Harbor gains the ability to change something in your
 * account, the widened permission appears here and nowhere else.
 */
export function scopesFor(sourceType: string): readonly string[] {
  const scopes = new Set<string>();

  for (const connector of connectorsFor(sourceType)) {
    for (const scope of connector.scopes) {
      scopes.add(scope);
    }
  }

  if (sourceType === "google") {
    for (const scope of actionScopes()) {
      scopes.add(scope);
    }
  }

  return [...scopes];
}

/** Connectors whose scopes an existing grant does not cover. */
export function missingScopes(sourceType: string, granted: string): readonly string[] {
  const held = new Set(granted.split(/\s+/).filter((scope) => scope.length > 0));
  return scopesFor(sourceType).filter((scope) => !held.has(scope));
}
