/**
 * The digest, and getting it in front of a person.
 *
 * Harbor has had a brief for a while, and a brief nobody opens is a report, not
 * a system that is already there. The difference between the two is entirely in
 * this file: a scheduled composition, a record of what was said, and a delivery
 * that does not require the person to have remembered Harbor exists.
 *
 * Three properties matter more than the mechanics.
 *
 * **It is allowed to say nothing.** A digest that appears every morning
 * regardless of whether anything happened trains a person to ignore it, and
 * then the one morning something matters, they ignore that too. An empty day
 * produces no digest and no notification.
 *
 * **It never repeats itself.** Every observation in a digest is marked
 * surfaced, and the digest itself records which ones it carried, so tomorrow
 * cannot restate today in different words.
 *
 * **Delivery is best effort and never blocks.** A notification that fails is a
 * notification that failed; the digest is already stored and the phone surface
 * will show it. Nothing about the record depends on the delivery succeeding.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { composeBrief, renderBrief } from "./brief.js";
import type { DB } from "../kernel/db.js";
import type { Brief } from "./brief.js";

export interface Digest {
  readonly id: string;
  readonly createdAt: number;
  readonly text: string;
  readonly entryCount: number;
  readonly observationIds: readonly string[];
  readonly deliveredAt: number | null;
  readonly channel: string | null;
}

interface DigestRow {
  readonly id: string;
  readonly created_at: number;
  readonly text: string;
  readonly entry_count: number;
  readonly observation_ids: string;
  readonly delivered_at: number | null;
  readonly channel: string | null;
}

function hydrate(row: DigestRow): Digest {
  return {
    id: row.id,
    createdAt: row.created_at,
    text: row.text,
    entryCount: row.entry_count,
    observationIds: JSON.parse(row.observation_ids) as string[],
    deliveredAt: row.delivered_at,
    channel: row.channel,
  };
}

export function latestDigest(db: DB, principalId: string): Digest | null {
  const row = db
    .prepare(
      `SELECT * FROM digests WHERE principal_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(principalId) as DigestRow | undefined;

  return row === undefined ? null : hydrate(row);
}

export function recentDigests(db: DB, principalId: string, limit = 7): readonly Digest[] {
  const rows = db
    .prepare(
      `SELECT * FROM digests WHERE principal_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(principalId, limit) as DigestRow[];

  return rows.map(hydrate);
}

/**
 * A one-line summary for a notification.
 *
 * Notifications are read in half a second on a lock screen, so this is the
 * headline of the most important entry and a count, never a summary of
 * everything. A person who wants the rest opens Harbor.
 */
export function notificationText(brief: Brief): { title: string; body: string } {
  const first = brief.entries[0];
  const rest = brief.entries.length - 1;

  if (first === undefined) {
    return { title: "Harbor", body: "Nothing worth interrupting you about." };
  }

  return {
    title: rest > 0 ? `Harbor: ${String(brief.entries.length)} things` : "Harbor",
    body: rest > 0 ? `${first.observation.title} (and ${String(rest)} more)` : first.observation.title,
  };
}

/**
 * A macOS notification, through osascript.
 *
 * Chosen because it needs no dependency, no account, no server, and no network.
 * Harbor is meant to be an appliance in a house, and the first delivery channel
 * should not require signing up for a push service and shipping the contents of
 * somebody's digest through it. When Harbor stops living on a Mac this becomes
 * one channel among several rather than the only one.
 */
export async function notifyLocally(title: string, body: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  const escape = (text: string): string => text.replace(/["\\]/g, "\\$&");

  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", `display notification "${escape(body)}" with title "${escape(title)}"`],
      (error) => {
        resolve(error === null);
      },
    );
  });
}

export interface DigestOptions {
  readonly principalId: string;
  readonly timezone: string;
  readonly budget?: number | undefined;
  /** Compose and show without recording or suppressing anything. */
  readonly preview?: boolean | undefined;
  readonly notify?: boolean | undefined;
  readonly now?: number | undefined;
}

export interface DigestReport {
  readonly digest: Digest | null;
  readonly brief: Brief;
  readonly notified: boolean;
  readonly skipped: string | null;
}

/**
 * How long after a digest another one may be composed.
 *
 * Guards against a scheduler that fires twice, a machine that wakes from sleep
 * and catches up on missed runs, and a person running the command by hand after
 * an automatic one. Any of those would otherwise produce a second digest built
 * from whatever the first one did not have room for, which reads as Harbor
 * nagging.
 */
const MIN_GAP_MS = 6 * 3_600_000;

export async function produceDigest(db: DB, options: DigestOptions): Promise<DigestReport> {
  const now = options.now ?? Date.now();

  const brief = composeBrief(db, {
    principalId: options.principalId,
    timezone: options.timezone,
    now,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    preview: options.preview === true,
  });

  if (options.preview === true) {
    return { digest: null, brief, notified: false, skipped: null };
  }

  // Saying nothing is a valid outcome and the most common one. A digest that
  // arrives every day whether or not anything happened is one nobody reads.
  if (brief.entries.length === 0) {
    return { digest: null, brief, notified: false, skipped: "nothing worth saying" };
  }

  const previous = latestDigest(db, options.principalId);

  if (previous !== null && now - previous.createdAt < MIN_GAP_MS) {
    return {
      digest: previous,
      brief,
      notified: false,
      skipped: `a digest was already sent ${String(Math.round((now - previous.createdAt) / 3_600_000))} hours ago`,
    };
  }

  const observationIds = brief.entries.map((entry) => entry.observation.id);
  const text = renderBrief(brief);

  const id = `dg_${createHash("sha256")
    .update(`${options.principalId}|${String(now)}|${observationIds.join(",")}`)
    .digest("hex")
    .slice(0, 16)}`;

  db.prepare(
    `INSERT INTO digests
       (id, principal_id, created_at, covers_from, text, entry_count, observation_ids)
     VALUES (@id, @principal, @now, @from, @text, @count, @ids)`,
  ).run({
    id,
    principal: options.principalId,
    now,
    from: previous === null ? now - 86_400_000 : previous.createdAt,
    text,
    count: brief.entries.length,
    ids: JSON.stringify(observationIds),
  });

  let notified = false;

  if (options.notify === true) {
    const message = notificationText(brief);
    notified = await notifyLocally(message.title, message.body);

    if (notified) {
      db.prepare(`UPDATE digests SET delivered_at = ?, channel = 'notification' WHERE id = ?`).run(
        Date.now(),
        id,
      );
    }
  }

  const stored = db.prepare(`SELECT * FROM digests WHERE id = ?`).get(id) as DigestRow;

  return { digest: hydrate(stored), brief, notified, skipped: null };
}
