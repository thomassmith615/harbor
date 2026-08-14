/**
 * The reference index.
 *
 * A reference is an arbitrary identifier that appears in an item's text: a
 * flight number, a confirmation code, a tracking number, a meeting URL. Two
 * items do not share one by coincidence, which makes it the strongest
 * deterministic evidence Harbor has that two items are about the same thing.
 *
 * This table exists because of what it makes possible rather than what it
 * stores. Before it, finding items that share a reference meant scanning the
 * text of every item in the current batch, which is why the relationship pass
 * could only ever connect items that happened to be processed together. With
 * the reference extracted once at derivation time and indexed by value, the
 * same question is a lookup, and a message that arrived this morning can be
 * connected to a booking from March.
 *
 * Extraction is versioned independently of the linkers. Improving a pattern
 * costs a re-scan of stored text; improving a linker does not.
 */
import type { DB } from "../kernel/db.js";

export interface ItemReference {
  readonly itemId: string;
  /** What sort of identifier this is: flight, confirmation, tracking, meeting. */
  readonly kind: string;
  /** Normalized: uppercase, no internal whitespace. */
  readonly value: string;
}

/**
 * How many items may share one reference before it stops being an identifier.
 *
 * Bulk mail reuses the same string across every recipient, and a "reference"
 * that appears in forty items is a template, not a fact about two of them.
 * Applied at query time rather than at write time so the count stays truthful
 * as the store grows.
 */
export const MAX_REFERENCE_FANOUT = 8;

export function replaceReferences(
  db: DB,
  itemId: string,
  references: readonly ItemReference[],
): number {
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM item_references WHERE item_id = ?`).run(itemId);

    const insert = db.prepare(
      `INSERT INTO item_references (item_id, kind, value) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );

    for (const reference of references) {
      insert.run(itemId, reference.kind, reference.value);
    }
  });

  write();

  return references.length;
}

export function referencesFor(db: DB, itemId: string): readonly ItemReference[] {
  const rows = db
    .prepare(`SELECT item_id, kind, value FROM item_references WHERE item_id = ?`)
    .all(itemId) as { item_id: string; kind: string; value: string }[];

  return rows.map((row) => ({ itemId: row.item_id, kind: row.kind, value: row.value }));
}

/**
 * Other items carrying the same reference.
 *
 * The fan-out ceiling is enforced here, in the read path, and it is the reason
 * this returns the count alongside the ids: a caller that wants to explain why
 * a candidate was not considered needs to know it was excluded for being a
 * template rather than for not existing.
 */
export interface ReferenceMatch {
  readonly kind: string;
  readonly value: string;
  readonly itemIds: readonly string[];
  readonly totalHolders: number;
  readonly excluded: boolean;
}

export function matchesFor(
  db: DB,
  itemId: string,
  references: readonly ItemReference[],
): readonly ReferenceMatch[] {
  const counter = db.prepare(
    `SELECT COUNT(*) AS n FROM item_references r
     JOIN items i ON i.id = r.item_id
     WHERE r.kind = ? AND r.value = ? AND i.deleted_at IS NULL`,
  );

  const finder = db.prepare(
    `SELECT r.item_id AS id FROM item_references r
     JOIN items i ON i.id = r.item_id
     WHERE r.kind = ? AND r.value = ? AND r.item_id <> ? AND i.deleted_at IS NULL`,
  );

  const matches: ReferenceMatch[] = [];

  for (const reference of references) {
    const total = (counter.get(reference.kind, reference.value) as { n: number }).n;

    if (total > MAX_REFERENCE_FANOUT) {
      matches.push({
        kind: reference.kind,
        value: reference.value,
        itemIds: [],
        totalHolders: total,
        excluded: true,
      });
      continue;
    }

    const rows = finder.all(reference.kind, reference.value, itemId) as { id: string }[];

    matches.push({
      kind: reference.kind,
      value: reference.value,
      itemIds: rows.map((row) => row.id),
      totalHolders: total,
      excluded: false,
    });
  }

  return matches;
}

export function countPendingReferences(db: DB, version: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items
         WHERE deleted_at IS NULL
           AND (references_version IS NULL OR references_version < ?)`,
      )
      .get(version) as { n: number }
  ).n;
}

export interface ReferenceCandidate {
  readonly id: string;
  readonly title: string | null;
  readonly body: string | null;
}

export function pendingReferenceItems(
  db: DB,
  version: number,
  limit: number,
): readonly ReferenceCandidate[] {
  return db
    .prepare(
      `SELECT id, title, body FROM items
       WHERE deleted_at IS NULL
         AND (references_version IS NULL OR references_version < @version)
       ORDER BY occurred_at DESC
       LIMIT @limit`,
    )
    .all({ version, limit }) as ReferenceCandidate[];
}

export function markReferenced(db: DB, itemIds: readonly string[], version: number): void {
  const mark = db.prepare(`UPDATE items SET references_version = ? WHERE id = ?`);

  const work = db.transaction(() => {
    for (const id of itemIds) {
      mark.run(version, id);
    }
  });

  work();
}

export function countReferences(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM item_references`).get() as { n: number }).n;
}
