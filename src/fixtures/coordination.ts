/**
 * Scenarios for the coordination suite, and how one gets into a store.
 *
 * A scenario is a small, complete world: a handful of observations across
 * several sources, plus the partition that a person who was there would give.
 * The partition is the whole value. Harbor has had fixtures since early on and
 * every one of them asserts that a particular thing was found; none of them
 * asserts what the *rest* of the store should have looked like, so a build that
 * found the right evening and also fused it with a different one passed.
 *
 * The DSL is deliberately thin. Times are relative offsets in minutes from the
 * scenario's anchor, because every one of these cases is about temporal
 * structure and absolute timestamps in a fixture are unreadable. Sources are
 * named rather than constructed, because what matters to the algorithm is which
 * kind of thing an observation is, not which account it came from.
 */
import { saveAccount } from "../store/accounts.js";
import { ensureStream } from "../store/streams.js";
import { upsertItem } from "../store/items.js";
import { saveReaction } from "../store/reactions.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";
import type { Gold } from "../eval/coordination.js";

const MINUTE = 60_000;

export type Source = "chat" | "mail" | "calendar" | "reminders";

export interface Observation {
  /** Stable within the scenario. Gold labels refer to these. */
  readonly id: string;
  readonly source: Source;
  readonly kind?: "message" | "event" | "task";
  /** Minutes from the scenario anchor. Negative is before. */
  readonly at: number;
  readonly endsAt?: number;
  /** Chat thread or mail thread. Messages in one thread become one episode. */
  readonly thread?: string;
  readonly title?: string;
  readonly body?: string;
  /** Who sent it. Omit for the user. */
  readonly from?: string;
  readonly people?: readonly string[];
  readonly state?: string;
  /** A tapback on another observation in this scenario. */
  readonly reactionTo?: string;
  readonly reaction?: "like" | "love";
}

export interface Scenario {
  readonly name: string;
  /** What this case is testing, and why simplistic similarity fails on it. */
  readonly about: string;
  readonly timezone: string;
  /** Absolute anchor, so every scenario sits at a known wall-clock time. */
  readonly anchor: number;
  readonly observations: readonly Observation[];
  readonly gold: Gold;
}

const CONNECTORS: Readonly<Record<Source, { type: string; connector: string; label: string }>> = {
  chat: { type: "imessage", connector: "imessage", label: "iMessage" },
  mail: { type: "imap", connector: "imap", label: "me@example.net" },
  calendar: { type: "apple", connector: "apple-calendar", label: "icloud-calendar" },
  reminders: { type: "apple", connector: "apple-reminders", label: "icloud-reminders" },
};

const DEFAULT_KIND: Readonly<Record<Source, "message" | "event" | "task">> = {
  chat: "message",
  mail: "message",
  calendar: "event",
  reminders: "task",
};

export interface SeededScenario {
  readonly streams: Readonly<Record<Source, string>>;
  readonly principalId: string;
}

export function seedScenario(db: DB, scenario: Scenario): SeededScenario {
  const streams: Record<string, string> = {};

  for (const [source, spec] of Object.entries(CONNECTORS)) {
    const account = saveAccount(db, {
      sourceType: spec.type,
      label: `${spec.label} (${scenario.name})`,
      credentials: { accessToken: "fixture", refreshToken: "", expiresAt: 0, scope: "" },
    });

    streams[source] = ensureStream(db, account.id, spec.connector).id;
  }

  for (const observation of scenario.observations) {
    const streamId = streams[observation.source];

    if (streamId === undefined) {
      throw new Error(`unknown source ${observation.source}`);
    }

    if (observation.reactionTo !== undefined) {
      saveReaction(db, {
        streamId,
        targetGuid: observation.reactionTo,
        author: observation.from ?? null,
        kind: observation.reaction ?? "like",
        occurredAt: scenario.anchor + observation.at * MINUTE,
      });

      continue;
    }

    upsertItem(db, {
      accountId: streamId.slice(0, streamId.lastIndexOf("/")),
      streamId,
      externalId: observation.id,
      kind: observation.kind ?? DEFAULT_KIND[observation.source],
      // A message with an author is inbound; without one it is the user
      // speaking. Mail from nobody is the user's own sent mail, which is a
      // different claim from a circular and the noise index cares.
      ...(observation.source === "calendar" || observation.source === "reminders"
        ? {}
        : { direction: observation.from === undefined ? ("outbound" as const) : ("inbound" as const) }),
      threadId: observation.thread ?? null,
      title: observation.title ?? null,
      body: observation.body ?? null,
      author: observation.from ?? null,
      participants: observation.people ?? [],
      occurredAt: scenario.anchor + observation.at * MINUTE,
      endsAt: observation.endsAt === undefined ? null : scenario.anchor + observation.endsAt * MINUTE,
      state: observation.state ?? null,
      raw: { fixture: observation.id },
    });
  }

  return { streams: streams as Record<Source, string>, principalId: DEFAULT_PRINCIPAL };
}

/** Minutes in a day and a week, for scenarios written in offsets. */
export const DAY_MINUTES = 24 * 60;
export const WEEK_MINUTES = 7 * DAY_MINUTES;
