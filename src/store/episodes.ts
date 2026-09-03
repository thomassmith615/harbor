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
import { isHandle, nameForHandle } from "./entities.js";
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
      // A representative item from this episode, captured at the top of the
      // loop because the deletes below remove episode_items. Reading it after
      // them always found nothing, so every cited commitment was deleted
      // instead of repointed: the constraint stopped failing and the evidence
      // quietly disappeared, which is the worse of the two outcomes.
      const stand = db
        .prepare(
          `SELECT item_id AS id FROM episode_items ei
           JOIN items i ON i.id = ei.item_id
           WHERE ei.episode_id = ? AND i.deleted_at IS NULL
           ORDER BY i.occurred_at LIMIT 1`,
        )
        .get(row.id) as { id: string } | undefined;

      db.prepare(
        `DELETE FROM embeddings WHERE chunk_id IN
           (SELECT id FROM episode_chunks WHERE episode_id = ?)`,
      ).run(row.id);
      db.prepare(`DELETE FROM episode_chunks WHERE episode_id = ?`).run(row.id);
      db.prepare(`DELETE FROM episode_items WHERE episode_id = ?`).run(row.id);
      db.prepare(`DELETE FROM episodes_fts WHERE episode_id = ?`).run(row.id);

      // Propositions go with the episode.
      //
      // Unlike a commitment, a proposition is not understanding worth keeping:
      // it is a rewrite of a line in a transcript that no longer exists in that
      // form, so repointing it would leave a retrieval key aimed at nothing.
      // The rewrite pass regenerates it for whatever the new segmentation
      // produced. Deleted explicitly rather than left to ON DELETE CASCADE so
      // that this function remains the single readable account of what happens
      // to an episode's children.
      db.prepare(`DELETE FROM propositions WHERE episode_id = ?`).run(row.id);

      // Evidence and facts cite episodes.
      //
      // This is what was failing derive. Those two tables were added after
      // this function, nothing came back to update it, and the delete below
      // hit a foreign key it did not know existed. The effect was quiet and
      // total: once any commitment or fact cited an episode, that episode
      // could never be re-segmented again, so every derive pass touching it
      // aborted with `FOREIGN KEY constraint failed` and the whole pipeline
      // stopped. Three hundred items sat unprocessed behind it.
      //
      // Repointed, not cascaded. A commitment does not stop being true because
      // the conversation it came from was re-segmented, and deleting it would
      // destroy real understanding to satisfy a bookkeeping constraint.
      //
      // `commitment_evidence` carries CHECK ((item_id IS NULL) <> (episode_id
      // IS NULL)), so nulling the episode alone just trades one constraint
      // failure for another. Pointing at an item from the same episode keeps
      // the evidence real and satisfies the check: the citation loses
      // conversation granularity and keeps its source.
      //
      // With no surviving item there is nothing truthful left to point at, and
      // an evidence row citing nothing is worse than none.
      if (stand === undefined) {
        db.prepare(`DELETE FROM commitment_evidence WHERE episode_id = ?`).run(row.id);
      } else {
        db.prepare(
          `UPDATE commitment_evidence SET episode_id = NULL, item_id = ?
           WHERE episode_id = ? AND item_id IS NULL`,
        ).run(stand.id, row.id);
      }

      // `facts` has no such check, and keeps whatever source_item it already
      // had, so the episode link is simply dropped.
      db.prepare(
        `UPDATE facts SET source_episode = NULL, source_item = COALESCE(source_item, ?)
         WHERE source_episode = ?`,
      ).run(stand?.id ?? null, row.id);

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
  options: {
    readonly limit?: number;
    readonly since?: number;
    /** Entity id. Only conversations that person took part in. */
    readonly personId?: string | undefined;
  } = {},
): readonly Episode[] {
  // Scoping by person goes through the entity links rather than the text.
  //
  // This is the difference between "what did Joey ask me" working and not. An
  // iMessage transcript never contains the sender's name: the title is a phone
  // number and the words are just the words. Searching for "Joey" over
  // conversations finds nothing, which reads to a person as Harbor not having
  // their messages, when it has two thousand of them filed under a handle that
  // resolution has already tied to the name.
  const rows = db
    .prepare(
      `SELECT e.* FROM episodes e
       WHERE e.principal_id = @principal
         AND (@since IS NULL OR e.ends_at >= @since)
         AND (@person IS NULL OR EXISTS (
           SELECT 1 FROM episode_items ei
           JOIN item_entities ie ON ie.item_id = ei.item_id
           WHERE ei.episode_id = e.id AND ie.entity_id = @person
         ))
       ORDER BY e.ends_at DESC
       LIMIT @limit`,
    )
    .all({
      principal: principalId,
      since: options.since ?? null,
      person: options.personId ?? null,
      limit: options.limit ?? 20,
    }) as EpisodeRow[];

  return rows.map(hydrateEpisode);
}

