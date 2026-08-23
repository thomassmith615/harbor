/**
 * The relationship pass.
 *
 * Three phases, in order.
 *
 *   1. Index references. A node whose identifiers have not been extracted
 *      cannot be found by the node that shares one with it, so this runs to
 *      completion before any edge is drawn.
 *
 *   2. Draw edges. For each node that has not been considered at this version,
 *      generate a candidate set from the whole store and judge every pair.
 *
 *   3. Rebuild situations, which is a grouping over edges and cheap.
 *
 * What a subject is changed in M9, and it is the change that matters. Items in
 * conversational streams are no longer subjects: their episode stands in for
 * them. On a real store that is 218,000 messages replaced by a few thousand
 * conversations, which is both twenty times cheaper and the only version that
 * can produce a meaningful edge, because a single text carries no linkable
 * content and an episode does.
 *
 * The property worth holding on to: an incremental run and a full rebuild
 * should produce the same graph. Candidate generation is symmetric and every
 * linker is a pure function of a pair, so they do, up to the fan-out caps in
 * candidates.ts, which are deliberately set far above where real data sits.
 */
import { LINKERS, RELATIONSHIP_VERSION } from "./linkers.js";
import { candidatesFor } from "./candidates.js";
import { indexReferences, REFERENCE_VERSION } from "./references.js";
import { TermIndex } from "./terms.js";
import { NoiseIndex } from "./noise.js";
import {
  clearEdges,
  countEdges,
  countPendingRelationships,
  crossSourceEdges,
  dismissConversationalItems,
  dismissItems,
  edgeBreakdown,
  link,
  markRelated,
  outdatedNodeCount,
  resetRelationshipVersions,
} from "../store/relationships.js";
import { countReferences, referencesFor } from "../store/references.js";
import { entitiesOfNode, nodeKey, NodeResolver } from "../store/nodes.js";
import { selfEntity } from "../store/entities.js";
import { buildThreads } from "./threads.js";
import type { DB } from "../kernel/db.js";
import type { GraphNode, NodeRef } from "../store/nodes.js";
import type { LinkerContext } from "./linkers.js";
import type { ThreadReport } from "./threads.js";

export interface RelateOptions {
  readonly principalId: string;
  readonly timezone: string;
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
}

export interface RelateReport {
  readonly nodesExamined: number;
  readonly candidatesConsidered: number;
  readonly edgesDrawn: number;
  readonly totalEdges: number;
  /** Edges joining two different sources. The number the product lives on. */
  readonly crossSource: number;
  readonly references: number;
  readonly byKind: readonly { readonly kind: string; readonly count: number }[];
  readonly threads: ThreadReport;
  readonly remaining: number;
  readonly durationMs: number;
}

/**
 * Nodes per checkpoint.
 *
 * Only a checkpoint interval, not a candidate pool: a smaller one means an
 * interrupted run loses less and nothing else changes.
 */
const BATCH = 200;

/**
 * Everyone on a node, the user excluded, cached for the life of one pass.
 *
 * A subject and its candidates are looked up repeatedly by different linkers,
 * and the same neighbouring nodes recur across subjects. Without the cache this
 * is the hot query in the pass.
 */
function entityCache(
  db: DB,
  selfEntityId: string | null,
): (node: GraphNode) => ReadonlySet<string> {
  const cache = new Map<string, ReadonlySet<string>>();

  return (node: GraphNode): ReadonlySet<string> => {
    const key = nodeKey(node.ref);
    const hit = cache.get(key);

    if (hit !== undefined) {
      return hit;
    }

    const set = new Set(entitiesOfNode(db, node.ref));

    // The user is on nearly everything, so sharing only them is not evidence of
    // anything.
    if (selfEntityId !== null) {
      set.delete(selfEntityId);
    }

    cache.set(key, set);
    return set;
  };
}

/**
 * The next batch of nodes needing work.
 *
 * Episodes first. They are far fewer than items and they are the side that
 * reaches into conversations, so doing them early means a run that is
 * interrupted has still drawn the edges that matter most.
 */
function pendingNodes(db: DB, limit: number): readonly NodeRef[] {
  const episodes = db
    .prepare(
      `SELECT id FROM episodes
       WHERE relationships_version IS NULL OR relationships_version < @version
       ORDER BY ends_at DESC LIMIT @limit`,
    )
    .all({ version: RELATIONSHIP_VERSION, limit }) as { id: string }[];

  const refs: NodeRef[] = episodes.map((row) => ({ kind: "episode", id: row.id }));

  if (refs.length >= limit) {
    return refs;
  }

  const items = db
    .prepare(
      `SELECT i.id FROM items i
       JOIN streams s ON s.id = i.stream_id
       WHERE i.deleted_at IS NULL
         AND s.connector_id NOT IN ('imessage')
         AND (i.relationships_version IS NULL OR i.relationships_version < @version)
       ORDER BY i.occurred_at DESC LIMIT @limit`,
    )
    .all({ version: RELATIONSHIP_VERSION, limit: limit - refs.length }) as { id: string }[];

  for (const row of items) {
    refs.push({ kind: "item", id: row.id });
  }

  return refs;
}

