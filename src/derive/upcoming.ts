/**
 * What is coming.
 *
 * Everything else in this directory answers "what belongs together", and holds
 * a high bar for saying so: two independent kinds of evidence, or one decisive
 * one. That bar is right for a *story*, which is a claim about somebody's life
 * assembled from scattered parts and has to be defensible.
 *
 * It is the wrong bar for this surface, and getting that wrong produced the
 * worst failure Harbor has had. A calendar entry reading "Smith cousin weekend"
 * two days away gathered no cross-source evidence -- nobody had texted about it,
 * no booking existed -- so it was not a story, so it appeared nowhere. The chat
 * could find it instantly, because the chat searches the calendar. The one
 * surface meant to stop somebody forgetting what is ahead was the one place it
 * was invisible, and it was invisible *because* it was uncomplicated.
 *
 * So this is not the story layer with a date filter on it. It is the calendar,
 * plus the reminders, with stories folded in where they exist. Completeness is
 * the requirement; the evidence layer is a bonus that makes some entries richer.
 * An entry never has to earn its place here by being interesting.
 *
 * The three kinds it distinguishes:
 *
 *   travel     Somewhere you are going. Worth separating because a trip
 *              reorganises a week and a dentist appointment does not.
 *   occasion   Something happening, whether or not Harbor understood it.
 *   task       Something to do, with a time attached.
 */
import { NoiseIndex } from "./noise.js";
import { describePlace } from "./presence.js";
import { nodeKey } from "../store/nodes.js";
import { topStories } from "../store/stories.js";
import type { DB } from "../kernel/db.js";
import type { Story } from "../store/stories.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type UpcomingKind = "travel" | "occasion" | "task";

export interface UpcomingEntry {
  readonly kind: UpcomingKind;
  readonly title: string;
  readonly startsAt: number;
  readonly endsAt: number | null;
  readonly place: string | null;
  /** Present when Harbor assembled a story for this. */
  readonly storyId: string | null;
  /** How much it knows, when it knows anything. */
  readonly memberCount: number;
  readonly sourceCount: number;
  readonly summary: string | null;
  readonly itemId: string | null;
}

export interface UpcomingQuery {
  readonly principalId: string;
  readonly now?: number;
  /** How far ahead to look. */
  readonly days?: number;
  readonly limit?: number;
}

/**
 * Whether a story is somewhere you are going rather than something you are
 * doing.
 *
 * A journey is obviously travel. So is an occasion that runs overnight
 * somewhere that is not home -- a work trip booked through Concur is a calendar
 * entry with an address in the notes, never a flight, and it belongs with the
 * trips rather than in a list of errands.
 */
export function isTravel(story: Story, home: string | null): boolean {
  if (story.kind === "trip") {
    return true;
  }

  return (
    story.place !== null &&
    story.place !== home &&
    story.spanEndsAt - story.spanStartsAt >= 12 * HOUR
  );
}

export function upcoming(db: DB, query: UpcomingQuery): readonly UpcomingEntry[] {
  const now = query.now ?? Date.now();
  const until = now + (query.days ?? 120) * DAY;
  const noise = new NoiseIndex(db);

  const home = (
    db
      .prepare(
        `SELECT place FROM presence
         WHERE principal_id = ? AND state = 'home'
         ORDER BY starts_at DESC LIMIT 1`,
      )
      .get(query.principalId) as { place: string | null } | undefined
  )?.place ?? null;

  const entries: UpcomingEntry[] = [];

  // Stories first, so anything they cover is claimed by the richer entry.
  const claimed = new Set<string>();

  const stories = topStories(db, query.principalId, {
    limit: 60,
    minSources: 1,
    tense: "upcoming",
    now,
  });

  for (const story of stories) {
    if (story.spanStartsAt > until) {
      continue;
    }

    const members = db
      .prepare(`SELECT node_kind, node_id FROM story_nodes WHERE story_id = ?`)
      .all(story.id) as { node_kind: string; node_id: string }[];

    for (const member of members) {
      claimed.add(nodeKey({ kind: member.node_kind as "item", id: member.node_id }));
    }

    entries.push({
      kind: isTravel(story, home) ? "travel" : "occasion",
      title: story.title ?? "Untitled",
      startsAt: story.spanStartsAt,
      endsAt: story.spanEndsAt,
      place: story.place === null ? null : describePlace(story.place),
      storyId: story.id,
      memberCount: story.memberCount,
      sourceCount: story.sourceCount,
      summary: story.summary,
      itemId: null,
    });
  }

  // Then the calendar itself, which is the part that has to be complete.
  const events = db
    .prepare(
      `SELECT id, title, occurred_at, ends_at FROM items
       WHERE kind = 'event' AND deleted_at IS NULL
         AND occurred_at BETWEEN ? AND ?
       ORDER BY occurred_at ASC LIMIT 400`,
    )
    .all(now - 2 * HOUR, until) as {
    id: string;
    title: string | null;
    occurred_at: number;
    ends_at: number | null;
  }[];

  for (const row of events) {
    if (claimed.has(`item:${row.id}`) || noise.isRepeating(row.id)) {
      continue;
    }

    const title = (row.title ?? "").trim();

    if (title.length === 0) {
      continue;
    }

    entries.push({
      kind: "occasion",
      title,
      startsAt: row.occurred_at,
      endsAt: row.ends_at,
      place: null,
      storyId: null,
      memberCount: 1,
      sourceCount: 1,
      summary: null,
      itemId: row.id,
    });
  }

  // And the reminders, which are the other half of what somebody forgets.
  const tasks = db
    .prepare(
      `SELECT id, title, occurred_at FROM items
       WHERE kind = 'task' AND deleted_at IS NULL
         AND (state IS NULL OR state != 'completed')
         AND occurred_at BETWEEN ? AND ?
       ORDER BY occurred_at ASC LIMIT 200`,
    )
    .all(now - 2 * HOUR, until) as { id: string; title: string | null; occurred_at: number }[];

  for (const row of tasks) {
    if (claimed.has(`item:${row.id}`)) {
      continue;
    }

    const title = (row.title ?? "").trim();

    if (title.length === 0) {
      continue;
    }

    entries.push({
      kind: "task",
      title,
      startsAt: row.occurred_at,
      endsAt: null,
      place: null,
      storyId: null,
      memberCount: 1,
      sourceCount: 1,
      summary: null,
      itemId: row.id,
    });
  }

  // Soonest first. A list of things somebody is about to forget is useless in
  // any other order, whatever else might be said for ranking by importance.
  entries.sort((a, b) => a.startsAt - b.startsAt);

  return entries.slice(0, query.limit ?? 40);
}
