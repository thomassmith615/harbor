/**
 * The vector index.
 *
 * sqlite-vec when the extension loads, a brute-force scan when it does not.
 * The fallback exists because a loadable native extension is the single most
 * likely thing to fail on someone else's machine, and "semantic search stopped
 * working" is a much worse outcome than "semantic search got slower".
 *
 * Both paths rank identically: vectors are stored normalized, so sqlite-vec's
 * L2 distance and a cosine dot product order results the same way.
 *
 * The virtual table is created here rather than in a migration because its
 * column width depends on the embedding model. Changing models rebuilds it,
 * which is correct: embeddings are disposable, and a width mismatch would
 * otherwise fail deep inside a query.
 */
import { createRequire } from "node:module";
import { allEmbeddings, allEpisodeEmbeddings } from "../store/chunks.js";
import { cosine, toBlob } from "../derive/embed/types.js";
import { getSetting, setSetting } from "../store/settings.js";
import type { DB } from "../kernel/db.js";

export interface VectorHit {
  readonly itemId: string;
  readonly chunkId: string;
  readonly score: number;
}

export interface EpisodeVectorHit {
  readonly episodeId: string;
  readonly chunkId: string;
  readonly score: number;
}

export interface VectorIndex {
  readonly backend: "sqlite-vec" | "scan";
  readonly dims: number;
  add(chunkId: string, vector: Float32Array): void;
  remove(itemId: string): void;
  search(query: Float32Array, limit: number): readonly VectorHit[];
  /**
   * The same index, asked about conversations instead of items.
   *
   * A separate method rather than a union return, because every existing caller
   * wants items and would otherwise have to learn to filter. Chunk ids are
   * unique across both tables, so one index serves both.
   */
  searchEpisodes(query: Float32Array, limit: number): readonly EpisodeVectorHit[];
  rebuild(model: string, pipelineVersion: number): number;
}

/**
 * Whether the binary exists at all. A process-wide fact.
 */
let extensionAvailable: boolean | null = null;

/**
 * Which connections have actually had it loaded. A per-connection fact.
 *
 * These were one variable, and conflating them is a real bug rather than a
 * tidiness point: a loadable extension attaches to a *connection*, not to a
 * process. Once any connection had loaded it, every later connection was told
 * it was available and none of them had it, so the first vector query on a
 * second connection failed with `no such module: vec0` -- and it failed after
 * reporting the fast path was in use, so it did not degrade to the scan path
 * either. It went unnoticed because Harbor almost always opens one connection;
 * it surfaces the moment anything opens a second, which a test run does and an
 * API server alongside a job runner would.
 *
 * Weak, so a closed database is not kept alive by having been indexed.
 */
const loadedOn = new WeakSet<object>();

/** Loads sqlite-vec per connection. Failure is a downgrade, not an error. */
function tryLoadExtension(db: DB): boolean {
  if (extensionAvailable === false) {
    return false;
  }

  if (loadedOn.has(db as unknown as object)) {
    return true;
  }

  try {
    // A native loadable extension, required lazily so a missing or mismatched
    // binary degrades to the scan path instead of preventing Harbor from
    // starting at all.
    const require = createRequire(import.meta.url);
    const vec = require("sqlite-vec") as { load(database: unknown): void };
    vec.load(db);
    extensionAvailable = true;
    loadedOn.add(db as unknown as object);
  } catch {
    // A failure here can mean the binary is missing, or that this particular
    // connection refused it. Only the first is worth remembering process-wide.
    if (extensionAvailable === null) {
      extensionAvailable = false;
    }

    return false;
  }

  return true;
}

const VEC_TABLE = "vec_chunks";
const DIMS_KEY = "vector.dims";
const MODEL_KEY = "vector.model";