export function relate(db: DB, options: RelateOptions): RelateReport {
  const started = Date.now();

  // A linker change is a rebuild, not a top-up.
  //
  // Bumping RELATIONSHIP_VERSION used to queue every node again and leave the
  // existing edges alone, because nothing deletes an edge and there is no
  // version on one to expire it by. The pass then re-judged every pair,
  // declined to draw the edges it now disagreed with, and reported "0
  // connections drawn" while every wrong edge stayed exactly where it was. From
  // outside, a fix that worked and a fix that did nothing looked the same.
  //
  // Clearing here rather than behind a flag, because the flag existed
  // (`harbor dev relate --rebuild`) and nobody upgrading knows to type it.
  if (outdatedNodeCount(db, RELATIONSHIP_VERSION) > 0) {
    const removed = clearEdges(db);
    resetRelationshipVersions(db);

    options.onNote?.(
      `the linkers changed, so ${String(removed)} edges were thrown away and the graph ` +
        `is being drawn again from scratch`,
    );
  }

  // Phase 1. References first, always, and not subject to the node limit: a
  // partially indexed store draws edges that a later run would have drawn
  // differently, which is exactly the silent inconsistency this pass is
  // supposed to have stopped having.
  const references = indexReferences(db, {
    ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
  });

  if (references.itemsScanned > 0) {
    options.onNote?.(
      `${String(references.referencesFound)} references indexed from ${String(references.itemsScanned)} items`,
    );
  }

  // Messages inside conversations are represented by their episode, so they are
  // retired from the queue rather than left pending forever.
  const dismissed = dismissConversationalItems(db, RELATIONSHIP_VERSION);

  if (dismissed > 0) {
    options.onNote?.(
      `${String(dismissed)} messages are covered by their conversation and were not linked individually`,
    );
  }

  const self = selfEntity(db);
  const selfEntityId = self === null ? null : self.id;

  if (selfEntityId === null) {
    options.onNote?.(
      "no self entity yet, so shared-person tests will be weaker. Run `harbor dev resolve` first.",
    );
  }

  const noise = new NoiseIndex(db);
  dismissItems(db, noise.templateIds, RELATIONSHIP_VERSION);
  const noiseReport = noise.report();

  if (noiseReport.repeatedTasks > 0) {
    options.onNote?.(
      `${String(noiseReport.repeatedTasks)} repeat occurrences of recurring reminders ` +
        "are represented by their first instance",
    );
  }

  if (noiseReport.templateItems > 0) {
    options.onNote?.(
      `${String(noiseReport.templateItems)} items across ` +
        `${String(noiseReport.templateShapes)} recurring shapes are templates, not events`,
    );
  }

  if (noiseReport.broadcastItems > 0) {
    options.onNote?.(
      `${String(noiseReport.broadcastItems)} items from ` +
        `${String(noiseReport.broadcastSenders)} senders you have never written to are ` +
        "one-way mail, linkable by reference or reminder but never by a shared word",
    );
  }

  const resolver = new NodeResolver(db);
  const terms = new TermIndex(db);

  options.onNote?.(
    `a word counts as distinctive below ${String(terms.rarityCeiling)} appearances ` +
      `in ${String(terms.corpusSize)} things`,
  );

  const context: LinkerContext = {
    principalId: options.principalId,
    timezone: options.timezone,
    selfEntityId,
    terms,
    entitiesOf: entityCache(db, selfEntityId),
  };

  const total = Math.min(
    countPendingRelationships(db, RELATIONSHIP_VERSION),
    options.limit ?? Number.MAX_SAFE_INTEGER,
  );

  let examined = 0;
  let considered = 0;

  // Distinct edges, by id. A symmetric candidate set means a full pass judges
  // most pairs twice, and two inserts landing in the same millisecond are
  // indistinguishable by timestamp alone. Counting ids makes "edges drawn" and
  // "total edges" agree on a rebuild, which is the check that says incremental
  // and full runs produce the same graph.
  const drawnIds = new Set<string>();

  while (examined < total) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const refs = pendingNodes(db, Math.min(BATCH, total - examined));

    if (refs.length === 0) {
      break;
    }

    // One transaction per batch, matching every other pass: an interruption
    // costs the current batch and nothing more, and edges are idempotent so
    // repeating one is free.
    const work = db.transaction(() => {
      for (const ref of refs) {
        const subject = resolver.node(ref);

        if (subject === null) {
          continue;
        }

        const set = candidatesFor(db, subject, { resolver, terms, noise, selfEntityId });
        considered += set.candidates.length;

        for (const candidate of set.candidates) {
          for (const linker of LINKERS) {
            const judgement = linker.judge(subject, candidate, context);

            if (judgement === null || !("edge" in judgement)) {
              continue;
            }

            const outcome = link(db, judgement.edge);

            if (outcome !== null && outcome.inserted) {
              drawnIds.add(outcome.id);
            }
          }
        }
      }

      markRelated(db, refs, RELATIONSHIP_VERSION);
    });

    work();

    examined += refs.length;
    options.onProgress?.(examined, total);
  }

  // Situations are rebuilt whole rather than incrementally. A new edge can merge
  // two existing components, so there is no correct partial update, and the
  // rebuild reads edges rather than items. Ids are derived from membership, so a
  // rebuild that finds the same situation gives it the same id and anything
  // referring to it survives.
  const threads = buildThreads(db, options.principalId, noise);

  if (threads.threads > 0) {
    options.onNote?.(`${String(threads.threads)} situations spanning more than one source`);
  }

  return {
    nodesExamined: examined,
    candidatesConsidered: considered,
    edgesDrawn: drawnIds.size,
    totalEdges: countEdges(db),
    crossSource: crossSourceEdges(db),
    references: countReferences(db),
    byKind: edgeBreakdown(db),
    threads,
    remaining: countPendingRelationships(db, RELATIONSHIP_VERSION),
    durationMs: Date.now() - started,
  };
}

