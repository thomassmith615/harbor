/**
 * Entity storage.
 *
 * Entities are derived, with one exception. `pinned` marks an entity a human
 * has corrected, and nothing automated overwrites a pinned display name or
 * un-merges a manual merge. That single flag is what makes it safe for
 * resolution to be aggressive about labels and conservative about identity:
 * when it gets one wrong, the correction sticks through every future re-run.
 */
import { createHash } from "node:crypto";
import { fold, looksLikePhone, normalizePhone } from "../derive/nicknames.js";
import type { DB } from "../kernel/db.js";

export type EntityKind = "person" | "org" | "self";
export type IdentifierKind = "email" | "phone" | "name" | "handle";
export type EntityRole = "author" | "participant" | "mentioned";

export interface Entity {
  readonly id: string;
  readonly kind: EntityKind;
  readonly displayName: string;
  readonly pinned: boolean;
  readonly mergedInto: string | null;
}

export interface Identifier {
  readonly id: string;
  readonly entityId: string;
  readonly kind: IdentifierKind;
  readonly value: string;
  readonly normalized: string;
  readonly confidence: number;
  readonly occurrences: number;
  readonly firstSeen: number | null;
  readonly lastSeen: number | null;
}

interface EntityRow {
  readonly id: string;
  readonly kind: EntityKind;
  readonly display_name: string;
  readonly pinned: number;
  readonly merged_into: string | null;
}

function hydrate(row: EntityRow): Entity {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    pinned: row.pinned === 1,
    mergedInto: row.merged_into,
  };
}

export function identifierId(kind: IdentifierKind, normalized: string): string {
  return `${kind}:${normalized}`;
}

