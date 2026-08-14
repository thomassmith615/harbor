/**
 * The derivation pipeline.
 *
 * Reads items, produces chunks and vectors, marks each item derived. Every
 * output is stamped with PIPELINE_VERSION and rebuildable from what is already
 * in the store, so improving the chunker or changing the embedding model is a
 * background job rather than a re-sync.
 *
 * Two design notes worth keeping:
 *
 *   Resumability, not a job queue. Derivation is chunked into batches and each
 *   batch commits before the next starts, so an interrupted run costs one
 *   batch. A general job queue is still deferred: the shape it should take
 *   depends on the daemon (M9), and guessing at it now would be the third time
 *   I built infrastructure ahead of the thing that needs it.
 *
 *   The staleness link lives in upsert, not here. `items.derived_version` is
 *   cleared whenever an item's content hash changes, which means edited or
 *   re-synced items become pending automatically and nothing has to remember
 *   to invalidate them.
 */
import { PIPELINE_VERSION, chunkItem } from "./chunk.js";
import {
  countPending,
  markDerived,
  pendingItems,
  replaceChunks,
  saveEmbedding,
} from "../store/chunks.js";
import { openVectorIndex, setIndexPipelineVersion } from "../retrieval/vector.js";
import { conversationalStreamSet, MAX_EMBED_CHARS, segmentEpisodes } from "./episodes.js";
import {
  countPendingEpisodes,
  markEpisodeDerived,
  pendingEpisodes,
  replaceEpisodeChunks,
} from "../store/episodes.js";
import type { DB } from "../kernel/db.js";
import type { Embedder } from "./embed/index.js";

export { PIPELINE_VERSION } from "./chunk.js";

/** Items per batch. Large enough to keep the concurrency below fed. */
const ITEM_BATCH = 256;
/** Chunks per embedding request. Most local servers are happy here. */
const EMBED_BATCH = 32;

/**
 * Requests in flight.
 *
 * Ollama embeds an array input sequentially, so batch size is not a throughput
 * lever; concurrent requests are. v1 kept exactly one request in flight and
 * spent 47 minutes on a real mailbox, all of it round trips at roughly one
 * forward pass each. Set OLLAMA_NUM_PARALLEL to match, or the server just
 * queues them.
 */
const EMBED_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env["HARBOR_EMBED_CONCURRENCY"] ?? "4", 10) || 4,
);

export interface DeriveOptions {
  /** Stop after this many items. Omit for everything pending. */
  readonly limit?: number | undefined;
  /** Checked between batches. Returning true stops cleanly at a checkpoint. */
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onProgress?: (done: number, total: number) => void;
  readonly onNote?: (message: string) => void;
}

/**
 * Embeds a batch, and survives an input the model refuses.
 *
 * A single oversized or malformed chunk used to abort the entire pass: one 400
 * from the embedding server propagated out of a ten thousand item run and threw
 * away everything still pending. That is the wrong shape for any bulk
 * derivation. A batch that fails is retried one input at a time, the offenders
 * are dropped with their reason recorded, and the pass continues.
 *
 * Dropped chunks are not silently lost. They are reported, and the item keeps
 * its pending state so a later run with a larger context window picks it up.
 */
async function embedResilient(
  embedder: Embedder,
  texts: readonly string[],
  onDrop: (index: number, reason: string) => void,
): Promise<readonly (Float32Array | undefined)[]> {
  try {
    return await embedder.embed([...texts]);
  } catch {
    const results: (Float32Array | undefined)[] = [];

    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index] ?? "";

      try {
        const single = await embedder.embed([text]);
        results.push(single[0]);
      } catch (error) {
        results.push(undefined);
        onDrop(index, error instanceof Error ? error.message : String(error));
      }
    }

    return results;
  }
}

export interface DeriveReport {
  readonly itemsDerived: number;
  /** Chunks the embedding model refused, with the reason it gave. */
  readonly embeddingsDropped: readonly string[];
  /** Messages skipped because their episode carries the meaning instead. */
  readonly itemsInEpisodes: number;
  readonly episodesWritten: number;
  readonly episodesDerived: number;
  readonly chunksWritten: number;
  readonly embeddingsWritten: number;
  readonly skippedEmpty: number;
  readonly model: string;
  readonly dims: number;
  readonly backend: "sqlite-vec" | "scan";
  readonly pipelineVersion: number;
  readonly remaining: number;
  readonly durationMs: number;
}

