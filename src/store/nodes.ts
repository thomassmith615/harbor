/**
 * Nodes: the things the graph connects.
 *
 * A node is an item or an episode, and the distinction between the two is the
 * only thing in this file that matters.
 *
 * An email is a complete thought. It has a subject, a sender, a body, and one
 * moment, and connecting it to a calendar entry is a sensible thing to try. A
 * text message is not a complete thought. "yeah saturday works" is an item, and
 * an edge drawn from it says nothing, because the words that would justify the
 * edge are in the six messages around it.
 *
 * So the graph operates on whichever of the two is the unit of meaning for the
 * source: items everywhere, except conversational streams, where the episode
 * stands in for the messages inside it. `canonicalNode` is where that decision
 * is made, and it is made in exactly one place so that candidate generation,
 * linking, threading, and explanation cannot disagree about it.
 *
 * The practical effect on a real store: 218,000 iMessages stop being graph
 * subjects and roughly 9,000 episodes take their place. That is not only
 * cheaper, it is the difference between a graph of fragments and a graph of
 * conversations.
 */
import type { DB } from "../kernel/db.js";

export type NodeKind = "item" | "episode";

export interface NodeRef {
  readonly kind: NodeKind;
  readonly id: string;
}

/**
 * Everything a linker is allowed to see about a node.
 *
 * Deliberately a flat shape shared by both kinds rather than a union. A linker
 * that has to ask "which sort of thing am I looking at" in order to read a
 * title is a linker that will be written twice.
 */
export interface GraphNode {
  readonly ref: NodeRef;
  /**
   * What sort of thing this is, for linkers that care: an item's kind
   * (`message`, `event`, `task`) or `conversation` for an episode.
   */
  readonly kind: string;
  readonly title: string | null;
  /** Title and body, or the transcript. Bounded; linkers match on the opening. */
  readonly text: string;
  readonly occurredAt: number;
  readonly endsAt: number | null;
  readonly streamId: string;
  /** The source's own conversation id, where there is one. */
  readonly threadId: string | null;
  readonly direction: string | null;
}

