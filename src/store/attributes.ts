/**
 * What is known about somebody, and where it was read.
 *
 * `entities` holds a name and nothing else, which meant Harbor could tell you
 * that Dave exists and nothing about him. `facts` was the nearest thing to a
 * memory and its own prompt restricts it to the user: *only about the person
 * labelled Me, never about anyone else in the conversation*. So a number
 * somebody texted, an address in a confirmation, an employer mentioned in
 * passing had nowhere to go except a topic anchor on the node it appeared in,
 * which is a place it can be found only by searching for the node.
 *
 * Every attribute carries where it came from and, where somebody wrote it, the
 * words they used. That is not bookkeeping. A standing claim about a person
 * colours everything Harbor says about them afterwards, and the difference
 * between a claim that can be checked and one that cannot is the difference
 * between a mistake somebody can correct and a mistake that quietly persists.
 * The same discipline as `facts.ts`, applied to third parties, because the
 * argument for it is stronger there rather than weaker: a wrong fact about
 * yourself is obvious to you and a wrong fact about somebody else is not.
 *
 * Attributes accumulate rather than overwrite. People have two numbers and
 * three addresses, and an old one is not wrong, it is old. `lastSeenAt` and
 * `occurrences` are what a reader uses to decide which is current, and no
 * writer here makes that decision on their behalf.
 */
import { randomUUID } from "node:crypto";
import { normalizePhone } from "../derive/nicknames.js";
import type { DB } from "../kernel/db.js";

/**
 * The kinds worth having.
 *
 * Open rather than a CHECK constraint, because the set will grow and a
 * migration per attribute kind is a tax on exactly the experimentation this is
 * for. The cost is that a typo becomes a new kind, which `harbor person` will
 * show and nothing will read.
 */
export type AttributeKind =
  | "phone"
  | "email"
  | "address"
  | "employer"
  | "role"
  | "birthday"
  | "relationship"
  | "restriction"
  | "note"
  | string;

/** Where a claim came from. Never a bare guess; see the note above. */
export type AttributeOrigin =
  /** Somebody wrote it, and the quote proves it. */
  | "stated"
  /** A connector supplied it as structured data. An address book, a vCard. */
  | "source"
  /** A person typed it into Harbor. */
  | "user";

export interface AttributeInput {
  readonly entityId: string;
  readonly kind: AttributeKind;
  readonly value: string;
  readonly normalized?: string;
  readonly confidence: number;
  readonly origin: AttributeOrigin;
  readonly sourceKind?: string | null;
  readonly sourceId?: string | null;
  readonly quote?: string | null;
  readonly observedAt: number;
}

export interface Attribute {
  readonly id: string;
  readonly entityId: string;
  readonly kind: AttributeKind;
  readonly value: string;
  readonly normalized: string;
  readonly confidence: number;
  readonly origin: AttributeOrigin;
  readonly sourceKind: string | null;
  readonly sourceId: string | null;
  readonly quote: string | null;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly occurrences: number;
}

export function normalizeAttribute(kind: AttributeKind, value: string): string {
  const trimmed = value.trim().toLowerCase();

  if (kind === "phone") {
    // Through the same helper the identifier layer uses, not a local strip.
    // Two spellings of one number have to produce one key or the UNIQUE
    // constraint records them as two claims, and "(610) 555-0182" and
    // "+1 610 555 0182" are the same number written by two people.
    return normalizePhone(value) ?? trimmed.replace(/[^\d]/g, "");
  }

  if (kind === "address") {
    // Enough to make "123 Fayette St." and "123 Fayette Street" one claim,
    // which is the whole point of a normalized column, without pretending to
    // be an address parser.
    return trimmed
      .replace(/[.,]/g, "")
      .replace(/\bstreet\b/g, "st")
      .replace(/\bavenue\b/g, "ave")
      .replace(/\broad\b/g, "rd")
      .replace(/\bapartment\b|\bapt\b/g, "apt")
      .replace(/\s+/g, " ");
  }

  return trimmed.replace(/\s+/g, " ");
}

/**
 * Records an attribute, or strengthens one already there.
 *
 * Seeing the same claim again is evidence, so a repeat raises `occurrences` and
 * moves `lastSeenAt` without disturbing the first sighting or the quote that
 * came with it. Confidence only ever rises: a weaker restatement of something
 * already believed is not a reason to believe it less.
 */
