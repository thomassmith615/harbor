/**
 * Assembling situations from edges.
 *
 * A situation is a connected component of the relationship graph: a set of
 * nodes reachable from each other through edges strong enough to trust. That is
 * the whole algorithm, and its simplicity is the point. Anything cleverer would
 * be a clustering heuristic whose mistakes are hard to explain, and the value
 * here is entirely in being explicable.
 *
 * What makes a component worth calling a situation is not size but breadth.
 * Forty messages in one conversation is a conversation, and Messages already
 * shows it. An email, a calendar entry, and a conversation about the same
 * weekend is a situation, and no single application can see it. So salience is
 * driven by how many sources contributed, not by how many nodes there are.
 */
import { clearThreads, saveThread } from "../store/relationships.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "../store/nodes.js";
import type { NoiseIndex } from "./noise.js";

/** Below this, an edge is a hint rather than a reason to group things. */
const MIN_CONFIDENCE = 0.45;

/**
 * A component larger than this is not a situation.
 *
 * Without a ceiling the algorithm cheerfully returns one component containing a
 * third of the store, which is true and useless.
 */
const MAX_NODES = 40;

/**
 * Kinds that can be the centre of a situation.
 *
 * An event is a plan, a task is an obligation, a conversation is an exchange.
 * A message is a notification until something else gives it a reason to matter.
 */
const SPINE_KINDS: readonly string[] = ["event", "task", "conversation"];

interface EdgeRow {
  readonly from_kind: string;
  readonly from_id: string;
  readonly to_kind: string;
  readonly to_id: string;
}

interface NodeFacts {
  readonly key: string;
  readonly ref: NodeRef;
  readonly kind: string;
  readonly title: string | null;
  readonly occurredAt: number;
  readonly streamId: string;
  /** One-way mail. Several of these are one order, not several events. */
  readonly oneWay: boolean;
}

export interface ThreadReport {
  readonly components: number;
  readonly threads: number;
  readonly crossSource: number;
}

