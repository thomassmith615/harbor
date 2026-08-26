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
import { referencesIn } from "./anchors.js";
import type { DB } from "../kernel/db.js";
import type { ItemReference } from "../store/references.js";

/**
 * Bump to re-scan stored text. Independent of RELATIONSHIP_VERSION.
 *
 * 2: flight numbers no longer require the word "flight" immediately in front of
 * them. The old pattern read `Flight AA 4608` in an email body and read nothing
 * at all from a calendar entry titled "Flight PHL to BOS" carrying `AA 1783`,
 * because the route sat between the keyword and the code. That gap cost the
 * strongest edge available on a real store: an airline confirmation and the
 * calendar entry the airline generated share a flight number and were never
 * once connected by it.
 */
export const REFERENCE_VERSION = 2;

/** How much of an item's text is scanned. A reference that matters is near the top. */
const SCAN_LIMIT = 4_000;

/**
 * References in one item.
 *
 * The patterns themselves now live in `derive/anchors.ts` and are shared with
 * the story layer. Two copies of "what counts as an identifier" is exactly the
 * kind of duplication that drifts: one of them gets improved, and afterwards
 * the graph and the stories disagree about whether two things share a booking
 * code, with nothing anywhere reporting a conflict.
 */
export function extractReferences(
  itemId: string,
  title: string | null,
  body: string | null,
): readonly ItemReference[] {
  const text = `${title ?? ""} ${body ?? ""}`;

  if (text.trim().length === 0) {
    return [];
  }

  return referencesIn(text.slice(0, SCAN_LIMIT)).map((reference) => ({
    itemId,
    kind: reference.kind,
    value: reference.value,
  }));
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
