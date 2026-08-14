/**
 * Edges between nodes, and the situations assembled from them.
 *
 * The distinction between the two is the whole design. An edge is a small,
 * deterministic, individually boring fact: this message replies to that one,
 * this conversation arranged that calendar entry. A situation is a claim that a
 * set of nodes are about one real-world thing, which is a much larger claim and
 * is only ever derived from edges rather than asserted directly.
 *
 * Keeping them apart means the expensive, fallible part sits on top of a layer
 * that is cheap and checkable. When a situation is wrong you can look at the
 * edges that produced it, and each of those carries the reason it was drawn.
 *
 * An endpoint is a node, not an item: see `store/nodes.ts` for why that
 * distinction is the difference between a graph of conversations and a graph of
 * fragments.
 */
import { createHash } from "node:crypto";
import { CONVERSATIONAL_CONNECTORS, itemsOf, nodeKey } from "./nodes.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "./nodes.js";

/**
 * The kinds of edge Harbor draws.
 *
 * Deliberately few, and every one of them deterministic. A model is not
 * involved in drawing edges: the point of this layer is that it can be verified
 * by reading it, and a graph nobody can check is worse than no graph.
 */
export type RelationKind =
  /** Same conversation, by the source's own threading. */
  | "same_thread"
  /** A calendar entry that a message or conversation appears to have arranged. */
  | "arranges"
  /** A message that refers to a date something else occupies. */
  | "mentions_when"
  /** A task or reminder covering the same commitment as a message. */
  | "tracks"
  /** Both name the same specific thing: a flight, an order, a document. */
  | "shares_reference"
  /** Both are about the same distinctive subject, across sources. */
  | "about_same"
  /** Close in time, between the same people, across different sources. */
  | "adjacent";

export interface Relationship {
  readonly id: string;
  readonly from: NodeRef;
  readonly to: NodeRef;
  readonly kind: RelationKind;
  readonly confidence: number;
  /** Why this edge exists, in words. Shown to a person, never parsed. */
  readonly evidence: string;
  readonly detector: string;
  readonly createdAt: number;
}

interface RelationshipRow {
  readonly id: string;
  readonly from_kind: string;
  readonly from_id: string;
  readonly to_kind: string;
  readonly to_id: string;
  readonly kind: RelationKind;
  readonly confidence: number;
  readonly evidence: string;
  readonly detector: string;
  readonly created_at: number;
}

function hydrate(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    from: { kind: row.from_kind as NodeRef["kind"], id: row.from_id },
    to: { kind: row.to_kind as NodeRef["kind"], id: row.to_id },
    kind: row.kind,
    confidence: row.confidence,
    evidence: row.evidence,
    detector: row.detector,
    createdAt: row.created_at,
  };
}

/**
 * Edges are undirected in practice, so they are stored in one canonical order.
 *
 * Without this, a detector that draws A to B and another that draws B to A
 * produce two rows for one fact, and the unique constraint never fires.
 */
function canonical(a: NodeRef, b: NodeRef): readonly [NodeRef, NodeRef] {
  return nodeKey(a) < nodeKey(b) ? [a, b] : [b, a];
}

function edgeId(from: NodeRef, to: NodeRef, kind: string): string {
  const material = `${nodeKey(from)}|${nodeKey(to)}|${kind}`;

  return `r_${createHash("sha256").update(material).digest("hex").slice(0, 20)}`;
}

export interface RelationshipInput {
  readonly from: NodeRef;
  readonly to: NodeRef;
  readonly kind: RelationKind;
  readonly confidence: number;
  readonly evidence: string;
  readonly detector: string;
}

/**
 * Writes an edge, and reports whether it is new.
 *
 * "New" rather than "written", and the difference is not cosmetic. Candidate
 * generation is symmetric, so during a full pass most pairs are judged twice,
 * once from each side. An upsert reports a change either way, so counting
 * changes made every run claim roughly twice as many edges as the graph
 * actually contains. `created_at` is set on insert and never updated, so
 * comparing it to this call's timestamp distinguishes the two exactly.
 */
export interface LinkOutcome {
  readonly id: string;
  readonly inserted: boolean;
}