function keyOf(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Facts about every node that appears in an edge, in two queries.
 *
 * Loading these one at a time is the difference between a rebuild that takes a
 * second and one that takes a minute, and the rebuild runs at the end of every
 * relate pass.
 */
function loadFacts(db: DB, noise?: NoiseIndex): Map<string, NodeFacts> {
  const facts = new Map<string, NodeFacts>();

  const items = db
    .prepare(
      `SELECT id, kind, title, occurred_at, stream_id FROM items
       WHERE deleted_at IS NULL AND id IN (
         SELECT from_id FROM relationships WHERE from_kind = 'item'
         UNION SELECT to_id FROM relationships WHERE to_kind = 'item'
       )`,
    )
    .all() as {
    id: string;
    kind: string;
    title: string | null;
    occurred_at: number;
    stream_id: string;
  }[];

  for (const row of items) {
    facts.set(keyOf("item", row.id), {
      key: keyOf("item", row.id),
      ref: { kind: "item", id: row.id },
      kind: row.kind,
      title: row.title,
      occurredAt: row.occurred_at,
      streamId: row.stream_id,
      oneWay: noise?.isBroadcast(row.id) ?? false,
    });
  }

  const episodes = db
    .prepare(
      `SELECT id, title, starts_at, stream_id FROM episodes
       WHERE id IN (
         SELECT from_id FROM relationships WHERE from_kind = 'episode'
         UNION SELECT to_id FROM relationships WHERE to_kind = 'episode'
       )`,
    )
    .all() as { id: string; title: string | null; starts_at: number; stream_id: string }[];

  for (const row of episodes) {
    facts.set(keyOf("episode", row.id), {
      key: keyOf("episode", row.id),
      ref: { kind: "episode", id: row.id },
      kind: "conversation",
      title: row.title,
      occurredAt: row.starts_at,
      streamId: row.stream_id,
      oneWay: false,
    });
  }

  return facts;
}

/**
 * Turns handles in a title into the names Harbor already knows.
 *
 * A conversation's title is whatever the source called it, which for iMessage
 * is a phone number or a list of them. Four of the situations on a real run
 * were named things like `+13392047146`, and Harbor had 2,750 identifiers and
 * 1,403 resolved people at the time: it knew perfectly well that was Isabella
 * and printed the digits anyway.
 *
 * Only display. Nothing here is stored, and the underlying handles are
 * untouched, so a rename in Contacts shows up on the next pass without any
 * migration.
 */
/** A phone number or short-code, with or without punctuation. */
export function isHandle(value: string): boolean {
  return /^\+?\d[\d\s()-]{6,}$/.test(value.trim());
}

/**
 * A title that is nothing but handles.
 *
 * Group conversations are titled with a comma-separated list, and testing the
 * whole string against a phone-number pattern never matched one, so a group
 * chat beat a real subject line whenever both were in the same situation.
 */
export function isHandleTitle(title: string): boolean {
  const parts = title.split(",").map((part) => part.trim()).filter((part) => part.length > 0);

  return parts.length > 0 && parts.every(isHandle);
}

function nameHandles(db: DB, title: string): string {
  const lookup = db.prepare(
    `SELECT e.display_name AS name FROM identifiers i
     JOIN entities e ON e.id = i.entity_id
     WHERE i.normalized = ? AND e.merged_into IS NULL
     LIMIT 1`,
  );

  const named = title.split(",").map((part) => {
    const handle = part.trim();

    if (!isHandle(handle)) {
      return handle;
    }

    const row = lookup.get(handle.replace(/[^\d+]/g, "")) as { name: string } | undefined;

    if (row === undefined || row.name.includes("@") || /^\+?\d/.test(row.name)) {
      return handle;
    }

    return row.name;
  });

  // Three names and a count reads; eight names and a count does not.
  if (named.length > 3) {
    return `${named.slice(0, 3).join(", ")} and ${String(named.length - 3)} others`;
  }

  return named.join(", ");
}

export function buildThreads(db: DB, principalId: string, noise?: NoiseIndex): ThreadReport {
  clearThreads(db);

  const edges = db
    .prepare(
      `SELECT from_kind, from_id, to_kind, to_id FROM relationships WHERE confidence >= ?`,
    )
    .all(MIN_CONFIDENCE) as EdgeRow[];

  if (edges.length === 0) {
    return { components: 0, threads: 0, crossSource: 0 };
  }

  // Union-find. The components are needed, not the paths, and this is linear
  // where a graph traversal per node would not be.
  const parent = new Map<string, string>();

  const find = (node: string): string => {
    let root = parent.get(node) ?? node;

    while (root !== (parent.get(root) ?? root)) {
      root = parent.get(root) ?? root;
    }

    let walk = node;

    while (walk !== root) {
      const next = parent.get(walk) ?? walk;
      parent.set(walk, root);
      walk = next;
    }

    return root;
  };

  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);

    if (rootA !== rootB) {
      parent.set(rootA, rootB);
    }
  };

  for (const edge of edges) {
    const from = keyOf(edge.from_kind, edge.from_id);
    const to = keyOf(edge.to_kind, edge.to_id);

    if (!parent.has(from)) {
      parent.set(from, from);
    }
    if (!parent.has(to)) {
      parent.set(to, to);
    }

    union(from, to);
  }

  const components = new Map<string, string[]>();

  for (const node of parent.keys()) {
    const root = find(node);
    const existing = components.get(root) ?? [];
    existing.push(node);
    components.set(root, existing);
  }

  const facts = loadFacts(db, noise);

  let threads = 0;
  let crossSource = 0;

  for (const [, members] of components) {
    if (members.length < 2 || members.length > MAX_NODES) {
      continue;
    }

    const nodes = members
      .map((key) => facts.get(key))
      .filter((node): node is NodeFacts => node !== undefined)
      .sort((a, b) => a.occurredAt - b.occurredAt);

    if (nodes.length < 2) {
      continue;
    }

    const sources = new Set(nodes.map((node) => node.streamId));
    const kinds = new Set(nodes.map((node) => node.kind));

    // One source is a conversation, which the source application already shows
    // better than Harbor would. Two or more is the thing Harbor is for.
    if (sources.size < 2) {
      continue;
    }

    // A shipping lifecycle is one order.
    //
    // "Order 295403 confirmed", "on the way", "out for delivery", "delivered"
    // genuinely share an order number, so `shares_reference` is right to join
    // them, and thirteen of them is still one purchase rather than a situation.
    // Counted as one thing, which usually leaves the component too thin to
    // qualify and always stops it looking like a discovery.
    const broadcastMail = nodes.filter((node) => node.kind === "message" && node.oneWay);

    if (broadcastMail.length > 1 && nodes.length - broadcastMail.length < 2) {
      continue;
    }

    // A situation needs a spine.
    //
    // Something has to have *happened*: a plan, an obligation, or an exchange.
    // Without this, any pile of mail that mentions the same rare word is a
    // situation, and on a real store the top result was twenty Venmo receipts
    // for the same weekly transaction. Two or more sources made it look like a
    // discovery; nothing in it was a plan, a commitment, or a conversation.
    //
    // Mail is the connective tissue of a situation and rarely its centre. It
    // still joins one freely; it just cannot be the whole of one.
    if (!nodes.some((node) => SPINE_KINDS.includes(node.kind))) {
      continue;
    }

    crossSource += 1;

    const first = nodes[0];
    const last = nodes[nodes.length - 1];

    if (first === undefined || last === undefined) {
      continue;
    }

    saveThread(db, {
      principalId,
      title: titleFor(db, nodes),
      kind: [...kinds].sort().join("+"),
      nodes: nodes.map((node) => node.ref),
      startsAt: first.occurredAt,
      endsAt: last.occurredAt,
      sourceCount: sources.size,
      salience: salienceOf(nodes.length, sources.size, kinds.size, last.occurredAt),
    });

    threads += 1;
  }

  return { components: components.size, threads, crossSource };
}

