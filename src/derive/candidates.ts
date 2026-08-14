/**
 * Candidate generation.
 *
 * An edge is pairwise, so the unit of work is a node plus everything in the
 * store it might plausibly connect to. That set has to be generated, never
 * inherited from whatever a batch happened to contain.
 *
 * Five generators, and each one exists because a linker needs it:
 *
 *   thread     The nearest item either side in the same source conversation.
 *              Bounded to two, because a conversation is a chain and a chain of
 *              n items needs n-1 edges rather than n squared.
 *
 *   reference  Nodes carrying the same arbitrary identifier, from the index.
 *              This is the generator that reaches across years.
 *
 *   entity     Nodes involving the same person inside a time window.
 *
 *   task pair  Reminders near conversations and mail, because a reminder
 *              usually shares no participants with what it covers.
 *
 *   content    Nodes that share distinctive words, inside a wide time window.
 *              This is the one that was missing, and its absence is why the
 *              flagship behaviour never worked.
 *
 * On the first real run, no generator ever produced a message-and-event pair. A
 * calendar entry typed into Calendar.app has no attendees, so it has no
 * entities, so the entity generator could not see it; it is in no message
 * thread and shares no confirmation code. `arranges`, described in the linker
 * file as the most valuable edge in the set, was therefore unreachable code:
 * not rejecting pairs, never receiving one. Zero of 35,898 edges joined a
 * message to a calendar entry.
 *
 * The content generator is the fix, and it is deliberately not embeddings. A
 * cosine score cannot be checked by the person it is wrong about. Shared rare
 * words can: "both mention Kearneys" is an evidence line, and the rarity is
 * measured against the user's own store rather than against English.
 *
 * Symmetry matters here. If A generates B as a candidate but B would not
 * generate A, then whether an edge exists depends on which node happened to be
 * pending, and an incremental run stops agreeing with a rebuild. Every
 * generator uses a symmetric predicate over a symmetric window. The caps are
 * the one place that is only approximately true, which is why they are set far
 * above where real data sits rather than tuned tight.
 */
import { matchesFor, referencesFor } from "../store/references.js";
import { itemsOf, NON_EVENT_KINDS, nodeKey } from "../store/nodes.js";
import type { DB } from "../kernel/db.js";
import type { GraphNode, NodeRef, NodeResolver } from "../store/nodes.js";
import type { TermIndex } from "./terms.js";
import type { TemplateIndex } from "./templates.js";

export interface Candidate {
  readonly node: GraphNode;
  /** Why this node was considered at all. Shown by `harbor why`. */
  readonly via: readonly string[];
}

export interface CandidateSet {
  readonly subject: GraphNode;
  readonly candidates: readonly Candidate[];
  /** Things deliberately not considered, and why. Only used for explanation. */
  readonly notes: readonly string[];
}

/** How far apart two nodes involving the same person may be and still be considered. */
const ENTITY_WINDOW_MS = 14 * 86_400_000;
/** Reminders and what they cover sit further apart than meetings do. */
const TASK_WINDOW_MS = 21 * 86_400_000;
/** A reply six months later is technically the same thread and is not the same situation. */
const THREAD_WINDOW_MS = 30 * 86_400_000;
/**
 * How far content matching reaches.
 *
 * Wider than the rest, because a trip discussed in June and taken in August is
 * exactly the case this exists for, and the rarity filter rather than the
 * window is what keeps the set small.
 */
const CONTENT_WINDOW_MS = 60 * 86_400_000;

/**
 * A person with more nodes than this inside the window is a mailing list, not a
 * correspondent. Pairing them all is quadratic and produces nothing.
 */
const MAX_ENTITY_FANOUT = 60;
/** How many nodes one distinctive term may contribute. */
const MAX_PER_TERM = 12;
/** Hard ceiling on how much work one node may generate, whatever the generators say. */
const MAX_CANDIDATES = 200;