// ---- explanation ----

export interface CandidateExplanation {
  readonly key: string;
  readonly kind: string;
  readonly title: string | null;
  readonly occurredAt: number;
  readonly sameStream: boolean;
  readonly via: readonly string[];
  readonly drawn: readonly { readonly kind: string; readonly evidence: string }[];
  readonly rejected: readonly { readonly linker: string; readonly reason: string }[];
}

export interface Explanation {
  readonly subject: GraphNode;
  readonly references: readonly string[];
  readonly people: readonly string[];
  readonly distinctive: readonly string[];
  readonly notes: readonly string[];
  readonly candidates: readonly CandidateExplanation[];
}

/**
 * Why one node is connected to what it is connected to, and why it is not
 * connected to the rest.
 *
 * Nothing here writes. It runs the same generators and the same linkers the
 * pass runs, and reports what they said, which is the only honest way to answer
 * the question: an explanation derived from a second implementation would
 * eventually describe a system that no longer exists.
 */
export function explain(
  db: DB,
  ref: NodeRef,
  principalId: string,
  timezone: string,
): Explanation | null {
  const resolver = new NodeResolver(db);
  const subject = resolver.node(ref);

  if (subject === null) {
    return null;
  }

  const self = selfEntity(db);
  const selfEntityId = self === null ? null : self.id;
  const terms = new TermIndex(db);
  const noise = new NoiseIndex(db);

  const context: LinkerContext = {
    principalId,
    timezone,
    selfEntityId,
    terms,
    entitiesOf: entityCache(db, selfEntityId),
  };

  const set = candidatesFor(db, subject, { resolver, terms, noise, selfEntityId });

  const people = [...entitiesOfNode(db, ref)].map((entityId) => {
    const row = db.prepare(`SELECT display_name AS name FROM entities WHERE id = ?`).get(entityId) as
      | { name: string }
      | undefined;

    return row?.name ?? entityId;
  });

  const candidates: CandidateExplanation[] = [];

  for (const candidate of set.candidates) {
    const drawn: { kind: string; evidence: string }[] = [];
    const rejected: { linker: string; reason: string }[] = [];

    for (const linker of LINKERS) {
      const judgement = linker.judge(subject, candidate, context);

      if (judgement === null) {
        continue;
      }

      if ("edge" in judgement) {
        drawn.push({ kind: judgement.edge.kind, evidence: judgement.edge.evidence });
      } else {
        rejected.push({ linker: linker.id, reason: judgement.rejected });
      }
    }

    candidates.push({
      key: nodeKey(candidate.node.ref),
      kind: candidate.node.kind,
      title: candidate.node.title,
      occurredAt: candidate.node.occurredAt,
      sameStream: candidate.node.streamId === subject.streamId,
      via: candidate.via,
      drawn,
      rejected,
    });
  }

  const referenceStrings =
    ref.kind === "item"
      ? referencesFor(db, ref.id).map((entry) => `${entry.kind}:${entry.value}`)
      : [];

  return {
    subject,
    references: referenceStrings,
    people,
    distinctive: terms.distinctive(subject.text),
    notes: set.notes,
    candidates,
  };
}

export { REFERENCE_VERSION, RELATIONSHIP_VERSION };
