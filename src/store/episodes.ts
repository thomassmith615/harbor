/**
 * Episodes: contiguous stretches of one conversation.
 *
 * Derived and disposable like chunks and edges. An episode has no authority
 * over the messages inside it; delete every row here, run `harbor dev derive`, and
 * the same episodes come back.
 *
 * The id is a hash of membership, for the same reason thread ids are: episodes
 * are rebuilt whenever segmentation changes, and a random id would mean the
 * same conversation came back as a different row every time, breaking anything
 * that referred to it.
 */
import { createHash } from "node:crypto";
import type { DB } from "../kernel/db.js";

export interface Episode {
  readonly id: string;
  readonly streamId: string;
  readonly threadId: string;
  readonly title: string | null;
  readonly transcript: string;
  /** Display names, as rendered into the transcript. */
  readonly participants: readonly string[];
  readonly messageCount: number;
  readonly startsAt: number;
  readonly endsAt: number;
}

interface EpisodeRow {
  readonly id: string;
  readonly stream_id: string;
  readonly thread_id: string;
  readonly title: string | null;
  readonly transcript: string;
  readonly participants: string;
  readonly message_count: number;
  readonly starts_at: number;
  readonly ends_at: number;
}

export function hydrateEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    streamId: row.stream_id,
    threadId: row.thread_id,
    title: row.title,
    transcript: row.transcript,
    participants: JSON.parse(row.participants) as string[],
    messageCount: row.message_count,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

export function episodeId(itemIds: readonly string[]): string {
  return `ep_${createHash("sha256").update([...itemIds].sort().join("|")).digest("hex").slice(0, 16)}`;
}

export interface EpisodeInput {
  readonly streamId: string;
  readonly threadId: string;
  readonly principalId: string;
  readonly title: string | null;
  readonly transcript: string;
  readonly participants: readonly string[];
  readonly itemIds: readonly string[];
  readonly startsAt: number;
  readonly endsAt: number;
}

/**
 * Writes an episode and its membership.
 *
 * `derived_version` is cleared on every write, so a re-segmented episode is
 * re-embedded. An episode whose membership is unchanged keeps its id and so
 * keeps its vectors, which is what stops a nightly pass from re-embedding
 * every conversation you have ever had.
 */
export function saveEpisode(db: DB, input: EpisodeInput, segmentVersion: number): string {
  const id = episodeId(input.itemIds);
  const now = Date.now();

  const existing = db.prepare(`SELECT transcript FROM episodes WHERE id = ?`).get(id) as
    | { transcript: string }
    | undefined;

  const unchanged = existing !== undefined && existing.transcript === input.transcript;

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO episodes
         (id, stream_id, thread_id, principal_id, title, transcript, participants,
          message_count, starts_at, ends_at, segment_version, derived_version,
          created_at, updated_at)
       VALUES (@id, @streamId, @threadId, @principalId, @title, @transcript, @participants,
               @count, @startsAt, @endsAt, @segmentVersion, NULL, @now, @now)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         transcript = excluded.transcript,
         participants = excluded.participants,
         message_count = excluded.message_count,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         segment_version = excluded.segment_version,
         derived_version = CASE WHEN @unchanged = 1 THEN episodes.derived_version ELSE NULL END,
         updated_at = excluded.updated_at`,
    ).run({
      id,
      streamId: input.streamId,
      threadId: input.threadId,
      principalId: input.principalId,
      title: input.title,
      transcript: input.transcript,
      participants: JSON.stringify(input.participants),
      count: input.itemIds.length,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      segmentVersion,
      now,
      unchanged: unchanged ? 1 : 0,
    });

    db.prepare(`DELETE FROM episode_items WHERE episode_id = ?`).run(id);

    const attach = db.prepare(
      `INSERT INTO episode_items (episode_id, item_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    );

    for (const itemId of input.itemIds) {
      attach.run(id, itemId);
    }

    db.prepare(`DELETE FROM episodes_fts WHERE episode_id = ?`).run(id);
    db.prepare(
      `INSERT INTO episodes_fts (episode_id, title, transcript) VALUES (?, ?, ?)`,
    ).run(id, input.title ?? "", input.transcript);
  });

  write();

  return id;
}

/**
 * Removes episodes for one conversation that segmentation no longer produces.
 *
 * Necessary because an episode id is a hash of its membership, so a
 * conversation that grows by one message produces a *new* episode rather than a
 * changed one. Without this the old one survives, an item belongs to two
 * episodes, and lookups return whichever the query planner reaches first.
 *
 * Chunks and their vectors go too. Orphaned rows in the vector index are
 * harmless: every search joins back through `episode_chunks`, so a vector with
 * no chunk cannot be returned. `harbor dev reindex` clears them.
 */
