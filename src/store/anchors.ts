/**
 * Storing anchors, and finding nodes by them.
 *
 * The read side is the interesting half. Gathering evidence for a story asks
 * one question over and over: which nodes claim this place, this identifier,
 * this person, inside this window? That is an index lookup here and it was a
 * full-text search over the whole store before, per term, per subject.
 */
import { nodeKey } from "./nodes.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "./nodes.js";
import type { Anchor, AnchorKind } from "../derive/anchors.js";

interface AnchorRow {
  readonly node_kind: string;
  readonly node_id: string;
  readonly kind: string;
  readonly value: string;
  readonly display: string;
  readonly starts_at: number | null;
  readonly ends_at: number | null;
  readonly confidence: number;
}

function toAnchor(row: AnchorRow): Anchor {
  return {
    kind: row.kind as AnchorKind,
    value: row.value,
    display: row.display,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    confidence: row.confidence,
  };
}

/**
 * Replaces every anchor on a node.
 *
 * Written even when empty, for the reason the reference index learned the hard
 * way: a node whose anchors are deleted by an improved extractor keeps its old
 * ones forever if the empty case is skipped.
 */
export function replaceAnchors(db: DB, ref: NodeRef, anchors: readonly Anchor[]): void {
  db.prepare(`DELETE FROM node_anchors WHERE node_kind = ? AND node_id = ?`).run(ref.kind, ref.id);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO node_anchors
       (node_kind, node_id, kind, value, display, starts_at, ends_at, confidence)
     VALUES (@nodeKind, @nodeId, @kind, @value, @display, @startsAt, @endsAt, @confidence)`,
  );

  for (const anchor of anchors) {
    insert.run({
      nodeKind: ref.kind,
      nodeId: ref.id,
      kind: anchor.kind,
      value: anchor.value,
      display: anchor.display,
      startsAt: anchor.startsAt,
      endsAt: anchor.endsAt,
      confidence: anchor.confidence,
    });
  }
}

export function anchorsFor(db: DB, ref: NodeRef): readonly Anchor[] {
  const rows = db
    .prepare(`SELECT * FROM node_anchors WHERE node_kind = ? AND node_id = ?`)
    .all(ref.kind, ref.id) as AnchorRow[];

  return rows.map(toAnchor);
}

/** Anchors for many nodes at once, keyed by `nodeKey`. */
export function anchorsForAll(
  db: DB,
  refs: readonly NodeRef[],
): ReadonlyMap<string, readonly Anchor[]> {
  const byNode = new Map<string, Anchor[]>();

  if (refs.length === 0) {
    return byNode;
  }

  for (const ref of refs) {
    byNode.set(nodeKey(ref), []);
  }

  // Chunked, because SQLite has a bound-parameter ceiling and a story's
  // candidate pool can be large on a real store.
  const ids = refs.map((ref) => ref.id);

  for (let offset = 0; offset < ids.length; offset += 400) {
    const slice = ids.slice(offset, offset + 400);
    const placeholders = slice.map(() => "?").join(", ");

    const rows = db
      .prepare(`SELECT * FROM node_anchors WHERE node_id IN (${placeholders})`)
      .all(...slice) as AnchorRow[];

    for (const row of rows) {
      const key = `${row.node_kind}:${row.node_id}`;
      const bucket = byNode.get(key);

      if (bucket !== undefined) {
        bucket.push(toAnchor(row));
      }
    }
  }

  return byNode;
}

export interface AnchorHolder {
  readonly ref: NodeRef;
  readonly display: string;
}

/** Every node claiming one anchor value. The gather phase's main query. */
export function holdersOf(
  db: DB,
  kind: AnchorKind,
  value: string,
  limit = 400,
): readonly AnchorHolder[] {
  const rows = db
    .prepare(
      `SELECT node_kind, node_id, display FROM node_anchors
       WHERE kind = ? AND value = ? LIMIT ?`,
    )
    .all(kind, value, limit) as { node_kind: string; node_id: string; display: string }[];

  return rows.map((row) => ({
    ref: { kind: row.node_kind as NodeRef["kind"], id: row.node_id },
    display: row.display,
  }));
}

/**
 * How many nodes claim an anchor value.
 *
 * Used to discount an anchor that is everywhere. A place you live is on
 * hundreds of things and says nothing about which of them belong together;
 * a place you visited once is decisive.
 */
export function anchorFrequency(db: DB, kind: AnchorKind, value: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM node_anchors WHERE kind = ? AND value = ?`)
    .get(kind, value) as { n: number };

  return row.n;
}

export function countAnchors(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM node_anchors`).get() as { n: number }).n;
}

export function clearAnchors(db: DB): number {
  const before = countAnchors(db);

  db.prepare(`DELETE FROM node_anchors`).run();
  db.prepare(`UPDATE items SET anchors_version = NULL`).run();
  db.prepare(`UPDATE episodes SET anchors_version = NULL`).run();

  return before;
}

export interface PendingNode {
  readonly ref: NodeRef;
}

/**
 * Nodes whose anchors are missing or stale.
 *
 * Episodes first, for the same reason the relate pass does it: they are far
 * fewer and they are the side that reaches into conversations, so an
 * interrupted run has still done the part that matters.
 */
export function pendingAnchorNodes(db: DB, version: number, limit: number): readonly NodeRef[] {
  const episodes = db
    .prepare(
      `SELECT id FROM episodes
       WHERE anchors_version IS NULL OR anchors_version < @version
       ORDER BY ends_at DESC LIMIT @limit`,
    )
    .all({ version, limit }) as { id: string }[];

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
         AND (i.anchors_version IS NULL OR i.anchors_version < @version)
       ORDER BY i.occurred_at DESC LIMIT @limit`,
    )
    .all({ version, limit: limit - refs.length }) as { id: string }[];

  for (const row of items) {
    refs.push({ kind: "item", id: row.id });
  }

  return refs;
}

export function countPendingAnchors(db: DB, version: number): number {
  const episodes = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM episodes
         WHERE anchors_version IS NULL OR anchors_version < ?`,
      )
      .get(version) as { n: number }
  ).n;

  const items = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i
         JOIN streams s ON s.id = i.stream_id
         WHERE i.deleted_at IS NULL
           AND s.connector_id NOT IN ('imessage')
           AND (i.anchors_version IS NULL OR i.anchors_version < ?)`,
      )
      .get(version) as { n: number }
  ).n;

  return episodes + items;
}

export function markAnchored(db: DB, refs: readonly NodeRef[], version: number): void {
  const item = db.prepare(`UPDATE items SET anchors_version = ? WHERE id = ?`);
  const episode = db.prepare(`UPDATE episodes SET anchors_version = ? WHERE id = ?`);

  for (const ref of refs) {
    if (ref.kind === "item") {
      item.run(version, ref.id);
    } else {
      episode.run(version, ref.id);
    }
  }
}
