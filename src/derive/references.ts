/**
 * Extracting references from item text.
 *
 * This used to live inside the `shares_reference` linker, which meant the
 * patterns were re-run against every item in every batch and the results were
 * thrown away. Now it is a derivation like every other: versioned, incremental,
 * resumable, and driven off a column that `upsertItem` clears when content
 * changes.
 *
 * Patterns stay narrow on purpose. A pattern that matches ordinary prose
 * connects unrelated items with total confidence, which is worse than drawing
 * no edge at all.
 */
import {
  markReferenced,
  pendingReferenceItems,
  replaceReferences,
  countPendingReferences,
} from "../store/references.js";
import type { DB } from "../kernel/db.js";
import type { ItemReference } from "../store/references.js";

/** Bump to re-scan stored text. Independent of RELATIONSHIP_VERSION. */
export const REFERENCE_VERSION = 1;

/** How much of an item's text is scanned. A reference that matters is near the top. */
const SCAN_LIMIT = 4_000;

const PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  // The keyword comes before the code, always. An earlier version looked for it
  // afterwards with a lookahead and matched nothing at all, because "Flight AA
  // 4608" puts the word first and so does every airline that has ever existed.
  { name: "flight", pattern: /\b(?:flight|flt)\s*#?\s*([A-Z]{2}\s?\d{2,4})\b/gi },
  {
    name: "confirmation",
    pattern:
      /\b(?:confirmation|booking|reservation|order|itinerary)\s*(?:number|code|#|no\.?)?\s*:?\s*([A-Z0-9]{6,})\b/gi,
  },
  { name: "tracking", pattern: /\b(?:tracking|shipment)\s*#?\s*:?\s*(1Z[0-9A-Z]{16}|\d{10,22})\b/gi },
  {
    name: "meeting",
    pattern: /\b(?:zoom\.us\/j\/(\d{9,})|meet\.google\.com\/([a-z]{3,}-[a-z]{3,}-[a-z]{3,}))/gi,
  },
];

/**
 * Words that are not references even when a pattern captures them.
 *
 * From a real failure: an email titled "Your trip confirmation" whose body
 * opened "Confirmation ABC7788XY" yielded the reference "CONFIRMATION", which
 * then matched every other confirmation email in the store.
 */
const NOT_A_REFERENCE = /^(CONFIRMATION|BOOKING|RESERVATION|ITINERARY|ORDER|NUMBER)$/;

export function extractReferences(
  itemId: string,
  title: string | null,
  body: string | null,
): readonly ItemReference[] {
  const text = `${title ?? ""} ${body ?? ""}`;

  if (text.trim().length === 0) {
    return [];
  }

  const scannable = text.slice(0, SCAN_LIMIT);
  const found = new Map<string, ItemReference>();

  for (const { name, pattern } of PATTERNS) {
    for (const match of scannable.matchAll(pattern)) {
      const value = (match[1] ?? match[2] ?? "").replace(/\s+/g, "").toUpperCase();

      // A reference contains a digit, is long enough to be arbitrary, and is
      // not the English word that preceded it.
      if (value.length < 5 || !/\d/.test(value) || NOT_A_REFERENCE.test(value)) {
        continue;
      }

      found.set(`${name}:${value}`, { itemId, kind: name, value });
    }
  }

  return [...found.values()];
}

export interface ReferenceReport {
  readonly itemsScanned: number;
  readonly referencesFound: number;
  readonly remaining: number;
}

const BATCH = 1_000;

/**
 * Scans every item whose references are missing or stale.
 *
 * Runs before the linkers rather than beside them, because candidate generation
 * reads this table: an item whose references have not been extracted yet cannot
 * be found by the item that shares one with it.
 */
export function indexReferences(
  db: DB,
  options: {
    readonly limit?: number | undefined;
    readonly shouldStop?: (() => boolean) | undefined;
    readonly onProgress?: ((done: number, total: number) => void) | undefined;
  } = {},
): ReferenceReport {
  const total = Math.min(
    countPendingReferences(db, REFERENCE_VERSION),
    options.limit ?? Number.MAX_SAFE_INTEGER,
  );

  let scanned = 0;
  let found = 0;

  while (scanned < total) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const rows = pendingReferenceItems(db, REFERENCE_VERSION, Math.min(BATCH, total - scanned));

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const references = extractReferences(row.id, row.title, row.body);

      // Written even when empty: an item with no references still needs its
      // previous ones cleared, or a fixed pattern leaves stale rows behind.
      replaceReferences(db, row.id, references);
      found += references.length;
    }

    markReferenced(
      db,
      rows.map((row) => row.id),
      REFERENCE_VERSION,
    );

    scanned += rows.length;
    options.onProgress?.(scanned, total);
  }

  return {
    itemsScanned: scanned,
    referencesFound: found,
    remaining: countPendingReferences(db, REFERENCE_VERSION),
  };
}