export function pruneEpisodes(
  db: DB,
  streamId: string,
  threadId: string,
  keep: readonly string[],
): number {
  const existing = db
    .prepare(`SELECT id FROM episodes WHERE stream_id = ? AND thread_id = ?`)
    .all(streamId, threadId) as { id: string }[];

  const doomed = existing.filter((row) => !keep.includes(row.id));

  const work = db.transaction(() => {
    for (const row of doomed) {
      db.prepare(
        `DELETE FROM embeddings WHERE chunk_id IN
           (SELECT id FROM episode_chunks WHERE episode_id = ?)`,
      ).run(row.id);
      db.prepare(`DELETE FROM episode_chunks WHERE episode_id = ?`).run(row.id);
      db.prepare(`DELETE FROM episode_items WHERE episode_id = ?`).run(row.id);
      db.prepare(`DELETE FROM episodes_fts WHERE episode_id = ?`).run(row.id);
      db.prepare(`DELETE FROM episodes WHERE id = ?`).run(row.id);
    }
  });

  work();

  return doomed.length;
}

export function getEpisode(db: DB, id: string): Episode | null {
  const row = db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(id) as EpisodeRow | undefined;

  return row === undefined ? null : hydrateEpisode(row);
}

export function episodeItems(db: DB, episodeId_: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT ei.item_id AS id FROM episode_items ei
       JOIN items i ON i.id = ei.item_id
       WHERE ei.episode_id = ? AND i.deleted_at IS NULL
       ORDER BY i.occurred_at`,
    )
    .all(episodeId_) as { id: string }[];

  return rows.map((row) => row.id);
}

/** The episode an item belongs to, if it is in one. */
export function episodeForItem(db: DB, itemId: string): Episode | null {
  const row = db
    .prepare(
      `SELECT e.* FROM episodes e
       JOIN episode_items ei ON ei.episode_id = e.id
       WHERE ei.item_id = ? LIMIT 1`,
    )
    .get(itemId) as EpisodeRow | undefined;

  return row === undefined ? null : hydrateEpisode(row);
}

export function recentEpisodes(
  db: DB,
  principalId: string,
  options: { readonly limit?: number; readonly since?: number } = {},
): readonly Episode[] {
  const rows = db
    .prepare(
      `SELECT * FROM episodes
       WHERE principal_id = @principal
         AND (@since IS NULL OR ends_at >= @since)
       ORDER BY ends_at DESC
       LIMIT @limit`,
    )
    .all({
      principal: principalId,
      since: options.since ?? null,
      limit: options.limit ?? 20,
    }) as EpisodeRow[];

  return rows.map(hydrateEpisode);
}

export function countEpisodes(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number }).n;
}

// ---- derivation bookkeeping ----

export function markSegmented(db: DB, itemIds: readonly string[], version: number): void {
  const mark = db.prepare(`UPDATE items SET episode_version = ? WHERE id = ?`);

  const work = db.transaction(() => {
    for (const id of itemIds) {
      mark.run(version, id);
    }
  });

  work();
}

export interface PendingEpisode {
  readonly id: string;
  readonly title: string | null;
  readonly transcript: string;
}

export function pendingEpisodes(
  db: DB,
  pipelineVersion: number,
  limit: number,
): readonly PendingEpisode[] {
  return db
    .prepare(
      `SELECT id, title, transcript FROM episodes
       WHERE derived_version IS NULL OR derived_version <> @version
       ORDER BY ends_at DESC
       LIMIT @limit`,
    )
    .all({ version: pipelineVersion, limit }) as PendingEpisode[];
}

export function countPendingEpisodes(db: DB, pipelineVersion: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM episodes
         WHERE derived_version IS NULL OR derived_version <> ?`,
      )
      .get(pipelineVersion) as { n: number }
  ).n;
}

export function markEpisodeDerived(db: DB, id: string, pipelineVersion: number): void {
  db.prepare(`UPDATE episodes SET derived_version = ?, updated_at = ? WHERE id = ?`).run(
    pipelineVersion,
    Date.now(),
    id,
  );
}

export interface EpisodeChunkWrite {
  readonly ordinal: number;
  readonly text: string;
}

export function replaceEpisodeChunks(
  db: DB,
  id: string,
  chunks: readonly EpisodeChunkWrite[],
  pipelineVersion: number,
): readonly { readonly id: string; readonly text: string }[] {
  db.prepare(
    `DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM episode_chunks WHERE episode_id = ?)`,
  ).run(id);
  db.prepare(`DELETE FROM episode_chunks WHERE episode_id = ?`).run(id);

  const insert = db.prepare(
    `INSERT INTO episode_chunks (id, episode_id, ordinal, text, chars, pipeline_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = Date.now();
  const written: { id: string; text: string }[] = [];

  for (const chunk of chunks) {
    const chunkId = `${id}:${String(chunk.ordinal)}`;
    insert.run(chunkId, id, chunk.ordinal, chunk.text, chunk.text.length, pipelineVersion, now);
    written.push({ id: chunkId, text: chunk.text });
  }

  return written;
}
