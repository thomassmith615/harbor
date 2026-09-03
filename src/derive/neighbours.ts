/**
 * Nearest neighbours, as a source of pairs to consider.
 *
 * The architectural claim this file rests on is narrow and worth stating,
 * because the README argues the opposite about a neighbouring concern and both
 * are right.
 *
 * Content *evidence* is deliberately not embeddings: an edge justified by "the
 * vectors agree" cannot be checked by the person it is wrong about, and an
 * unfalsifiable reason is worse than no edge. That argument is about the
 * sentence written under a connection.
 *
 * Content *candidates* are a different thing entirely. A generator produces no
 * output. It decides which pairs a linker gets to look at, and every linker
 * still has to justify what it draws in words a person can check. So the cost
 * of a loose generator is wasted comparisons, and the cost of a tight one is
 * permanent: a pair no generator produces is a pair no linker can ever judge,
 * and that is exactly how the graph came to be empty. Every existing generator
 * needs a shared word, a shared person, a shared identifier, or adjacency in a
 * thread, so two nodes about the same evening in different vocabulary were
 * never even compared.
 *
 * What this adds is the chance to be judged. Most of what it proposes will be
 * rejected, and that is the expected outcome rather than a failure.
 *
 * ## Why the vectors are worth trusting this far now
 *
 * They were not, before. Queries were embedded with no instruction prefix on
 * models that require one, and conversation was embedded as arbitrary
 * two-thousand character slices that averaged three subjects together. A
 * neighbour list built on that would have proposed noise. With prefixes,
 * line-aligned windows, and propositions folded in, a neighbour is a claim
 * about the text rather than a claim about the chunking.
 */
import { fromBlob, cosine } from "./embed/index.js";
import { nodeKey } from "../store/nodes.js";
import type { DB } from "../kernel/db.js";
import type { GraphNode, NodeRef } from "../store/nodes.js";

export interface Neighbour {
  readonly ref: NodeRef;
  readonly score: number;
}

/**
 * How many chunks are compared before ranking.
 *
 * A node has several chunks and each one has neighbours, so the raw set is
 * larger than the number of nodes returned. Capped because this runs per node
 * over the whole store.
 */
const SCAN_LIMIT = 400;

/**
 * Builds a neighbour lookup over the current vector table.
 *
 * Returns a function rather than an object because that is all
 * `candidatesFor` wants, and because a store with no vectors should degrade to
 * "no neighbours" rather than to an error: on a machine with no embedding
 * server the rest of the graph still works exactly as it did.
 */
export function neighbourLookup(
  db: DB,
  model: string,
): (node: GraphNode, limit: number) => readonly Neighbour[] {
  const hasVectors =
    (db.prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE model = ?`).get(model) as {
      n: number;
    }).n > 0;

  if (!hasVectors) {
    return () => [];
  }

  // Chunk vectors for one node, whichever table they live in.
  const itemChunks = db.prepare(
    `SELECT e.vector AS vector FROM chunks c
     JOIN embeddings e ON e.chunk_id = c.id
     WHERE c.item_id = ? AND e.model = ?`,
  );

  const episodeChunks = db.prepare(
    `SELECT e.vector AS vector FROM episode_chunks c
     JOIN embeddings e ON e.chunk_id = c.id
     WHERE c.episode_id = ? AND e.model = ?`,
  );

  // Everything else, once. Held in memory because the alternative is a scan
  // per node and the store is one person's, not a corpus.
  let corpus: { ref: NodeRef; vector: Float32Array }[] | null = null;

  const load = (): { ref: NodeRef; vector: Float32Array }[] => {
    if (corpus !== null) {
      return corpus;
    }

    const rows = db
      .prepare(
        `SELECT 'item' AS kind, c.item_id AS id, e.vector AS vector
         FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
         WHERE e.model = @model
         UNION ALL
         SELECT 'episode' AS kind, c.episode_id AS id, e.vector AS vector
         FROM episode_chunks c JOIN embeddings e ON e.chunk_id = c.id
         WHERE e.model = @model`,
      )
      .all({ model }) as { kind: string; id: string; vector: Buffer }[];

    corpus = rows.map((row) => ({
      ref: { kind: row.kind as NodeRef["kind"], id: row.id },
      vector: fromBlob(row.vector),
    }));

    return corpus;
  };

  return (node, limit) => {
    const own = (
      node.ref.kind === "episode"
        ? episodeChunks.all(node.ref.id, model)
        : itemChunks.all(node.ref.id, model)
    ) as { vector: Buffer }[];

    if (own.length === 0) {
      return [];
    }

    const vectors = own.map((row) => fromBlob(row.vector));
    const self = nodeKey(node.ref);

    // Best chunk against best chunk, not an average of either.
    //
    // Averaging is the mistake this whole layer exists to undo. A conversation
    // has several windows about different things, and the question is whether
    // any part of it is about any part of the other node, which a mean over
    // both silently answers "slightly".
    const best = new Map<string, Neighbour>();

    let scanned = 0;

    for (const entry of load()) {
      if (scanned >= SCAN_LIMIT * 20) {
        break;
      }

      scanned += 1;

      const key = nodeKey(entry.ref);

      if (key === self) {
        continue;
      }

      let score = 0;

      for (const vector of vectors) {
        const similarity = cosine(vector, entry.vector);

        if (similarity > score) {
          score = similarity;
        }
      }

      const held = best.get(key);

      if (held === undefined || held.score < score) {
        best.set(key, { ref: entry.ref, score });
      }
    }

    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  };
}
