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
import { CONVERSATIONAL_CONNECTORS, itemsOf, NON_EVENT_KINDS, nodeKey } from "./nodes.js";
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
  /** Harbor's opinion, or the person's decision. Passes never write this. */
  readonly state: SituationState;
  readonly titleSource: TitleSource;
  readonly stateChangedAt: number | null;
  /** When Harbor first saw this situation, across every rebuild since. */
  readonly firstSeenAt: number | null;
  /** When its membership last actually changed, as opposed to was rewritten. */
  readonly lastChangedAt: number | null;
  readonly nodeDigest: string | null;
}

export type SituationState = "open" | "resolved" | "dismissed";
export type TitleSource = "derived" | "user";

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
  readonly state: SituationState;
  readonly title_source: TitleSource;
  readonly state_changed_at: number | null;
  readonly first_seen_at: number | null;
  readonly last_changed_at: number | null;
  readonly node_digest: string | null;
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
    state: row.state,
    titleSource: row.title_source,
    stateChangedAt: row.state_changed_at,
    firstSeenAt: row.first_seen_at,
    lastChangedAt: row.last_changed_at,
    nodeDigest: row.node_digest,
  };
}

export interface ThreadInput {
  /** Minted by the caller. Never derived from the contents; see situations.ts. */
  readonly id: string;
  readonly principalId: string;
  readonly title: string | null;
  readonly titleSource: TitleSource;
  readonly kind: string;
  readonly nodes: readonly NodeRef[];
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly sourceCount: number;
  readonly salience: number;
  readonly nodeDigest: string;
  readonly firstSeenAt: number;
  readonly lastChangedAt: number;
  readonly state: SituationState;
  readonly stateChangedAt: number | null;
  readonly updatedAt: number;
}

/**
 * A situation as it stands before this pass, with everything the matcher needs.
 *
 * Loaded in two queries rather than one per situation: the matcher runs at the
 * end of every relate, which on the appliance is every fifteen minutes.
 */
export interface ExistingSituation {
  readonly id: string;
  readonly title: string | null;
  readonly titleSource: TitleSource;
  readonly state: SituationState;
  readonly stateChangedAt: number | null;
  readonly firstSeenAt: number | null;
  readonly lastChangedAt: number | null;
  readonly nodeDigest: string | null;
  readonly nodeKeys: ReadonlySet<string>;
}

export function existingSituations(db: DB, principalId: string): readonly ExistingSituation[] {
  const rows = db
    .prepare(
      `SELECT id, title, title_source, state, state_changed_at, first_seen_at,
              last_changed_at, node_digest
       FROM threads WHERE principal_id = ?`,
    )
    .all(principalId) as {
    id: string;
    title: string | null;
    title_source: TitleSource;
    state: SituationState;
    state_changed_at: number | null;
    first_seen_at: number | null;
    last_changed_at: number | null;
    node_digest: string | null;
  }[];

  if (rows.length === 0) {
    return [];
  }

  const keysById = new Map<string, Set<string>>();

  const members = db
    .prepare(
      `SELECT tn.thread_id AS thread_id, tn.node_kind AS kind, tn.node_id AS id
       FROM thread_nodes tn
       JOIN threads t ON t.id = tn.thread_id
       WHERE t.principal_id = ?`,
    )
    .all(principalId) as { thread_id: string; kind: string; id: string }[];

  for (const member of members) {
    const set = keysById.get(member.thread_id) ?? new Set<string>();
    set.add(`${member.kind}:${member.id}`);
    keysById.set(member.thread_id, set);
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    titleSource: row.title_source,
    state: row.state,
    stateChangedAt: row.state_changed_at,
    firstSeenAt: row.first_seen_at,
    lastChangedAt: row.last_changed_at,
    nodeDigest: row.node_digest,
    nodeKeys: keysById.get(row.id) ?? new Set<string>(),
  }));
}

/**
 * Writes a situation under an id the caller chose.
 *
 * Membership is replaced rather than merged: a node that left the component has
 * to leave the situation, or a situation only ever grows and eventually
 * describes everything.
 */