export function nodeKey(ref: NodeRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function sameNode(a: NodeRef, b: NodeRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Reads an id as a node reference.
 *
 * Item ids are bare hex, episode ids carry an `ep_` prefix, and a caller may
 * also pass the explicit `episode:<id>` form. Accepting all three means the
 * model, the CLI, and the API can hand around one identifier without any of
 * them having to know which table it came from.
 */
export function parseNodeRef(id: string): NodeRef {
  if (id.startsWith("episode:")) {
    return { kind: "episode", id: id.slice("episode:".length) };
  }

  if (id.startsWith("item:")) {
    return { kind: "item", id: id.slice("item:".length) };
  }

  return id.startsWith("ep_") ? { kind: "episode", id } : { kind: "item", id };
}

/** How much of a node's text is available to a linker. */
const TEXT_LIMIT = 4_000;

const ITEM_COLUMNS = `i.id, i.kind, i.title, SUBSTR(i.body, 1, ${String(TEXT_LIMIT)}) AS body,
  i.thread_id, i.occurred_at, i.ends_at, i.stream_id, i.direction`;

interface ItemNodeRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly thread_id: string | null;
  readonly occurred_at: number;
  readonly ends_at: number | null;
  readonly stream_id: string;
  readonly direction: string | null;
}

interface EpisodeNodeRow {
  readonly id: string;
  readonly title: string | null;
  readonly transcript: string;
  readonly thread_id: string;
  readonly starts_at: number;
  readonly ends_at: number;
  readonly stream_id: string;
}

function fromItem(row: ItemNodeRow): GraphNode {
  return {
    ref: { kind: "item", id: row.id },
    kind: row.kind,
    title: row.title,
    text: `${row.title ?? ""}\n${row.body ?? ""}`.slice(0, TEXT_LIMIT),
    occurredAt: row.occurred_at,
    endsAt: row.ends_at,
    streamId: row.stream_id,
    threadId: row.thread_id,
    direction: row.direction,
  };
}

function fromEpisode(row: EpisodeNodeRow): GraphNode {
  return {
    ref: { kind: "episode", id: row.id },
    kind: "conversation",
    title: row.title,
    text: `${row.title ?? ""}\n${row.transcript}`.slice(0, TEXT_LIMIT),
    occurredAt: row.starts_at,
    endsAt: row.ends_at,
    streamId: row.stream_id,
    threadId: row.thread_id,
    direction: null,
  };
}

export function loadNode(db: DB, ref: NodeRef): GraphNode | null {
  if (ref.kind === "episode") {
    const row = db
      .prepare(
        `SELECT id, title, SUBSTR(transcript, 1, ${String(TEXT_LIMIT)}) AS transcript,
                thread_id, starts_at, ends_at, stream_id
         FROM episodes WHERE id = ?`,
      )
      .get(ref.id) as EpisodeNodeRow | undefined;

    return row === undefined ? null : fromEpisode(row);
  }

  const row = db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM items i WHERE i.id = ? AND i.deleted_at IS NULL`)
    .get(ref.id) as ItemNodeRow | undefined;

  return row === undefined ? null : fromItem(row);
}

/**
 * Which connectors produce conversations rather than documents.
 *
 * A property of the source, not of the item kind. An email is a `message` and
 * is not conversational in this sense: it carries its own subject and context
 * and stands alone. A future chat source joins by being named here, and nothing
 * else in the graph changes.
 */
export const CONVERSATIONAL_CONNECTORS: readonly string[] = ["imessage"];

/**
 * Item kinds that are reference data rather than things that happened.
 *
 * A contact card is a fact about who someone is. It has an `occurred_at`
 * because every item does, but that timestamp is when the card was written,
 * which is not when anything happened. Left in the graph it produced situations
 * like "Myles Menowitz: a contact card from March, and a payment three days
 * later, across two sources", which is technically two sources and is not a
 * situation.
 *
 * Contacts still do the most important job in the store: they turn addresses
 * and phone numbers into people, which is what every other edge depends on.
 * They are simply not endpoints.
 */
export const NON_EVENT_KINDS: readonly string[] = ["contact"];

function conversationalStreams(db: DB): ReadonlySet<string> {
  const placeholders = CONVERSATIONAL_CONNECTORS.map(() => "?").join(", ");

  const rows = db
    .prepare(`SELECT id FROM streams WHERE connector_id IN (${placeholders})`)
    .all(...CONVERSATIONAL_CONNECTORS) as { id: string }[];

  return new Set(rows.map((row) => row.id));
}

/**
 * A cache of the decisions in this file, held for the life of one pass.
 *
 * Lifting an item to its episode is a lookup that happens once per candidate,
 * and candidates repeat heavily across subjects. Without this it is the hot
 * query in the pass; with it the stream set is read once and the episode
 * lookups are memoised.
 */
export class NodeResolver {
  private readonly conversational: ReadonlySet<string>;
  private readonly lifted = new Map<string, NodeRef | null>();
  private readonly nodes = new Map<string, GraphNode | null>();

  constructor(private readonly db: DB) {
    this.conversational = conversationalStreams(db);
  }

  isConversational(streamId: string): boolean {
    return this.conversational.has(streamId);
  }

  /**
   * The node that stands for an item.
   *
   * Itself, unless it came from a conversational stream, in which case its
   * episode. An item in a conversational stream that has not been segmented yet
   * has no node at all and is deliberately not linked: half a conversation is
   * worse evidence than none, and `harbor update` runs segmentation first.
   */
  canonicalNode(itemId: string, streamId: string): NodeRef | null {
    if (!this.conversational.has(streamId)) {
      return { kind: "item", id: itemId };
    }

    const cached = this.lifted.get(itemId);

    if (cached !== undefined) {
      return cached;
    }

    const row = this.db
      .prepare(`SELECT episode_id AS id FROM episode_items WHERE item_id = ? LIMIT 1`)
      .get(itemId) as { id: string } | undefined;

    const ref: NodeRef | null = row === undefined ? null : { kind: "episode", id: row.id };
    this.lifted.set(itemId, ref);

    return ref;
  }

  node(ref: NodeRef): GraphNode | null {
    const key = nodeKey(ref);
    const cached = this.nodes.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const loaded = loadNode(this.db, ref);
    this.nodes.set(key, loaded);

    return loaded;
  }
}

/**
 * The items a node speaks for.
 *
 * An item speaks for itself; an episode speaks for its messages. Used wherever
 * a node has to be turned back into things policy can be evaluated against,
 * because the gate admits items and knows nothing about episodes.
 */
export function itemsOf(db: DB, ref: NodeRef): readonly string[] {
  if (ref.kind === "item") {
    return [ref.id];
  }

  const rows = db
    .prepare(
      `SELECT ei.item_id AS id FROM episode_items ei
       JOIN items i ON i.id = ei.item_id
       WHERE ei.episode_id = ? AND i.deleted_at IS NULL
       ORDER BY i.occurred_at`,
    )
    .all(ref.id) as { id: string }[];

  return rows.map((row) => row.id);
}

/**
 * What a surface needs to show a node in a list.
 *
 * Deliberately smaller than `GraphNode`: the CLI, the API, and the tool layer
 * all print roughly the same four fields, and each of them had grown its own
 * way of getting them from an item row. An episode has no author, and saying so
 * once here is better than three `if (kind === "episode")` branches.
 */
export interface NodeSummary {
  readonly ref: NodeRef;
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly author: string | null;
  readonly occurredAt: number;
  /** Members, for an episode. One entry, for an item. */
  readonly itemIds: readonly string[];
}

export function summarize(db: DB, ref: NodeRef): NodeSummary | null {
  const node = loadNode(db, ref);

  if (node === null) {
    return null;
  }

  const author =
    ref.kind === "item"
      ? ((db.prepare(`SELECT author FROM items WHERE id = ?`).get(ref.id) as
          | { author: string | null }
          | undefined)?.author ?? null)
      : null;

  return {
    ref,
    id: ref.kind === "episode" ? ref.id : node.ref.id,
    kind: node.kind,
    title: node.title,
    author,
    occurredAt: node.occurredAt,
    itemIds: itemsOf(db, ref),
  };
}

/**
 * Everyone involved in a node, the user excluded.
 *
 * For an episode that is the union over its messages, which is what makes
 * "same person on both" mean anything when one side is a conversation.
 */
export function entitiesOfNode(db: DB, ref: NodeRef): ReadonlySet<string> {
  const rows =
    ref.kind === "item"
      ? (db
          .prepare(`SELECT DISTINCT entity_id AS id FROM item_entities WHERE item_id = ?`)
          .all(ref.id) as { id: string }[])
      : (db
          .prepare(
            `SELECT DISTINCT ie.entity_id AS id FROM episode_items ei
             JOIN item_entities ie ON ie.item_id = ei.item_id
             WHERE ei.episode_id = ?`,
          )
          .all(ref.id) as { id: string }[]);

  return new Set(rows.map((row) => row.id));
}