export function link(db: DB, input: RelationshipInput): LinkOutcome | null {
  if (nodeKey(input.from) === nodeKey(input.to)) {
    return null;
  }

  const [from, to] = canonical(input.from, input.to);
  const id = edgeId(from, to, input.kind);
  const now = Date.now();

  const row = db
    .prepare(
      `INSERT INTO relationships
         (id, from_kind, from_id, to_kind, to_id, kind, confidence, evidence, detector, created_at)
       VALUES (@id, @fromKind, @fromId, @toKind, @toId, @kind, @confidence, @evidence,
               @detector, @now)
       ON CONFLICT (from_kind, from_id, to_kind, to_id, kind) DO UPDATE SET
         confidence = MAX(confidence, excluded.confidence),
         evidence = excluded.evidence
       RETURNING created_at AS created`,
    )
    .get({
      id,
      fromKind: from.kind,
      fromId: from.id,
      toKind: to.kind,
      toId: to.id,
      kind: input.kind,
      confidence: input.confidence,
      evidence: input.evidence,
      detector: input.detector,
      now,
    }) as { created: number } | undefined;

  return { id, inserted: row !== undefined && row.created === now };
}

/** Everything connected to one node, in either direction. */
export function edgesFor(db: DB, ref: NodeRef): readonly Relationship[] {
  const rows = db
    .prepare(
      `SELECT * FROM relationships
       WHERE (from_kind = @kind AND from_id = @id) OR (to_kind = @kind AND to_id = @id)
       ORDER BY confidence DESC`,
    )
    .all({ kind: ref.kind, id: ref.id }) as RelationshipRow[];

  return rows.map(hydrate);
}

/**
 * One entry per neighbour, keeping the strongest reason and noting the rest.
 *
 * Linkers are independent and do not see each other, which is right: two
 * unrelated reasons to connect two things is better evidence than one. It is
 * not better *reading*, though. A conversation that both names a calendar entry
 * and shares distinctive words with it produces `arranges` and `about_same`,
 * and showing a person the same connection twice makes the display look like
 * the graph is confused when it is actually more confident.
 *
 * So the strongest edge wins and the others become supporting evidence on it.
 * Nothing is discarded from the store; this is a view.
 */
export interface Connection {
  readonly to: NodeRef;
  readonly kind: RelationKind;
  readonly confidence: number;
  readonly evidence: string;
  /** Other reasons the same pair was linked, strongest first. */
  readonly also: readonly string[];
}

export function connectionsFor(db: DB, ref: NodeRef): readonly Connection[] {
  const byNeighbour = new Map<string, { edges: Relationship[]; to: NodeRef }>();

  for (const edge of edgesFor(db, ref)) {
    const to = otherEnd(edge, ref);
    const key = nodeKey(to);
    const existing = byNeighbour.get(key);

    if (existing === undefined) {
      byNeighbour.set(key, { edges: [edge], to });
    } else {
      existing.edges.push(edge);
    }
  }

  const connections: Connection[] = [];

  for (const { edges, to } of byNeighbour.values()) {
    const sorted = [...edges].sort((a, b) => b.confidence - a.confidence);
    const best = sorted[0];

    if (best === undefined) {
      continue;
    }

    connections.push({
      to,
      kind: best.kind,
      confidence: best.confidence,
      evidence: best.evidence,
      also: sorted.slice(1).map((edge) => edge.evidence),
    });
  }

  return connections.sort((a, b) => b.confidence - a.confidence);
}

/** The far end of an edge, given one end of it. */
export function otherEnd(edge: Relationship, ref: NodeRef): NodeRef {
  return edge.from.kind === ref.kind && edge.from.id === ref.id ? edge.to : edge.from;
}

export function countEdges(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM relationships`).get() as { n: number }).n;
}

export function edgeBreakdown(db: DB): readonly { kind: string; count: number }[] {
  return db
    .prepare(`SELECT kind, COUNT(*) AS count FROM relationships GROUP BY kind ORDER BY count DESC`)
    .all() as { kind: string; count: number }[];
}

const STREAM_OF = `COALESCE(
  (SELECT stream_id FROM items WHERE id = @id AND @kind = 'item'),
  (SELECT stream_id FROM episodes WHERE id = @id AND @kind = 'episode')
)`;

/**
 * How many edges cross a source boundary.
 *
 * The number worth watching, and the one that exposed the original defect: on
 * the first real run, 35,784 of 35,898 edges were same-source, which means the
 * graph was restating what Gmail and Messages already show. Reported by every
 * relate pass so a regression is visible in one line rather than three weeks
 * later in a bad answer.
 */
export function crossSourceEdges(db: DB): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM relationships r
         WHERE ${STREAM_OF.replace(/@id/g, "r.from_id").replace(/@kind/g, "r.from_kind")}
            <> ${STREAM_OF.replace(/@id/g, "r.to_id").replace(/@kind/g, "r.to_kind")}`,
      )
      .get() as { n: number }
  ).n;
}