export function saveThread(db: DB, input: ThreadInput): Thread {
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO threads
         (id, principal_id, title, title_source, kind, starts_at, ends_at, item_count,
          source_count, salience, state, state_changed_at, first_seen_at, last_changed_at,
          node_digest, created_at, updated_at)
       VALUES (@id, @principalId, @title, @titleSource, @kind, @startsAt, @endsAt, @itemCount,
               @sourceCount, @salience, @state, @stateChangedAt, @firstSeenAt, @lastChangedAt,
               @nodeDigest, @firstSeenAt, @updatedAt)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         title_source = excluded.title_source,
         kind = excluded.kind,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         item_count = excluded.item_count,
         source_count = excluded.source_count,
         salience = excluded.salience,
         first_seen_at = excluded.first_seen_at,
         last_changed_at = excluded.last_changed_at,
         node_digest = excluded.node_digest,
         updated_at = excluded.updated_at`,
    ).run({
      id: input.id,
      principalId: input.principalId,
      title: input.title,
      titleSource: input.titleSource,
      kind: input.kind,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      itemCount: input.nodes.length,
      sourceCount: input.sourceCount,
      salience: input.salience,
      state: input.state,
      stateChangedAt: input.stateChangedAt,
      firstSeenAt: input.firstSeenAt,
      lastChangedAt: input.lastChangedAt,
      nodeDigest: input.nodeDigest,
      updatedAt: input.updatedAt,
    });

    db.prepare(`DELETE FROM thread_nodes WHERE thread_id = ?`).run(input.id);

    const attach = db.prepare(
      `INSERT INTO thread_nodes (thread_id, node_kind, node_id) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );

    for (const ref of input.nodes) {
      attach.run(input.id, ref.kind, ref.id);
    }
  });

  write();

  const thread = getThread(db, input.id);

  if (thread === null) {
    throw new Error(`Situation ${input.id} vanished immediately after being written`);
  }

  return thread;
}

export function deleteThread(db: DB, id: string): void {
  const work = db.transaction(() => {
    db.prepare(`DELETE FROM thread_nodes WHERE thread_id = ?`).run(id);
    db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
  });

  work();
}

/**
 * The person's decision about a situation.
 *
 * Separate from every write a pass makes, and that separation is the feature.
 * A derivation may change what is in a situation and what it is called; it may
 * not decide that something you dismissed is interesting again.
 */
/**
 * A written summary, and the rule that keeps it honest.
 *
 * Cleared rather than versioned. A summary describes a set of members, so the
 * moment the membership changes the sentence is about something that no longer
 * exists, and the safe state is having none. `reconcileSituations` already
 * computes whether membership changed; it drops the summary when it did, and
 * the naming pass fills the gap on its next run.
 *
 * The consequence worth accepting: a situation that grows shows no summary for
 * up to fifteen minutes. That beats showing a sentence about a set of things
 * that is not the set on the screen.
 */
export function setThreadSummary(db: DB, id: string, summary: string | null): void {
  db.prepare(`UPDATE threads SET summary = ? WHERE id = ?`).run(summary, id);
}

/** Situations with no summary yet, newest and most salient first. */
export function unsummarisedThreads(
  db: DB,
  principalId: string,
  limit: number,
): readonly Thread[] {
  const rows = db
    .prepare(
      `SELECT * FROM threads
       WHERE principal_id = ? AND summary IS NULL AND state = 'open'
       ORDER BY salience DESC, ends_at DESC
       LIMIT ?`,
    )
    .all(principalId, limit) as ThreadRow[];

  return rows.map(hydrateThread);
}

export function setThreadState(
  db: DB,
  id: string,
  state: SituationState,
  now: number = Date.now(),
): boolean {
  const changed = db
    .prepare(`UPDATE threads SET state = ?, state_changed_at = ? WHERE id = ?`)
    .run(state, state === "open" ? null : now, id).changes;

  return changed > 0;
}