export interface Correspondent {
  readonly entityId: string;
  readonly name: string;
  readonly lastAt: number;
  readonly messages: number;
  readonly sent: number;
}

/**
 * Who you have actually been in contact with, most recent first.
 *
 * "Who have I contacted recently" had no tool behind it, so the model fell back
 * to text search and answered from whatever happened to match, which looked
 * like Harbor not knowing its own contacts. It is a group-by over the entity
 * links, which is the one thing this store is unusually well set up to answer:
 * 1,403 resolved people and 31,000 links.
 *
 * Self is excluded. Being on your own messages is not being in contact.
 */
export function recentCorrespondents(
  db: DB,
  principalId: string,
  options: { readonly limit?: number; readonly since?: number } = {},
): readonly Correspondent[] {
  const rows = db
    .prepare(
      `SELECT ie.entity_id AS entityId,
              en.display_name AS name,
              MAX(i.occurred_at) AS lastAt,
              COUNT(*) AS messages,
              SUM(CASE WHEN i.direction = 'outbound' THEN 1 ELSE 0 END) AS sent
       FROM item_entities ie
       JOIN items i ON i.id = ie.item_id
       JOIN entities en ON en.id = ie.entity_id
       JOIN accounts a ON a.id = i.account_id
       WHERE i.deleted_at IS NULL
         AND a.custodian_person_id = @principal
         AND en.merged_into IS NULL
         AND en.kind <> 'self'
         AND (@since IS NULL OR i.occurred_at >= @since)
       GROUP BY ie.entity_id
       ORDER BY lastAt DESC
       LIMIT @limit`,
    )
    .all({
      principal: principalId,
      since: options.since ?? null,
      limit: options.limit ?? 20,
    }) as Correspondent[];

  // Names resolved the same way every other surface does it. `display_name` is
  // a handle whenever an entity was created from a message before anything
  // named it, which is most of them, so reading the column alone produced a
  // list of phone numbers.
  return rows.map((row) => ({
    ...row,
    name: isHandle(row.name) ? (nameForHandle(db, row.name) ?? row.name) : row.name,
  }));
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
  /** For the window header: who was in it and when it happened. */
  readonly startsAt: number;
  readonly participants: readonly string[];
}

export function pendingEpisodes(
  db: DB,
  pipelineVersion: number,
  limit: number,
): readonly PendingEpisode[] {
  const rows = db
    .prepare(
      `SELECT id, title, transcript, starts_at, participants FROM episodes
       WHERE derived_version IS NULL OR derived_version <> @version
       ORDER BY ends_at DESC
       LIMIT @limit`,
    )
    .all({ version: pipelineVersion, limit }) as {
    id: string;
    title: string | null;
    transcript: string;
    starts_at: number;
    participants: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    transcript: row.transcript,
    startsAt: row.starts_at,
    participants: JSON.parse(row.participants) as string[],
  }));
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