// ---- situations ----

export interface Thread {
  readonly id: string;
  readonly principalId: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly kind: string;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly itemCount: number;
  /** How many distinct sources contributed. The whole point of a situation. */
  readonly sourceCount: number;
  readonly salience: number;
  readonly updatedAt: number;
}

interface ThreadRow {
  readonly id: string;
  readonly principal_id: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly kind: string;
  readonly starts_at: number | null;
  readonly ends_at: number | null;
  readonly item_count: number;
  readonly source_count: number;
  readonly salience: number;
  readonly updated_at: number;
}

function hydrateThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    principalId: row.principal_id,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    itemCount: row.item_count,
    sourceCount: row.source_count,
    salience: row.salience,
    updatedAt: row.updated_at,
  };
}

export interface ThreadInput {
  readonly principalId: string;
  readonly title: string | null;
  readonly kind: string;
  readonly nodes: readonly NodeRef[];
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly sourceCount: number;
  readonly salience: number;
}

/**
 * A situation's id is a function of what is in it.
 *
 * Situations are rebuilt from scratch on every relate, and with a random id
 * that meant the same situation came back as a different row every few minutes.
 * Anything holding one (a dismissal, a saved link, an observation's evidence)
 * pointed at a row that no longer existed, and the only symptom was things
 * quietly reappearing after being dismissed.
 *
 * Hashing the membership means a rebuild that finds the same situation gives it
 * the same id, and one that genuinely grew gets a new one, which is correct: it
 * is not the same claim any more.
 */
function threadId(nodes: readonly NodeRef[]): string {
  const digest = createHash("sha256").update(nodes.map(nodeKey).sort().join("|")).digest("hex");

  return `th_${digest.slice(0, 16)}`;
}

export function saveThread(db: DB, input: ThreadInput): Thread {
  const id = threadId(input.nodes);
  const now = Date.now();

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO threads
         (id, principal_id, title, kind, starts_at, ends_at, item_count, source_count,
          salience, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         kind = excluded.kind,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         item_count = excluded.item_count,
         source_count = excluded.source_count,
         salience = excluded.salience,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      input.principalId,
      input.title,
      input.kind,
      input.startsAt,
      input.endsAt,
      input.nodes.length,
      input.sourceCount,
      input.salience,
      now,
      now,
    );

    const attach = db.prepare(
      `INSERT INTO thread_nodes (thread_id, node_kind, node_id) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );

    for (const ref of input.nodes) {
      attach.run(id, ref.kind, ref.id);
    }
  });

  write();

  const thread = getThread(db, id);

  if (thread === null) {
    throw new Error(`Situation ${id} vanished immediately after being written`);
  }

  return thread;
}

export function getThread(db: DB, id: string): Thread | null {
  const row = db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
  return row === undefined ? null : hydrateThread(row);
}

/** The nodes in a situation, oldest first. */
export function threadNodes(db: DB, id: string): readonly NodeRef[] {
  const rows = db
    .prepare(
      `SELECT tn.node_kind AS kind, tn.node_id AS id,
              COALESCE(
                (SELECT occurred_at FROM items WHERE id = tn.node_id AND tn.node_kind = 'item'),
                (SELECT starts_at FROM episodes WHERE id = tn.node_id AND tn.node_kind = 'episode'),
                0
              ) AS at
       FROM thread_nodes tn
       WHERE tn.thread_id = ?
       ORDER BY at`,
    )
    .all(id) as { kind: NodeRef["kind"]; id: string; at: number }[];

  return rows.map((row) => ({ kind: row.kind, id: row.id }));
}

/**
 * Every item a situation covers, oldest first.
 *
 * Situations hold nodes, and a node may be a conversation standing for forty
 * messages. Detectors and the digest reason about items (was the last word
 * theirs, how long ago, what did it say), so they get the expansion rather than
 * the nodes.
 */
export function threadItemIds(db: DB, id: string): readonly string[] {
  const ids: string[] = [];

  for (const ref of threadNodes(db, id)) {
    ids.push(...itemsOf(db, ref));
  }

  return ids;
}

export function threadsFor(db: DB, ref: NodeRef): readonly Thread[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM threads t
       JOIN thread_nodes tn ON tn.thread_id = t.id
       WHERE tn.node_kind = ? AND tn.node_id = ?`,
    )
    .all(ref.kind, ref.id) as ThreadRow[];

  return rows.map(hydrateThread);
}