/**
 * A title the person wrote, or handing it back.
 *
 * An empty title returns the situation to Harbor. That direction was missing,
 * and the omission was not harmless: a user title is exempt from renaming and
 * from retirement, so one rename made during a five-minute test pinned a real
 * situation open under the word "Test" permanently, with no command that could
 * undo it. Marking it derived again lets the next pass name it and lets it
 * retire when the graph stops proposing it.
 */
export function renameThread(db: DB, id: string, title: string): boolean {
  const wanted = title.trim();

  const changed =
    wanted.length === 0
      ? db
          .prepare(
            `UPDATE threads SET title_source = 'derived', summary = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(Date.now(), id).changes
      : db
          .prepare(
            `UPDATE threads SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?`,
          )
          .run(wanted, Date.now(), id).changes;

  return changed > 0;
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
  options: {
    readonly limit?: number;
    readonly since?: number;
    readonly minSources?: number;
    /**
     * Which states to include. Defaults to open only.
     *
     * Every caller that reasons or speaks (detectors, the digest, the ask
     * tools) wants the default. A person who resolved something has said it is
     * over, and continuing to reason about it is precisely the behaviour that
     * makes an assistant feel like it is not listening.
     */
    readonly states?: readonly SituationState[];
    /** Only situations whose membership changed since this instant. */
    readonly changedSince?: number;
  } = {},
): readonly Thread[] {
  const states = options.states ?? (["open"] as const);
  const placeholders = states.map(() => "?").join(", ");

  const rows = db
    .prepare(
      `SELECT * FROM threads
       WHERE principal_id = ?
         AND (? IS NULL OR ends_at >= ?)
         AND source_count >= ?
         AND (? IS NULL OR last_changed_at >= ?)
         AND state IN (${placeholders})
       ORDER BY salience DESC, ends_at DESC
       LIMIT ?`,
    )
    .all(
      principalId,
      options.since ?? null,
      options.since ?? null,
      options.minSources ?? 1,
      options.changedSince ?? null,
      options.changedSince ?? null,
      ...states,
      options.limit ?? 20,
    ) as ThreadRow[];

  return rows.map(hydrateThread);
}

/**
 * Clears every situation, leaving the edges.
 *
 * No longer part of a normal pass. Situations now carry identity across
 * rebuilds (see src/derive/situations.ts), and truncating the table is exactly
 * what that change exists to stop: it discards every rename, every dismissal,
 * and every first-seen date in the store.
 *
 * Kept for one legitimate caller, `harbor dev relate --rebuild-situations`,
 * where discarding all of that is the explicit request.
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

/**
 * Open situations that span more than one source.
 *
 * The headline number, and the only one worth putting on a status screen: a
 * count of every thread includes the single-source ones, which are just
 * conversations and which Messages already shows better than Harbor would.
 */
export function countSituations(db: DB, principalId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM threads
         WHERE principal_id = ? AND source_count >= 2 AND state = 'open'`,
      )
      .get(principalId) as { n: number }
  ).n;
}

// ---- pending work ----

const CONVERSATIONAL_LIST = CONVERSATIONAL_CONNECTORS.map((id) => `'${id}'`).join(", ");
const NON_EVENT_LIST = NON_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ");

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
               AND i.kind NOT IN (${NON_EVENT_LIST})
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
         AND (stream_id IN (SELECT id FROM streams WHERE connector_id IN (${CONVERSATIONAL_LIST}))
              OR kind IN (${NON_EVENT_LIST}))`,
    )
    .run({ version }).changes;
}

/**
 * Retires recurring notifications from the queue.
 *
 * Same contract as the conversational dismissal above: these are not skipped
 * work, they are work that is complete, so the pass can report itself finished.
 */
export function dismissItems(db: DB, itemIds: readonly string[], version: number): number {
  if (itemIds.length === 0) {
    return 0;
  }

  const mark = db.prepare(
    `UPDATE items SET relationships_version = @version
     WHERE id = @id AND (relationships_version IS NULL OR relationships_version < @version)`,
  );

  let marked = 0;

  const work = db.transaction(() => {
    for (const id of itemIds) {
      marked += mark.run({ id, version }).changes;
    }
  });

  work();

  return marked;
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