interface Collector {
  readonly found: Map<string, { node: GraphNode; via: string[] }>;
  readonly notes: string[];
}

function add(collector: Collector, node: GraphNode | null, via: string): void {
  if (node === null) {
    return;
  }

  const key = nodeKey(node.ref);
  const existing = collector.found.get(key);

  if (existing === undefined) {
    collector.found.set(key, { node, via: [via] });
    return;
  }

  if (!existing.via.includes(via)) {
    existing.via.push(via);
  }
}

export interface CandidateContext {
  readonly resolver: NodeResolver;
  readonly terms: TermIndex;
  /** Recurring notifications, which are not endpoints. */
  readonly templates: TemplateIndex;
  /** The entity that is the user. Sharing only this one means nothing. */
  readonly selfEntityId: string | null;
}

/**
 * Turns an item id into the node that speaks for it, then loads it.
 *
 * Every generator that searches item tables ends here. A message from a
 * conversational stream becomes its episode, so a search that finds one text
 * yields the conversation it belongs to.
 */
function lift(
  context: CandidateContext,
  itemId: string,
  streamId: string,
  subject: GraphNode,
): GraphNode | null {
  // A recurring notification is not something that happened, so it is neither a
  // subject nor a candidate. Filtered on the way in rather than judged by a
  // linker, because every linker would have to know about it otherwise.
  if (context.templates.has(itemId)) {
    return null;
  }

  const ref = context.resolver.canonicalNode(itemId, streamId);

  if (ref === null || nodeKey(ref) === nodeKey(subject.ref)) {
    return null;
  }

  const node = context.resolver.node(ref);

  if (node !== null && NON_EVENT_KINDS.includes(node.kind)) {
    return null;
  }

  return node;
}

// ---- generators ----

function threadCandidates(
  db: DB,
  subject: GraphNode,
  context: CandidateContext,
  collector: Collector,
): void {
  // An episode already is the conversation, so its neighbours in the source
  // thread are other episodes of the same chat, and those are separate
  // occasions rather than one situation.
  if (subject.ref.kind !== "item" || subject.threadId === null) {
    return;
  }

  // Nearest either side, not every member. Two items adjacent in a conversation
  // are the chain; everything else in the thread reaches them through it.
  const before = db.prepare(
    `SELECT id, stream_id FROM items
     WHERE thread_id = @thread AND deleted_at IS NULL AND id <> @id
       AND occurred_at <= @at AND occurred_at BETWEEN @floor AND @ceiling
     ORDER BY occurred_at DESC LIMIT 1`,
  );

  const after = db.prepare(
    `SELECT id, stream_id FROM items
     WHERE thread_id = @thread AND deleted_at IS NULL AND id <> @id
       AND occurred_at > @at AND occurred_at BETWEEN @floor AND @ceiling
     ORDER BY occurred_at ASC LIMIT 1`,
  );

  const bind = {
    thread: subject.threadId,
    id: subject.ref.id,
    at: subject.occurredAt,
    floor: subject.occurredAt - THREAD_WINDOW_MS,
    ceiling: subject.occurredAt + THREAD_WINDOW_MS,
  };

  for (const statement of [before, after]) {
    const row = statement.get(bind) as { id: string; stream_id: string } | undefined;

    if (row !== undefined) {
      add(collector, lift(context, row.id, row.stream_id, subject), "thread_adjacent");
    }
  }
}

function referenceCandidates(
  db: DB,
  subject: GraphNode,
  context: CandidateContext,
  collector: Collector,
): void {
  // An episode has no references of its own; it inherits whatever its messages
  // carry, which is how a confirmation code someone texted you reaches the
  // booking email that also has it.
  const itemIds = itemsOf(db, subject.ref);

  for (const itemId of itemIds) {
    const references = referencesFor(db, itemId);

    if (references.length === 0) {
      continue;
    }

    for (const match of matchesFor(db, itemId, references)) {
      if (match.excluded) {
        collector.notes.push(
          `${match.value} appears in ${String(match.totalHolders)} items, so it is a template rather than an identifier`,
        );
        continue;
      }

      for (const id of match.itemIds) {
        const row = db.prepare(`SELECT stream_id FROM items WHERE id = ?`).get(id) as
          | { stream_id: string }
          | undefined;

        if (row === undefined) {
          continue;
        }

        add(collector, lift(context, id, row.stream_id, subject), `reference:${match.value}`);
      }
    }
  }
}