export function recordAttribute(db: DB, input: AttributeInput): void {
  const normalized = input.normalized ?? normalizeAttribute(input.kind, input.value);

  if (normalized.length === 0) {
    return;
  }

  db.prepare(
    `INSERT INTO entity_attributes
       (id, entity_id, kind, value, normalized, confidence, origin,
        source_kind, source_id, quote, first_seen_at, last_seen_at, occurrences)
     VALUES
       (@id, @entityId, @kind, @value, @normalized, @confidence, @origin,
        @sourceKind, @sourceId, @quote, @observedAt, @observedAt, 1)
     ON CONFLICT (entity_id, kind, normalized) DO UPDATE SET
       occurrences   = occurrences + 1,
       last_seen_at  = MAX(last_seen_at, excluded.last_seen_at),
       first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
       confidence    = MAX(confidence, excluded.confidence),
       -- The first quote is kept. A later sighting of the same claim is
       -- confirmation, and replacing the words that originally justified it
       -- with a passing mention loses the better evidence.
       quote         = COALESCE(quote, excluded.quote)`,
  ).run({
    id: randomUUID(),
    entityId: input.entityId,
    kind: input.kind,
    value: input.value.trim(),
    normalized,
    confidence: input.confidence,
    origin: input.origin,
    sourceKind: input.sourceKind ?? null,
    sourceId: input.sourceId ?? null,
    quote: input.quote ?? null,
    observedAt: input.observedAt,
  });
}

export function attributesFor(
  db: DB,
  entityId: string,
  kind?: AttributeKind,
): readonly Attribute[] {
  const rows = db
    .prepare(
      `SELECT * FROM entity_attributes
       WHERE entity_id = @entityId ${kind === undefined ? "" : "AND kind = @kind"}
       ORDER BY kind, occurrences DESC, last_seen_at DESC`,
    )
    .all({ entityId, kind: kind ?? "" }) as Record<string, unknown>[];

  return rows.map(toAttribute);
}

/**
 * Who has this attribute value.
 *
 * The reverse lookup, and the one the graph will want: a number in a message
 * signature reaching the person it belongs to is how a node about somebody
 * becomes a node connected to them.
 */
export function holdersOfAttribute(
  db: DB,
  kind: AttributeKind,
  value: string,
): readonly Attribute[] {
  const rows = db
    .prepare(`SELECT * FROM entity_attributes WHERE kind = ? AND normalized = ?`)
    .all(kind, normalizeAttribute(kind, value)) as Record<string, unknown>[];

  return rows.map(toAttribute);
}

function toAttribute(row: Record<string, unknown>): Attribute {
  return {
    id: row["id"] as string,
    entityId: row["entity_id"] as string,
    kind: row["kind"] as string,
    value: row["value"] as string,
    normalized: row["normalized"] as string,
    confidence: row["confidence"] as number,
    origin: row["origin"] as AttributeOrigin,
    sourceKind: (row["source_kind"] as string | null) ?? null,
    sourceId: (row["source_id"] as string | null) ?? null,
    quote: (row["quote"] as string | null) ?? null,
    firstSeenAt: row["first_seen_at"] as number,
    lastSeenAt: row["last_seen_at"] as number,
    occurrences: row["occurrences"] as number,
  };
}

export function forgetAttribute(db: DB, id: string): boolean {
  return db.prepare(`DELETE FROM entity_attributes WHERE id = ?`).run(id).changes > 0;
}

/* -------------------------------------------------------------------------
 * Sounds-like keys.
 * ---------------------------------------------------------------------- */

/**
 * Records the phonetic keys for a name.
 *
 * Stored rather than computed at query time so a lookup is an index hit. The
 * alternative is scanning every name in the store on every query, which is
 * fine at a hundred correspondents and is not fine at four thousand.
 */
export function recordNameKeys(
  db: DB,
  entityId: string,
  keys: readonly string[],
  source: string,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO name_keys (entity_id, key, source) VALUES (?, ?, ?)`,
  );

  for (const key of keys) {
    if (key.length >= 2) {
      insert.run(entityId, key, source);
    }
  }
}

export function entitiesByNameKey(db: DB, keys: readonly string[]): readonly string[] {
  if (keys.length === 0) {
    return [];
  }

  const placeholders = keys.map(() => "?").join(", ");

  const rows = db
    .prepare(
      `SELECT DISTINCT k.entity_id AS id
       FROM name_keys k
       JOIN entities e ON e.id = k.entity_id
       WHERE k.key IN (${placeholders}) AND e.merged_into IS NULL`,
    )
    .all(...keys) as { id: string }[];

  return rows.map((row) => row.id);
}

export function clearNameKeys(db: DB, entityId: string): void {
  db.prepare(`DELETE FROM name_keys WHERE entity_id = ?`).run(entityId);
}
