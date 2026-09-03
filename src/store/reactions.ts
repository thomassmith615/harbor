/**
 * Reactions, and why they are a table rather than an item kind.
 *
 * A tapback is not a message and Harbor was right to say so. It was wrong about
 * what follows. "Who's going to the bar later" is answered by three people
 * typing and two people tapping the heart, and the connector filtered
 * `associated_message_guid IS NOT NULL` before anything downstream could see
 * it, so the second half of that roster was not merely unread. It was never
 * written, which is the one failure no later pass can repair.
 *
 * Kept beside the message it annotates rather than in `items`, because a
 * reaction is not a thing that happened to somebody. Given a row in `items` it
 * would turn up in search, in the term index, in coverage counts, and as a line
 * of its own in every transcript, all of which are wrong in the same way: it
 * would be treated as a statement when it is a mark on one.
 *
 * Keyed on the source's own guid rather than on Harbor's item id, because a
 * reaction frequently arrives before, or without, the message it is about. A
 * tapback on something older than the history window has nothing to attach to,
 * and dropping it when the transcript is built is cheaper and more honest than
 * refusing to store it and hoping the ordering works out.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "../kernel/db.js";

export type ReactionKind =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question";

export interface ReactionInput {
  readonly streamId: string;
  readonly targetGuid: string;
  readonly author: string | null;
  readonly kind: ReactionKind;
  readonly occurredAt: number;
}

export interface Reaction {
  readonly targetGuid: string;
  readonly author: string | null;
  readonly kind: ReactionKind;
  readonly occurredAt: number;
}

/**
 * Records a reaction, or replaces the one that is already there.
 *
 * One reaction per person per message, which is what the source enforces:
 * tapping the heart when you had tapped the thumb removes the thumb. Keyed on
 * the three things that identify it rather than on the source's own row id, so
 * a re-sync of the same range does not double the count.
 */
export function saveReaction(db: DB, input: ReactionInput): void {
  db.prepare(
    `DELETE FROM reactions
     WHERE stream_id = @streamId AND target_guid = @targetGuid
       AND COALESCE(author, '') = COALESCE(@author, '')`,
  ).run({ streamId: input.streamId, targetGuid: input.targetGuid, author: input.author });

  db.prepare(
    `INSERT INTO reactions (id, stream_id, target_guid, author, kind, occurred_at, created_at)
     VALUES (@id, @streamId, @targetGuid, @author, @kind, @occurredAt, @createdAt)`,
  ).run({
    id: randomUUID(),
    streamId: input.streamId,
    targetGuid: input.targetGuid,
    author: input.author,
    kind: input.kind,
    occurredAt: input.occurredAt,
    createdAt: Date.now(),
  });
}

/**
 * Every reaction on a set of messages, keyed by the message's external id.
 *
 * Batched because the caller is segmentation, which holds a whole thread at
 * once and would otherwise ask per message.
 */
export function reactionsFor(
  db: DB,
  streamId: string,
  targetGuids: readonly string[],
): ReadonlyMap<string, readonly Reaction[]> {
  const byTarget = new Map<string, Reaction[]>();

  if (targetGuids.length === 0) {
    return byTarget;
  }

  const chunk = 400;

  for (let index = 0; index < targetGuids.length; index += chunk) {
    const slice = targetGuids.slice(index, index + chunk);
    const placeholders = slice.map(() => "?").join(", ");

    const rows = db
      .prepare(
        `SELECT target_guid, author, kind, occurred_at FROM reactions
         WHERE stream_id = ? AND target_guid IN (${placeholders})
         ORDER BY occurred_at ASC`,
      )
      .all(streamId, ...slice) as {
      target_guid: string;
      author: string | null;
      kind: string;
      occurred_at: number;
    }[];

    for (const row of rows) {
      const held = byTarget.get(row.target_guid) ?? [];

      held.push({
        targetGuid: row.target_guid,
        author: row.author,
        kind: row.kind as ReactionKind,
        occurredAt: row.occurred_at,
      });

      byTarget.set(row.target_guid, held);
    }
  }

  return byTarget;
}

export function countReactions(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM reactions`).get() as { n: number }).n;
}