function entityCandidates(
  db: DB,
  subject: GraphNode,
  context: CandidateContext,
  collector: Collector,
): void {
  const itemIds = itemsOf(db, subject.ref);

  if (itemIds.length === 0) {
    return;
  }

  const placeholders = itemIds.map(() => "?").join(", ");

  const entities = db
    .prepare(
      `SELECT DISTINCT entity_id AS id FROM item_entities
       WHERE item_id IN (${placeholders}) AND entity_id <> ?`,
    )
    .all(...itemIds, context.selfEntityId ?? "") as { id: string }[];

  const from = subject.occurredAt - ENTITY_WINDOW_MS;
  const to = (subject.endsAt ?? subject.occurredAt) + ENTITY_WINDOW_MS;

  const counter = db.prepare(
    `SELECT COUNT(*) AS n FROM item_entities ie
     JOIN items i ON i.id = ie.item_id
     WHERE ie.entity_id = @entity AND i.deleted_at IS NULL
       AND i.occurred_at BETWEEN @from AND @to`,
  );

  const finder = db.prepare(
    `SELECT DISTINCT i.id, i.stream_id, i.occurred_at FROM item_entities ie
     JOIN items i ON i.id = ie.item_id
     WHERE ie.entity_id = @entity AND i.deleted_at IS NULL
       AND i.occurred_at BETWEEN @from AND @to
     ORDER BY ABS(i.occurred_at - @at) ASC
     LIMIT @limit`,
  );

  for (const entity of entities) {
    const count = (counter.get({ entity: entity.id, from, to }) as { n: number }).n;

    if (count > MAX_ENTITY_FANOUT * 4) {
      collector.notes.push(
        `entity ${entity.id} has ${String(count)} items in the window, treated as bulk and skipped`,
      );
      continue;
    }

    const rows = finder.all({
      entity: entity.id,
      from,
      to,
      at: subject.occurredAt,
      limit: MAX_ENTITY_FANOUT,
    }) as { id: string; stream_id: string }[];

    for (const row of rows) {
      add(collector, lift(context, row.id, row.stream_id, subject), `person:${entity.id}`);
    }
  }
}

/**
 * Reminders near everything else.
 *
 * A reminder typically has no participants at all, so the entity generator
 * never finds what it covers. Tasks are few, so a plain time window is
 * affordable here and nowhere else.
 */
function taskCandidates(
  db: DB,
  subject: GraphNode,
  context: CandidateContext,
  collector: Collector,
): void {
  const from = subject.occurredAt - TASK_WINDOW_MS;
  const to = subject.occurredAt + TASK_WINDOW_MS;

  if (subject.kind === "task") {
    const rows = db
      .prepare(
        `SELECT id, stream_id FROM items
         WHERE kind IN ('message', 'event') AND deleted_at IS NULL AND id <> @id
           AND occurred_at BETWEEN @from AND @to
         ORDER BY ABS(occurred_at - @at) ASC LIMIT 120`,
      )
      .all({ id: subject.ref.id, from, to, at: subject.occurredAt }) as {
      id: string;
      stream_id: string;
    }[];

    for (const row of rows) {
      add(collector, lift(context, row.id, row.stream_id, subject), "task_window");
    }

    return;
  }

  if (subject.kind !== "message" && subject.kind !== "conversation") {
    return;
  }

  // The other direction, so a conversation that arrives after the reminder
  // still finds it. Much smaller budget: tasks are rare, messages are not.
  const rows = db
    .prepare(
      `SELECT id, stream_id FROM items
       WHERE kind = 'task' AND deleted_at IS NULL
         AND occurred_at BETWEEN @from AND @to
       ORDER BY ABS(occurred_at - @at) ASC LIMIT 20`,
    )
    .all({ from, to, at: subject.occurredAt }) as { id: string; stream_id: string }[];

  for (const row of rows) {
    add(collector, lift(context, row.id, row.stream_id, subject), "task_window");
  }
}

