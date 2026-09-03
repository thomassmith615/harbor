/**
 * Turning venue phrases into place entities, and names into sounds-like keys.
 *
 * Both are the same shape of work and both exist for the graph rather than for
 * the display: they take something that was a string on a node and make it a
 * key that two nodes can share.
 *
 * A `venue` anchor holds a normalized phrase. Two nodes about the same bar
 * under different names hold different phrases, so nothing can join them. Once
 * the phrase resolves to a place entity the anchor holds the entity id instead,
 * and the join is on a primary key. The anchor's `display` keeps the words
 * somebody actually wrote, so the evidence line can still say "both mention the
 * Great American Pub" using their phrasing rather than a canonical form nobody
 * used.
 *
 * Resolution is deliberately one-directional and conservative. A phrase that
 * names something becomes or finds a place. A phrase that merely refers to one
 * ("the bar", "the office") is left alone, forever, because the alternative is
 * a single entity called "the bar" that accumulates every unrelated evening in
 * the store and then asserts they were all at the same venue. An unresolved
 * reference is the correct outcome for a conversation that never said where.
 *
 * Name keys are the other half. `phonetics.ts` explains why they are stored
 * rather than computed at query time; this is the pass that stores them.
 */
import { anchorsFor, replaceAnchors } from "../store/anchors.js";
import { observePlace } from "../store/places.js";
import { recordNameKeys, clearNameKeys } from "../store/attributes.js";
import { metaphone } from "./phonetics.js";
import { normalizeVenue } from "./plans.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "../store/nodes.js";
import type { Anchor } from "./anchors.js";

/**
 * Bump to resolve every venue again.
 *
 * Separate from ANCHOR_VERSION because the gazetteer of places grows as the
 * store sees more of them: a phrase that resolved to nothing in March resolves
 * in June once the venue has been named somewhere with an address, and that is
 * worth a cheap re-run without re-reading every mailbox.
 */
export const PLACE_VERSION = 1;

export interface PlaceReport {
  readonly anchorsConsidered: number;
  readonly resolved: number;
  readonly created: number;
  readonly namesKeyed: number;
}

interface VenueRow {
  readonly node_kind: string;
  readonly node_id: string;
  readonly value: string;
  readonly display: string;
}

/**
 * An address stated on the same node as the venue name.
 *
 * A confirmation says the venue and its street address in the same body, and
 * pairing them at the moment the place is created is the only cheap chance to
 * do it: afterwards the address is a topic anchor among a dozen others with
 * nothing marking it as belonging to the name.
 */
const ADDRESS =
  /\b\d{1,5}\s+[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Pike|Pl|Place)\b[^\n]{0,40}/;

export function resolvePlaces(db: DB, options: { readonly limit?: number } = {}): PlaceReport {
  const rows = db
    .prepare(
      `SELECT node_kind, node_id, value, display
       FROM node_anchors
       WHERE kind = 'venue' AND value NOT LIKE 'e\\_%' ESCAPE '\\'
       LIMIT @limit`,
    )
    .all({ limit: options.limit ?? 5_000 }) as VenueRow[];

  let resolved = 0;
  let created = 0;

  const before = (
    db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE kind = 'place'`).get() as { n: number }
  ).n;

  for (const row of rows) {
    const ref: NodeRef = { kind: row.node_kind as NodeRef["kind"], id: row.node_id };

    const text = textOf(db, ref);
    const address = text === null ? null : (ADDRESS.exec(text)?.[0]?.trim() ?? null);

    const place = observePlace(db, {
      phrase: row.display,
      address,
      sourceKind: ref.kind,
      sourceId: ref.id,
      observedAt: occurredAt(db, ref) ?? Date.now(),
    });

    if (place === null) {
      continue;
    }

    // The anchor now points at the place rather than describing it. Rewritten
    // in place rather than added alongside, because two venue anchors on one
    // node (a phrase and an id) would double-count in every scorer that
    // measures how many kinds of evidence a node carries.
    const anchors = anchorsFor(db, ref).map((anchor): Anchor => {
      if (anchor.kind !== "venue" || anchor.value !== row.value) {
        return anchor;
      }

      return { ...anchor, value: place.id, confidence: Math.max(anchor.confidence, 0.75) };
    });

    replaceAnchors(db, ref, anchors);
    resolved += 1;
  }

  const after = (
    db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE kind = 'place'`).get() as { n: number }
  ).n;

  created = after - before;

  return { anchorsConsidered: rows.length, resolved, created, namesKeyed: keyNames(db) };
}

function textOf(db: DB, ref: NodeRef): string | null {
  if (ref.kind === "episode") {
    const row = db.prepare(`SELECT transcript FROM episodes WHERE id = ?`).get(ref.id) as
      | { transcript: string }
      | undefined;

    return row?.transcript ?? null;
  }

  const row = db.prepare(`SELECT title, body FROM items WHERE id = ?`).get(ref.id) as
    | { title: string | null; body: string | null }
    | undefined;

  if (row === undefined) {
    return null;
  }

  return `${row.title ?? ""}\n${row.body ?? ""}`;
}

function occurredAt(db: DB, ref: NodeRef): number | null {
  const table = ref.kind === "episode" ? "episodes" : "items";
  const column = ref.kind === "episode" ? "starts_at" : "occurred_at";

  const row = db.prepare(`SELECT ${column} AS at FROM ${table} WHERE id = ?`).get(ref.id) as
    | { at: number }
    | undefined;

  return row?.at ?? null;
}

/**
 * Phonetic keys for every entity that does not have them yet.
 *
 * Keyed from the display name and from each name identifier, because those
 * differ: an entity displayed as "Dave" may carry "David Mullen" as an
 * identifier, and a lookup for either spelling should reach it.
 */
export function keyNames(db: DB): number {
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.display_name AS name
       FROM entities e
       WHERE e.merged_into IS NULL
         AND e.kind IN ('person', 'self')
         AND NOT EXISTS (SELECT 1 FROM name_keys k WHERE k.entity_id = e.id)`,
    )
    .all() as { id: string; name: string }[];

  const identifiers = db.prepare(
    `SELECT value FROM identifiers WHERE entity_id = ? AND kind = 'name'`,
  );

  let keyed = 0;

  for (const row of rows) {
    const names = [
      row.name,
      ...(identifiers.all(row.id) as { value: string }[]).map((entry) => entry.value),
    ];

    const keys = new Set<string>();

    for (const name of names) {
      // Each part separately. "Dave Mullen" has to be reachable by either half,
      // because half of all mentions of anybody are a first name alone.
      for (const part of name.split(/\s+/)) {
        if (part.length >= 2) {
          for (const key of metaphone(part)) {
            keys.add(key);
          }
        }
      }
    }

    if (keys.size > 0) {
      recordNameKeys(db, row.id, [...keys], "name");
      keyed += 1;
    }
  }

  return keyed;
}

/** Drops and rebuilds one entity's keys, after a merge or a rename. */
export function rekeyEntity(db: DB, entityId: string): void {
  clearNameKeys(db, entityId);
  void normalizeVenue;
  keyNames(db);
}