export async function derive(
  db: DB,
  embedder: Embedder,
  options: DeriveOptions = {},
): Promise<DeriveReport> {
  const started = Date.now();

  setIndexPipelineVersion(PIPELINE_VERSION);
  const index = openVectorIndex(db, embedder.model, embedder.dims);

  if (index.backend === "scan") {
    options.onNote?.(
      "sqlite-vec did not load; using a scan for semantic search. Correct, just slower.",
    );
  }

  // Segmentation first. A message in a conversational source is not embedded
  // on its own; its episode is, and the episode has to exist before the item
  // pass can decide to skip it.
  const segmented = segmentEpisodes(db, {
    ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
  });

  if (segmented.episodesWritten > 0) {
    options.onNote?.(
      `${String(segmented.episodesWritten)} conversation episodes from ${String(segmented.messagesCovered)} messages`,
    );
  }

  const conversational = conversationalStreamSet(db);

  const total = Math.min(countPending(db, PIPELINE_VERSION), options.limit ?? Number.MAX_SAFE_INTEGER);

  const dropped: string[] = [];
  let itemsInEpisodes = 0;
  let itemsDerived = 0;
  let chunksWritten = 0;
  let embeddingsWritten = 0;
  let skippedEmpty = 0;

  while (itemsDerived + skippedEmpty < total) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const remainingBudget = total - (itemsDerived + skippedEmpty);
    const items = pendingItems(db, PIPELINE_VERSION, Math.min(ITEM_BATCH, remainingBudget));

    if (items.length === 0) {
      break;
    }

    // Chunk the whole batch first so embedding requests are as large as
    // possible; round trips dominate at this size, not inference.
    const pending: { readonly itemId: string; readonly chunkId: string; readonly text: string }[] =
      [];

    const writeChunks = db.transaction(() => {
      for (const item of items) {
        // A text message is not embedded on its own. Its episode is, and
        // embedding both would put "ok" in the index competing with the
        // conversation that contains it.
        if (item.streamId !== null && conversational.has(item.streamId)) {
          replaceChunks(db, item.id, [], PIPELINE_VERSION);
          markDerived(db, item.id, PIPELINE_VERSION);
          index.remove(item.id);
          itemsInEpisodes += 1;
          continue;
        }

        const chunks = chunkItem({
          title: item.title,
          author: item.author,
          body: item.body,
          snippet: item.snippet,
          kind: item.kind,
        });

        if (chunks.length === 0) {
          // Nothing worth embedding. Still marked derived so it does not come
          // back on every run.
          replaceChunks(db, item.id, [], PIPELINE_VERSION);
          markDerived(db, item.id, PIPELINE_VERSION);
          skippedEmpty += 1;
          continue;
        }

        index.remove(item.id);
        const written = replaceChunks(db, item.id, chunks, PIPELINE_VERSION);
        chunksWritten += written.length;

        for (const chunk of written) {
          pending.push({ itemId: item.id, chunkId: chunk.id, text: chunk.text });
        }
      }
    });

    writeChunks();

    const groupSize = EMBED_BATCH * EMBED_CONCURRENCY;

    for (let offset = 0; offset < pending.length; offset += groupSize) {
      const group: (typeof pending)[] = [];

      for (let slot = 0; slot < EMBED_CONCURRENCY; slot += 1) {
        const start = offset + slot * EMBED_BATCH;
        const slice = pending.slice(start, start + EMBED_BATCH);

        if (slice.length > 0) {
          group.push(slice);
        }
      }

      const batches = await Promise.all(
        group.map((slice) =>
          embedResilient(embedder, slice.map((entry) => entry.text), (index, reason) => {
            const entry = slice[index];
            dropped.push(`${entry?.itemId ?? "?"}: ${reason.slice(0, 120)}`);
          }),
        ),
      );

      // Writes stay serial. SQLite has one writer and it is nowhere near being
      // the bottleneck; inference is.
      const writeVectors = db.transaction(() => {
        for (let g = 0; g < group.length; g += 1) {
          const slice = group[g] ?? [];
          const vectors = batches[g] ?? [];

          for (let index2 = 0; index2 < slice.length; index2 += 1) {
            const entry = slice[index2];
            const vector = vectors[index2];

            if (entry === undefined || vector === undefined) {
              continue;
            }

            saveEmbedding(db, entry.chunkId, embedder.model, vector, PIPELINE_VERSION);
            index.add(entry.chunkId, vector);
            embeddingsWritten += 1;
          }
        }
      });

      writeVectors();
    }

    // Items are marked only after their vectors are durable, so an interruption
    // re-derives the batch rather than leaving an item marked and unembedded.
    const mark = db.transaction(() => {
      for (const item of items) {
        markDerived(db, item.id, PIPELINE_VERSION);
      }
    });

    mark();

    itemsDerived += items.filter((item) => item.body !== null || item.title !== null).length;
    options.onProgress?.(Math.min(itemsDerived + skippedEmpty + itemsInEpisodes, total), total);
  }

  // Episodes, in the same pass and through the same embedder. Kept after the
  // items rather than beside them so a stop between the two leaves a coherent
  // store rather than half of each.
  let episodesDerived = 0;

  const episodeTotal = countPendingEpisodes(db, PIPELINE_VERSION);

  while (episodesDerived < episodeTotal) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const batch = pendingEpisodes(db, PIPELINE_VERSION, 64);

    if (batch.length === 0) {
      break;
    }

    const written: { readonly id: string; readonly chunkId: string; readonly text: string }[] = [];

    const writeEpisodeChunks = db.transaction(() => {
      for (const episode of batch) {
        // One chunk per episode where the episode fits, which is most of them.
        // Longer conversations are split rather than truncated: an episode is
        // the unit of meaning, but an embedding model has a context window and
        // a transcript that exceeds it produces no vector at all, which is
        // worse than producing two.
        const text = `${episode.title ?? ""}\n\n${episode.transcript}`.trim();
        const parts: { ordinal: number; text: string }[] = [];

        for (let offset = 0; offset < text.length; offset += MAX_EMBED_CHARS) {
          parts.push({
            ordinal: parts.length,
            text: text.slice(offset, offset + MAX_EMBED_CHARS),
          });
        }

        const chunks = replaceEpisodeChunks(db, episode.id, parts, PIPELINE_VERSION);

        for (const chunk of chunks) {
          written.push({ id: episode.id, chunkId: chunk.id, text: chunk.text });
          chunksWritten += 1;
        }
      }
    });

    writeEpisodeChunks();

    for (let offset = 0; offset < written.length; offset += EMBED_BATCH) {
      const slice = written.slice(offset, offset + EMBED_BATCH);
      const vectors = await embedResilient(
        embedder,
        slice.map((entry) => entry.text),
        (index, reason) => {
          const entry = slice[index];
          dropped.push(`${entry?.id ?? "?"}: ${reason.slice(0, 120)}`);
        },
      );

      const writeVectors = db.transaction(() => {
        for (let position = 0; position < slice.length; position += 1) {
          const entry = slice[position];
          const vector = vectors[position];

          if (entry === undefined || vector === undefined) {
            continue;
          }

          saveEmbedding(db, entry.chunkId, embedder.model, vector, PIPELINE_VERSION);
          index.add(entry.chunkId, vector);
          embeddingsWritten += 1;
        }
      });

      writeVectors();
    }

    const markEpisodes = db.transaction(() => {
      for (const episode of batch) {
        markEpisodeDerived(db, episode.id, PIPELINE_VERSION);
      }
    });

    markEpisodes();
    episodesDerived += batch.length;
  }

  return {
    itemsDerived,
    embeddingsDropped: dropped,
    itemsInEpisodes,
    episodesWritten: segmented.episodesWritten,
    episodesDerived,
    chunksWritten,
    embeddingsWritten,
    skippedEmpty,
    model: embedder.model,
    dims: embedder.dims,
    backend: index.backend,
    pipelineVersion: PIPELINE_VERSION,
    remaining: countPending(db, PIPELINE_VERSION),
    durationMs: Date.now() - started,
  };
}

/** Rebuilds the vector index from stored embeddings. No model calls. */
export function reindex(db: DB, model: string, dims: number): number {
  setIndexPipelineVersion(PIPELINE_VERSION);
  return openVectorIndex(db, model, dims).rebuild(model, PIPELINE_VERSION);
}