function entityId(seed: string): string {
  return `e_${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

/** Follows a merge chain to the surviving entity. */
export function resolveEntity(db: DB, id: string): Entity | null {
  let current = id;

  for (let hops = 0; hops < 8; hops += 1) {
    const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(current) as
      | EntityRow
      | undefined;

    if (row === undefined) {
      return null;
    }

    if (row.merged_into === null) {
      return hydrate(row);
    }

    current = row.merged_into;
  }

  return null;
}

export function findByIdentifier(
  db: DB,
  kind: IdentifierKind,
  normalized: string,
): Entity | null {
  const row = db
    .prepare(`SELECT entity_id FROM identifiers WHERE id = ?`)
    .get(identifierId(kind, normalized)) as { entity_id: string } | undefined;

  return row === undefined ? null : resolveEntity(db, row.entity_id);
}

export function createEntity(
  db: DB,
  kind: EntityKind,
  displayName: string,
  seed: string,
): Entity {
  const id = entityId(seed);
  const now = Date.now();

  db.prepare(
    `INSERT INTO entities (id, kind, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(id, kind, displayName, now, now);

  const entity = resolveEntity(db, id);
  if (entity === null) {
    throw new Error(`Entity ${id} vanished immediately after being written`);
  }
  return entity;
}

/** Renames only when a human has not already decided. */
export function setDisplayName(db: DB, id: string, displayName: string): void {
  db.prepare(
    `UPDATE entities SET display_name = ?, updated_at = ?
     WHERE id = ? AND pinned = 0`,
  ).run(displayName, Date.now(), id);
}

export function pinEntity(db: DB, id: string, displayName?: string): void {
  if (displayName === undefined) {
    db.prepare(`UPDATE entities SET pinned = 1, updated_at = ? WHERE id = ?`).run(Date.now(), id);
    return;
  }

  db.prepare(
    `UPDATE entities SET pinned = 1, display_name = ?, updated_at = ? WHERE id = ?`,
  ).run(displayName, Date.now(), id);
}

export function upsertIdentifier(
  db: DB,
  input: {
    readonly entityId: string;
    readonly kind: IdentifierKind;
    readonly value: string;
    readonly normalized: string;
    readonly confidence: number;
    readonly seenAt: number;
  },
): void {
  const id = identifierId(input.kind, input.normalized);

  db.prepare(
    `INSERT INTO identifiers
       (id, entity_id, kind, value, normalized, confidence, occurrences, first_seen, last_seen)
     VALUES (@id, @entityId, @kind, @value, @normalized, @confidence, 1, @seenAt, @seenAt)
     ON CONFLICT (id) DO UPDATE SET
       occurrences = occurrences + 1,
       first_seen = MIN(first_seen, excluded.first_seen),
       last_seen = MAX(last_seen, excluded.last_seen),
       confidence = MAX(confidence, excluded.confidence)`,
  ).run({ id, ...input });
}

export function identifiersFor(db: DB, entityIdValue: string): readonly Identifier[] {
  const rows = db
    .prepare(
      `SELECT id, entity_id AS entityId, kind, value, normalized, confidence,
              occurrences, first_seen AS firstSeen, last_seen AS lastSeen
       FROM identifiers WHERE entity_id = ?
       ORDER BY occurrences DESC, kind`,
    )
    .all(entityIdValue) as Identifier[];

  return rows;
}

export function linkItem(
  db: DB,
  itemId: string,
  entityIdValue: string,
  role: EntityRole,
): void {
  db.prepare(
    `INSERT INTO item_entities (item_id, entity_id, role) VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(itemId, entityIdValue, role);
}

export function clearItemLinks(db: DB, itemId: string): void {
  db.prepare(`DELETE FROM item_entities WHERE item_id = ?`).run(itemId);
}

export function markResolved(db: DB, itemId: string, version: number): void {
  db.prepare(`UPDATE items SET entities_version = ? WHERE id = ?`).run(version, itemId);
}

export interface PendingResolution {
  readonly id: string;
  readonly kind: string;
  readonly author: string | null;
  readonly participants: string | null;
  readonly occurredAt: number;
  readonly direction: string | null;
}

export function pendingResolution(
  db: DB,
  version: number,
  limit: number,
): readonly PendingResolution[] {
  return db
    .prepare(
      `SELECT id, kind, author, participants, occurred_at AS occurredAt, direction
       FROM items
       WHERE deleted_at IS NULL
         AND (entities_version IS NULL OR entities_version <> ?)
       ORDER BY occurred_at DESC
       LIMIT ?`,
    )
    .all(version, limit) as PendingResolution[];
}

export function countPendingResolution(db: DB, version: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items
       WHERE deleted_at IS NULL AND (entities_version IS NULL OR entities_version <> ?)`,
    )
    .get(version) as { n: number };

  return row.n;
}

export interface EntitySummary {
  readonly entity: Entity;
  readonly items: number;
  readonly received: number;
  readonly sent: number;
  readonly lastSeen: number | null;
  readonly addresses: readonly string[];
  readonly aliases: readonly string[];
}

function summarize(db: DB, rows: readonly (EntityRow & { items: number })[]): readonly EntitySummary[] {
  return rows.map((row) => {
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) AS items,
           SUM(CASE WHEN i.direction = 'inbound' THEN 1 ELSE 0 END) AS received,
           SUM(CASE WHEN i.direction = 'outbound' THEN 1 ELSE 0 END) AS sent,
           MAX(i.occurred_at) AS lastSeen
         FROM item_entities ie
         JOIN items i ON i.id = ie.item_id
         WHERE ie.entity_id = ? AND i.deleted_at IS NULL`,
      )
      .get(row.id) as {
      items: number;
      received: number | null;
      sent: number | null;
      lastSeen: number | null;
    };

    const addresses = db
      .prepare(
        `SELECT value FROM identifiers WHERE entity_id = ? AND kind IN ('email', 'phone')
         ORDER BY occurrences DESC LIMIT 8`,
      )
      .all(row.id) as { value: string }[];

    return {
      entity: hydrate(row),
      items: counts.items,
      received: counts.received ?? 0,
      sent: counts.sent ?? 0,
      lastSeen: counts.lastSeen,
      addresses: addresses.map((entry) => entry.value),
      aliases: aliasesOf(db, row.id),
    };
  });
}

/**
 * The people worth looking at.
 *
 * Sorting purely by volume puts newsletters first, which is accurate and makes
 * the list useless: a mailbox with two thousand messages from one marketing
 * sender buries every human being under it. So the default is people you have
 * actually written to, which is the only cheap signal that separates
 * correspondence from broadcast. `includeAll` restores the raw ordering.
 */
export function topEntities(
  db: DB,
  limit: number,
  includeAll = false,
): readonly EntitySummary[] {
  // "Written to" is not the same as "corresponded with".
  //
  // A real store filled the list with unsubscribe endpoints and tracking
  // addresses, because clicking unsubscribe sends mail and that counted. Two
  // outbound messages is a low bar that machines rarely clear, and an address
  // that looks like plumbing is excluded outright.
  const correspondentsOnly = includeAll
    ? ""
    : `AND (
         e.kind = 'self'
         OR (
           (
             SELECT COUNT(*) FROM item_entities oe
             JOIN items o ON o.id = oe.item_id
             WHERE oe.entity_id = e.id AND o.direction = 'outbound' AND o.deleted_at IS NULL
           ) >= 2
           AND NOT EXISTS (
             SELECT 1 FROM identifiers d
             WHERE d.entity_id = e.id
               AND d.kind = 'email'
               AND (
                 d.normalized LIKE '%unsubscribe%'
                 OR d.normalized LIKE '%tracking.%'
                 OR d.normalized LIKE '%no-reply%'
                 OR d.normalized LIKE '%noreply%'
                 OR d.normalized LIKE '%@mdb.%'
                 OR LENGTH(d.normalized) > 60
               )
           )
         )
       )`;

  const rows = db
    .prepare(
      `SELECT e.*, COUNT(ie.item_id) AS items
       FROM entities e
       LEFT JOIN item_entities ie ON ie.entity_id = e.id
       WHERE e.merged_into IS NULL AND e.kind <> 'org' ${correspondentsOnly}
       GROUP BY e.id
       ORDER BY items DESC, e.display_name
       LIMIT ?`,
    )
    .all(limit) as (EntityRow & { items: number })[];

  return summarize(db, rows);
}

/**
 * Looks a person up the way a human would refer to them: part of a name, part
 * of an address, or an entity id.
 */
/**
 * Looks a person up the way someone would refer to them.
 *
 * Four ways in, in order of how exact they are: an entity id, an alias, a
 * display name, an identifier. A phone number typed in any format is folded to
 * E.164 first, so "(610) 555-0134" finds the person iMessage knows as
 * "+16105550134".
 *
 * Ordered by how much correspondence there is, because when "issy" matches two
 * people the one you actually talk to is almost always the one you meant. The
 * tool layer still says how many matched rather than picking silently.
 */
export function lookupEntities(db: DB, query: string, limit = 10): readonly EntitySummary[] {
  const trimmed = query.trim();

  // Folding strips punctuation so accents and spacing do not matter, which is
  // right for names and wrong for addresses: it turns issy@example.com into
  // issyexamplecom and the lookup finds nothing. An address is matched as
  // typed.
  const isAddress = trimmed.includes("@");
  const folded = isAddress ? trimmed.toLowerCase() : fold(trimmed);
  const needle = `%${folded}%`;
  // Aliases match exactly or by prefix, never as a substring.
  //
  // Substring matching on generated nicknames was catastrophic: "Ubisoft
  // Account Support" generates "ubissy", "Discord" generates "dissy", and
  // `LIKE %issy%` matched all of them. Searching for a person returned five
  // companies. A nickname is a whole word someone says, so anchoring it at the
  // start is both correct and enough to keep "iz" finding "izzy".
  const prefix = `${folded}%`;
  const phone = looksLikePhone(trimmed) ? normalizePhone(trimmed) : null;

  const rows = db
    .prepare(
      `SELECT e.*, COUNT(ie.item_id) AS items
       FROM entities e
       LEFT JOIN item_entities ie ON ie.entity_id = e.id
       WHERE e.merged_into IS NULL
         AND (
           e.id = @exact
           OR LOWER(e.display_name) LIKE @needle
           OR EXISTS (
             SELECT 1 FROM entity_aliases a
             WHERE a.entity_id = e.id
               AND (a.normalized = @folded OR a.normalized LIKE @prefix)
           )
           OR EXISTS (
             SELECT 1 FROM identifiers d
             WHERE d.entity_id = e.id
               AND (d.normalized LIKE @needle OR LOWER(d.value) LIKE @needle
                    OR (@phone IS NOT NULL AND d.normalized = @phone))
           )
         )
       GROUP BY e.id
       ORDER BY items DESC
       LIMIT @limit`,
    )
    .all({ needle, folded, prefix, exact: trimmed, phone, limit }) as (EntityRow & {
    items: number;
  })[];

  return summarize(db, rows);
}

export function selfEntity(db: DB): Entity | null {
  const row = db
    .prepare(`SELECT * FROM entities WHERE kind = 'self' AND merged_into IS NULL LIMIT 1`)
    .get() as EntityRow | undefined;

  return row === undefined ? null : hydrate(row);
}

/**
 * Merges `source` into `target`.
 *
 * Identifiers move, item links move, and the source is tombstoned with a
 * pointer rather than deleted, so the merge is inspectable and the ids in old
 * evidence trails still resolve.
 */
export function mergeEntities(db: DB, sourceId: string, targetId: string): number {
  if (sourceId === targetId) {
    return 0;
  }

  const merge = db.transaction(() => {
    db.prepare(`UPDATE identifiers SET entity_id = ? WHERE entity_id = ?`).run(targetId, sourceId);

    db.prepare(
      `INSERT INTO entity_aliases (entity_id, alias, normalized, origin, created_at)
       SELECT ?, alias, normalized, origin, created_at FROM entity_aliases WHERE entity_id = ?
       ON CONFLICT DO NOTHING`,
    ).run(targetId, sourceId);

    db.prepare(`DELETE FROM entity_aliases WHERE entity_id = ?`).run(sourceId);

    db.prepare(
      `INSERT INTO item_entities (item_id, entity_id, role)
       SELECT item_id, ?, role FROM item_entities WHERE entity_id = ?
       ON CONFLICT DO NOTHING`,
    ).run(targetId, sourceId);

    db.prepare(`DELETE FROM item_entities WHERE entity_id = ?`).run(sourceId);

    db.prepare(
      `UPDATE entities SET merged_into = ?, updated_at = ?, pinned = 1 WHERE id = ?`,
    ).run(targetId, Date.now(), sourceId);

    // A merge is a human decision. Keep it through every future re-resolution.
    db.prepare(`UPDATE entities SET pinned = 1, updated_at = ? WHERE id = ?`).run(
      Date.now(),
      targetId,
    );
  });

  merge();

  const moved = db
    .prepare(`SELECT COUNT(*) AS n FROM identifiers WHERE entity_id = ?`)
    .get(targetId) as { n: number };

  return moved.n;
}

/** Detaches one identifier onto a fresh entity. The undo for a bad merge. */
export function unlinkIdentifier(db: DB, kind: IdentifierKind, normalized: string): Entity | null {
  const id = identifierId(kind, normalized);

  const existing = db.prepare(`SELECT value FROM identifiers WHERE id = ?`).get(id) as
    | { value: string }
    | undefined;

  if (existing === undefined) {
    return null;
  }

  const entity = createEntity(db, "person", existing.value, `split:${id}:${String(Date.now())}`);

  db.prepare(`UPDATE identifiers SET entity_id = ? WHERE id = ?`).run(entity.id, id);
  pinEntity(db, entity.id);

  return entity;
}

/**
 * Aliases: how a person might be referred to, as opposed to who they are.
 *
 * No uniqueness on purpose. Two people can both be "issy", and an identifier
 * row could not represent that without one silently swallowing the other, which
 * is precisely the merge-two-people failure the whole entity design is built to
 * avoid. Aliases widen lookup and never anchor anything.
 */
export function setAliases(
  db: DB,
  entityId: string,
  aliases: readonly { readonly alias: string; readonly origin: string }[],
): number {
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM entity_aliases WHERE entity_id = ?`).run(entityId);

    const insert = db.prepare(
      `INSERT INTO entity_aliases (entity_id, alias, normalized, origin, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );

    for (const entry of aliases) {
      insert.run(entityId, entry.alias, entry.alias, entry.origin, Date.now());
    }
  });

  write();
  return aliases.length;
}

export function aliasesOf(db: DB, entityId: string): readonly string[] {
  const rows = db
    .prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY origin, alias`)
    .all(entityId) as { alias: string }[];

  return rows.map((row) => row.alias);
}

export interface EntityStats {
  readonly entities: number;
  readonly merged: number;
  readonly identifiers: number;
  readonly links: number;
  readonly pinned: number;
}

export function entityStats(db: DB): EntityStats {
  const entities = db
    .prepare(
      `SELECT
         SUM(CASE WHEN merged_into IS NULL THEN 1 ELSE 0 END) AS live,
         SUM(CASE WHEN merged_into IS NOT NULL THEN 1 ELSE 0 END) AS merged,
         SUM(CASE WHEN pinned = 1 AND merged_into IS NULL THEN 1 ELSE 0 END) AS pinned
       FROM entities`,
    )
    .get() as { live: number | null; merged: number | null; pinned: number | null };

  const identifiers = db.prepare(`SELECT COUNT(*) AS n FROM identifiers`).get() as { n: number };
  const links = db.prepare(`SELECT COUNT(*) AS n FROM item_entities`).get() as { n: number };

  return {
    entities: entities.live ?? 0,
    merged: entities.merged ?? 0,
    pinned: entities.pinned ?? 0,
    identifiers: identifiers.n,
    links: links.n,
  };
}

// ---- handles a connector says are the user's ----

export interface SelfHandleRow {
  readonly kind: string;
  readonly value: string;
  readonly source: string;
}

/**
 * Records handles a connector has declared to be the user's.
 *
 * Written on every sync and idempotent. The table is small, permanent, and read
 * by `ensureSelf`, which is what turns "these are addresses on an account" into
 * "this entity is you".
 */
export function recordSelfHandles(
  db: DB,
  source: string,
  handles: readonly { readonly kind: string; readonly value: string }[],
): number {
  if (handles.length === 0) {
    return 0;
  }

  const insert = db.prepare(
    `INSERT INTO self_handles (value, kind, source, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (value) DO NOTHING`,
  );

  const now = Date.now();
  let written = 0;

  const work = db.transaction(() => {
    for (const handle of handles) {
      const value = handle.value.trim();

      if (value.length === 0) {
        continue;
      }

      written += insert.run(value, handle.kind, source, now).changes;
    }
  });

  work();

  return written;
}

export function listSelfHandles(db: DB): readonly SelfHandleRow[] {
  return db
    .prepare(`SELECT kind, value, source FROM self_handles ORDER BY kind, value`)
    .all() as SelfHandleRow[];
}