/**
 * Situations worth looking at.
 *
 * Ordered by salience rather than recency: something spanning three sources
 * over two weeks matters more than a newer thing that is a single mail thread
 * wearing a hat.
 */
export function topThreads(
  db: DB,
  principalId: string,
  options: { readonly limit?: number; readonly since?: number; readonly minSources?: number } = {},
): readonly Thread[] {
  const rows = db
    .prepare(
      `SELECT * FROM threads
       WHERE principal_id = @principal
         AND (@since IS NULL OR ends_at >= @since)
         AND source_count >= @minSources
       ORDER BY salience DESC, ends_at DESC
       LIMIT @limit`,
    )
    .all({
      principal: principalId,
      since: options.since ?? null,
      minSources: options.minSources ?? 1,
      limit: options.limit ?? 20,
    }) as ThreadRow[];

  return rows.map(hydrateThread);
}

/**
 * Clears every situation, leaving the edges.
 *
 * Situations are a grouping over edges, so rebuilding them is cheap and
 * rebuilding the edges is not. Keeping the two rebuildable independently means
 * the clustering can change without re-reading a quarter of a million items.
 */
export function clearThreads(db: DB): number {
  const work = db.transaction(() => {
    db.prepare(`DELETE FROM thread_nodes`).run();
    return db.prepare(`DELETE FROM threads`).run().changes;
  });

  return work();
}

export function countThreads(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM threads`).get() as { n: number }).n;
}

// ---- pending work ----

const CONVERSATIONAL_LIST = CONVERSATIONAL_CONNECTORS.map((id) => `'${id}'`).join(", ");

/**
 * Nodes awaiting a relationship pass.
 *
 * Items in conversational streams are excluded, because they are not graph
 * subjects: their episode stands in for them. That single clause is what turns
 * a pass over 218,000 messages into a pass over a few thousand conversations.
 */
export function countPendingRelationships(db: DB, version: number): number {
  return (
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM items i
              JOIN streams s ON s.id = i.stream_id
             WHERE i.deleted_at IS NULL
               AND s.connector_id NOT IN (${CONVERSATIONAL_LIST})
               AND (i.relationships_version IS NULL OR i.relationships_version < @version))
         + (SELECT COUNT(*) FROM episodes
             WHERE relationships_version IS NULL OR relationships_version < @version)
           AS n`,
      )
      .get({ version }) as { n: number }
  ).n;
}

export function markRelated(db: DB, refs: readonly NodeRef[], version: number): void {
  const markItem = db.prepare(`UPDATE items SET relationships_version = ? WHERE id = ?`);
  const markEpisode = db.prepare(`UPDATE episodes SET relationships_version = ? WHERE id = ?`);

  const work = db.transaction(() => {
    for (const ref of refs) {
      if (ref.kind === "item") {
        markItem.run(version, ref.id);
      } else {
        markEpisode.run(version, ref.id);
      }
    }
  });

  work();
}

/**
 * Marks every message in a conversational stream as needing no graph work.
 *
 * Not a shortcut. A message inside an episode is represented in the graph by
 * that episode, so leaving these pending forever would mean the pass never
 * reported itself finished and `harbor status` would permanently claim a
 * quarter of a million items of outstanding work.
 */
export function dismissConversationalItems(db: DB, version: number): number {
  return db
    .prepare(
      `UPDATE items SET relationships_version = @version
       WHERE deleted_at IS NULL
         AND (relationships_version IS NULL OR relationships_version < @version)
         AND stream_id IN (SELECT id FROM streams WHERE connector_id IN (${CONVERSATIONAL_LIST}))`,
    )
    .run({ version }).changes;
}

// ---- rebuilding ----

/**
 * Removes every edge.
 *
 * Only used by `--rebuild`, and it is the reason that flag is meaningful:
 * redrawing without clearing means a rebuild can only ever add, so an edge
 * drawn by a linker that has since been fixed lives forever and nothing reports
 * it.
 */
export function clearEdges(db: DB): number {
  return db.prepare(`DELETE FROM relationships`).run().changes;
}

/** Marks every node as needing to be related again. */
export function resetRelationshipVersions(db: DB): number {
  const work = db.transaction(() => {
    const items = db
      .prepare(
        `UPDATE items SET relationships_version = NULL WHERE relationships_version IS NOT NULL`,
      )
      .run().changes;

    const episodes = db
      .prepare(
        `UPDATE episodes SET relationships_version = NULL WHERE relationships_version IS NOT NULL`,
      )
      .run().changes;

    return items + episodes;
  });

  return work();
}