function ensureTable(db: DB, dims: number, model: string): void {
  const storedDims = getSetting(db, DIMS_KEY);
  const storedModel = getSetting(db, MODEL_KEY);

  if (storedDims === String(dims) && storedModel === model) {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
         chunk_id TEXT PRIMARY KEY,
         embedding float[${String(dims)}]
       )`,
    );
    return;
  }

  // Model or width changed. The index is derived, so throw it away.
  db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
  db.exec(
    `CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(
       chunk_id TEXT PRIMARY KEY,
       embedding float[${String(dims)}]
     )`,
  );

  setSetting(db, DIMS_KEY, String(dims));
  setSetting(db, MODEL_KEY, model);
}

export function openVectorIndex(db: DB, model: string, dims: number): VectorIndex {
  if (tryLoadExtension(db)) {
    ensureTable(db, dims, model);

    return {
      backend: "sqlite-vec",
      dims,

      add(chunkIdValue: string, vector: Float32Array): void {
        db.prepare(`DELETE FROM ${VEC_TABLE} WHERE chunk_id = ?`).run(chunkIdValue);
        db.prepare(`INSERT INTO ${VEC_TABLE} (chunk_id, embedding) VALUES (?, ?)`).run(
          chunkIdValue,
          toBlob(vector),
        );
      },

      remove(itemId: string): void {
        db.prepare(
          `DELETE FROM ${VEC_TABLE} WHERE chunk_id IN (SELECT id FROM chunks WHERE item_id = ?)`,
        ).run(itemId);
      },

      searchEpisodes(query: Float32Array, limit: number): readonly EpisodeVectorHit[] {
        const rows = db
          .prepare(
            `SELECT v.chunk_id AS chunkId, c.episode_id AS episodeId, v.distance AS distance
             FROM ${VEC_TABLE} v
             JOIN episode_chunks c ON c.id = v.chunk_id
             WHERE v.embedding MATCH ? AND k = ?
             ORDER BY v.distance`,
          )
          .all(toBlob(query), limit) as {
          chunkId: string;
          episodeId: string;
          distance: number;
        }[];

        return rows.map((row) => ({
          chunkId: row.chunkId,
          episodeId: row.episodeId,
          score: 1 - (row.distance * row.distance) / 2,
        }));
      },

      search(query: Float32Array, limit: number): readonly VectorHit[] {
        const rows = db
          .prepare(
            `SELECT v.chunk_id AS chunkId, c.item_id AS itemId, v.distance AS distance
             FROM ${VEC_TABLE} v
             JOIN chunks c ON c.id = v.chunk_id
             JOIN items i ON i.id = c.item_id
             WHERE v.embedding MATCH ? AND k = ? AND i.deleted_at IS NULL
             ORDER BY v.distance`,
          )
          .all(toBlob(query), limit) as {
          chunkId: string;
          itemId: string;
          distance: number;
        }[];

        // Unit vectors: L2 distance d relates to cosine as cos = 1 - d^2 / 2.
        return rows.map((row) => ({
          chunkId: row.chunkId,
          itemId: row.itemId,
          score: 1 - (row.distance * row.distance) / 2,
        }));
      },

      rebuild(modelName: string, pipelineVersion: number): number {
        db.exec(`DELETE FROM ${VEC_TABLE}`);

        const insert = db.prepare(
          `INSERT INTO ${VEC_TABLE} (chunk_id, embedding) VALUES (?, ?)`,
        );

        const rows = allEmbeddings(db, modelName, pipelineVersion);

        const write = db.transaction((batch: typeof rows) => {
          for (const row of batch) {
            insert.run(row.chunkId, toBlob(row.vector));
          }
        });

        write(rows);
        return rows.length;
      },
    };
  }

  // Fallback: no index, scan every stored vector. Correct, just slower, and it
  // keeps working while a native binary problem gets sorted out.
  return {
    backend: "scan",
    dims,

    add(): void {
      // Nothing to maintain; the scan reads the embeddings table directly.
    },

    remove(): void {
      // Same.
    },

    searchEpisodes(query: Float32Array, limit: number): readonly EpisodeVectorHit[] {
      const rows = allEpisodeEmbeddings(db, model, currentPipelineVersion);

      const scored = rows.map((row) => ({
        chunkId: row.chunkId,
        episodeId: row.episodeId,
        score: cosine(query, row.vector),
      }));

      scored.sort((left, right) => right.score - left.score);
      return scored.slice(0, limit);
    },

    search(query: Float32Array, limit: number): readonly VectorHit[] {
      const rows = allEmbeddings(db, model, currentPipelineVersion);

      const scored = rows.map((row) => ({
        chunkId: row.chunkId,
        itemId: row.itemId,
        score: cosine(query, row.vector),
      }));

      scored.sort((left, right) => right.score - left.score);
      return scored.slice(0, limit);
    },

    rebuild(): number {
      return 0;
    },
  };
}

/**
 * The scan fallback needs a pipeline version and has no good way to be told
 * one through the index interface. Set once at startup by the derive layer.
 */
let currentPipelineVersion = 1;

export function setIndexPipelineVersion(version: number): void {
  currentPipelineVersion = version;
}

export function vectorBackend(db: DB): "sqlite-vec" | "scan" {
  return tryLoadExtension(db) ? "sqlite-vec" : "scan";
}