/**
 * A name for the situation, taken rather than generated.
 *
 * An event title is the best available: someone wrote it deliberately to
 * describe a real-world thing. A reminder is second, a mail subject third.
 * Nothing here calls a model, because naming is exactly the sort of task that
 * looks like it wants one and produces a plausible label that outruns the
 * evidence.
 */
function titleFor(db: DB, nodes: readonly NodeFacts[]): string | null {
  for (const wanted of ["event", "task"]) {
    const found = nodes.find((node) => node.kind === wanted && (node.title ?? "").length > 2);

    if (found !== undefined) {
      return found.title;
    }
  }

  // A subject line beats a handle, whatever order the nodes are in: "crabbing"
  // says what the situation is and "+13392047146" makes you go and look.
  const titled = nodes.find(
    (node) => (node.title ?? "").length > 3 && !isHandleTitle(node.title ?? ""),
  );

  if (titled !== undefined) {
    return titled.title;
  }

  const anyTitle = nodes.find((node) => (node.title ?? "").length > 0);

  return anyTitle === undefined ? null : nameHandles(db, anyTitle.title ?? "");
}

/**
 * How much this situation deserves attention.
 *
 * Breadth first, recency second, size barely at all. Something touching three
 * sources is qualitatively different from something touching two; forty nodes
 * is not qualitatively different from twenty.
 */
function salienceOf(nodes: number, sources: number, kinds: number, endsAt: number): number {
  const breadth = (sources - 1) * 0.4 + (kinds - 1) * 0.25;
  const size = Math.min(0.2, Math.log10(nodes + 1) * 0.1);

  const ageDays = Math.max(0, (Date.now() - endsAt) / 86_400_000);
  const recency = Math.max(0, 0.4 - ageDays * 0.008);

  return Number((breadth + size + recency).toFixed(4));
}