/**
 * Nodes that share a distinctive word.
 *
 * The generator the product thesis depends on. It searches two indexes rather
 * than one, and that is deliberate: a message inside a conversation is found
 * through `items_fts` and lifted to its episode, while an episode is found
 * directly through `episodes_fts`. Searching only the first would mean an event
 * could never find a conversation, so an event arriving after the conversation
 * had already been processed would never be connected to it, and the graph
 * would depend on ingestion order.
 */
function contentCandidates(
  db: DB,
  subject: GraphNode,
  context: CandidateContext,
  collector: Collector,
): void {
  const terms = context.terms.distinctive(subject.text);

  if (terms.length === 0) {
    collector.notes.push("no word in this is rare enough in your store to match on");
    return;
  }

  const from = subject.occurredAt - CONTENT_WINDOW_MS;
  const to = (subject.endsAt ?? subject.occurredAt) + CONTENT_WINDOW_MS;

  const inItems = db.prepare(
    `SELECT i.id, i.stream_id FROM items_fts f
     JOIN items i ON i.id = f.item_id
     WHERE items_fts MATCH @match AND i.deleted_at IS NULL AND i.id <> @id
       AND i.occurred_at BETWEEN @from AND @to
     ORDER BY ABS(i.occurred_at - @at) ASC
     LIMIT @limit`,
  );

  const inEpisodes = db.prepare(
    `SELECT e.id FROM episodes_fts f
     JOIN episodes e ON e.id = f.episode_id
     WHERE episodes_fts MATCH @match AND e.id <> @id
       AND e.starts_at BETWEEN @from AND @to
     ORDER BY ABS(e.starts_at - @at) ASC
     LIMIT @limit`,
  );

  for (const term of terms) {
    const bind = {
      match: `"${term}"`,
      id: subject.ref.id,
      from,
      to,
      at: subject.occurredAt,
      limit: MAX_PER_TERM,
    };

    for (const row of inItems.all(bind) as { id: string; stream_id: string }[]) {
      add(collector, lift(context, row.id, row.stream_id, subject), `word:${term}`);
    }

    for (const row of inEpisodes.all(bind) as { id: string }[]) {
      const node = context.resolver.node({ kind: "episode", id: row.id });

      if (node !== null && nodeKey(node.ref) !== nodeKey(subject.ref)) {
        add(collector, node, `word:${term}`);
      }
    }
  }
}

export function candidatesFor(
  db: DB,
  subject: GraphNode,
  context: CandidateContext,
): CandidateSet {
  const collector: Collector = { found: new Map(), notes: [] };

  threadCandidates(db, subject, context, collector);
  referenceCandidates(db, subject, context, collector);
  entityCandidates(db, subject, context, collector);
  taskCandidates(db, subject, context, collector);
  contentCandidates(db, subject, context, collector);

  const ordered = [...collector.found.values()]
    .sort(
      (a, b) =>
        Math.abs(a.node.occurredAt - subject.occurredAt) -
        Math.abs(b.node.occurredAt - subject.occurredAt),
    )
    .slice(0, MAX_CANDIDATES);

  if (collector.found.size > MAX_CANDIDATES) {
    collector.notes.push(
      `${String(collector.found.size)} candidates generated, capped to the ${String(MAX_CANDIDATES)} nearest in time`,
    );
  }

  return {
    subject,
    candidates: ordered.map((entry) => ({ node: entry.node, via: entry.via })),
    notes: collector.notes,
  };
}

export type { GraphNode, NodeRef };
