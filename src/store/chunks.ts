/**
 * Chunk and embedding storage.
 *
 * Everything here is derived and disposable. Nothing in this file is a source
 * of truth; a `DELETE FROM chunks` followed by `harbor dev derive` should produce
 * an identical store, and if it ever does not, something has leaked state it
 * should not own.
 */
import { fromBlob, toBlob } from "../derive/embed/types.js";
import type { DB } from "../kernel/db.js";

export interface StoredChunk {
  readonly id: string;
  readonly itemId: string;
  readonly ordinal: number;
  readonly text: string;
}

export interface ChunkWrite {
  readonly ordinal: number;
  readonly text: string;
}

export function chunkId(itemId: string, ordinal: number): string {
  return `${itemId}:${String(ordinal)}`;
}

/** Replaces every chunk for an item. Re-derivation is destructive by design. */
export function replaceChunks(
  db: DB,
  itemId: string,
  chunks: readonly ChunkWrite[],
  pipelineVersion: number,
): readonly StoredChunk[] {
  db.prepare(`DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE item_id = ?)`).run(
    itemId,
  );
  db.prepare(`DELETE FROM chunks WHERE item_id = ?`).run(itemId);

  const insert = db.prepare(
    `INSERT INTO chunks (id, item_id, ordinal, text, chars, pipeline_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = Date.now();
  const written: StoredChunk[] = [];

  for (const chunk of chunks) {
    const id = chunkId(itemId, chunk.ordinal);
    insert.run(id, itemId, chunk.ordinal, chunk.text, chunk.text.length, pipelineVersion, now);
    written.push({ id, itemId, ordinal: chunk.ordinal, text: chunk.text });
  }

  return written;
}

export function saveEmbedding(
  db: DB,
  chunkIdValue: string,
  model: string,
  vector: Float32Array,
  pipelineVersion: number,
): void {
  db.prepare(
    `INSERT INTO embeddings (chunk_id, model, dims, vector, pipeline_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (chunk_id) DO UPDATE SET
       model = excluded.model,
       dims = excluded.dims,
       vector = excluded.vector,
       pipeline_version = excluded.pipeline_version,
       created_at = excluded.created_at`,
  ).run(chunkIdValue, model, vector.length, toBlob(vector), pipelineVersion, Date.now());
}

export function markDerived(db: DB, itemId: string, pipelineVersion: number): void {
  db.prepare(`UPDATE items SET derived_version = ?, derived_at = ? WHERE id = ?`).run(
    pipelineVersion,
    Date.now(),
    itemId,
  );
}

export interface PendingItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly author: string | null;
  readonly body: string | null;
  readonly snippet: string | null;
  /** Which stream it came from, so the pass can tell conversational sources apart. */
  readonly streamId: string | null;
}

/**
 * Items whose derived state is missing or stale.
 *
 * `derived_version IS NULL` covers both new items and ones whose content
 * changed, because upsert clears it whenever the content hash moves.
 */
export function pendingItems(
  db: DB,
  pipelineVersion: number,
  limit: number,
): readonly PendingItem[] {
  return db
    .prepare(
      `SELECT id, kind, title, author, body, snippet, stream_id AS streamId
       FROM items
       WHERE deleted_at IS NULL
         AND (derived_version IS NULL OR derived_version <> ?)
       ORDER BY occurred_at DESC
       LIMIT ?`,
    )
    .all(pipelineVersion, limit) as PendingItem[];
}

export function countPending(db: DB, pipelineVersion: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items
       WHERE deleted_at IS NULL AND (derived_version IS NULL OR derived_version <> ?)`,
    )
    .get(pipelineVersion) as { n: number };

  return row.n;
}

export interface EmbeddingRow {
  readonly chunkId: string;
  readonly itemId: string;
  readonly vector: Float32Array;
}

/** Used only by the fallback scan when the vector extension is unavailable. */
export function allEmbeddings(
  db: DB,
  model: string,
  pipelineVersion: number,
): readonly EmbeddingRow[] {
  const rows = db
    .prepare(
      `SELECT e.chunk_id AS chunkId, c.item_id AS itemId, e.vector AS vector
       FROM embeddings e
       JOIN chunks c ON c.id = e.chunk_id
       JOIN items i ON i.id = c.item_id
       WHERE e.model = ? AND e.pipeline_version = ? AND i.deleted_at IS NULL`,
    )
    .all(model, pipelineVersion) as { chunkId: string; itemId: string; vector: Buffer }[];

  return rows.map((row) => ({
    chunkId: row.chunkId,
    itemId: row.itemId,
    vector: fromBlob(row.vector),
  }));
}

export interface EpisodeEmbeddingRow {
  readonly chunkId: string;
  readonly episodeId: string;
  readonly vector: Float32Array;
}

/** The same scan fallback, over episode vectors instead of item vectors. */
export function allEpisodeEmbeddings(
  db: DB,
  model: string,
  pipelineVersion: number,
): readonly EpisodeEmbeddingRow[] {
  const rows = db
    .prepare(
      `SELECT e.chunk_id AS chunkId, c.episode_id AS episodeId, e.vector AS vector
       FROM embeddings e
       JOIN episode_chunks c ON c.id = e.chunk_id
       WHERE e.model = ? AND e.pipeline_version = ?`,
    )
    .all(model, pipelineVersion) as { chunkId: string; episodeId: string; vector: Buffer }[];

  return rows.map((row) => ({
    chunkId: row.chunkId,
    episodeId: row.episodeId,
    vector: fromBlob(row.vector),
  }));
}

export interface DeriveStats {
  readonly chunks: number;
  readonly embeddings: number;
  readonly models: readonly string[];
  readonly vectorBytes: number;
}

export function deriveStats(db: DB): DeriveStats {
  const chunks = db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number };

  const embeddings = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(vector)), 0) AS bytes FROM embeddings`,
    )
    .get() as { n: number; bytes: number };

  const models = db.prepare(`SELECT DISTINCT model FROM embeddings ORDER BY model`).all() as {
    model: string;
  }[];

  return {
    chunks: chunks.n,
    embeddings: embeddings.n,
    models: models.map((row) => row.model),
    vectorBytes: embeddings.bytes,
  };
}
