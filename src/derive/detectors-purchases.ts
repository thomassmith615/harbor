/**
 * Things you buy on a rhythm, and have not lately.
 *
 * The detector the product was described by: a grocery bill arrives, Harbor
 * keeps the history, and eventually it says "you are probably out of this".
 *
 * The whole thing is a SQL query and a median, which is the point. No model is
 * involved in noticing, only possibly in phrasing, so it costs nothing to run
 * over an entire purchase history forever. That is the same economics as every
 * other detector here and the reason this layer can exist at all.
 *
 * Three deliberate restraints, because a restocking prompt that is wrong is
 * worse than no restocking prompt:
 *
 * **Merchants, not products.** The line items come from a small local model
 * reading a receipt and they are noisy: "16\" Plain Jane", "Mystery Hat",
 * "...". A merchant name survives that treatment and a product name does not.
 * Per-product restocking is the better feature and it needs an extraction layer
 * that can be trusted, which does not exist yet.
 *
 * **Four purchases before a rhythm is claimed.** Three points make a pattern
 * out of any two coincidences. Four is the smallest number where a median
 * interval means something.
 *
 * **Regular things only.** If the gaps between purchases vary wildly, there is
 * no rhythm to be late for. A coffee shop visited whenever you happen to be
 * nearby will never qualify, and should not.
 */
import { merchantKey } from "../projections/merchants.js";
import { recordObservation } from "../store/signals.js";
import type { DetectorContext, DetectorResult } from "./detectors.js";
import type { DB } from "../kernel/db.js";

/** Below this many purchases, a gap is a coincidence rather than a rhythm. */
const MIN_PURCHASES = 4;

/**
 * How irregular a rhythm may be and still count.
 *
 * Measured as the spread of the gaps against their median. Groceries every
 * seven to ten days pass; a restaurant visited on a whim does not, because
 * there is nothing to be late for.
 */
const MAX_IRREGULARITY = 0.6;

/** How far past the usual gap before it is worth saying anything. */
const OVERDUE_FACTOR = 1.5;

/** And never for something bought so rarely that being late means little. */
const MIN_INTERVAL_MS = 5 * 86_400_000;
const MAX_INTERVAL_MS = 120 * 86_400_000;

interface PurchaseRow {
  readonly itemId: string;
  readonly merchant: string;
  readonly occurredAt: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function describeDays(ms: number): string {
  const days = Math.round(ms / 86_400_000);

  if (days >= 60) {
    return `${String(Math.round(days / 30))} months`;
  }

  if (days >= 14) {
    return `${String(Math.round(days / 7))} weeks`;
  }

  return `${String(days)} days`;
}

export function detectDuePurchases(db: DB, context: DetectorContext): DetectorResult {
  const rows = db
    .prepare(
      `SELECT item_id AS itemId, merchant, occurred_at AS occurredAt
       FROM projections
       WHERE principal_id = ? AND type = 'purchase' AND merchant IS NOT NULL
       ORDER BY occurred_at ASC`,
    )
    .all(context.principalId) as PurchaseRow[];

  const groups = new Map<string, { name: string; at: number[]; items: string[] }>();

  for (const row of rows) {
    const key = merchantKey(row.merchant);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, { name: row.merchant, at: [row.occurredAt], items: [row.itemId] });
      continue;
    }

    existing.at.push(row.occurredAt);
    existing.items.push(row.itemId);
  }

  let created = 0;

  for (const group of groups.values()) {
    if (group.at.length < MIN_PURCHASES) {
      continue;
    }

    const gaps: number[] = [];

    for (let index = 1; index < group.at.length; index += 1) {
      gaps.push((group.at[index] ?? 0) - (group.at[index - 1] ?? 0));
    }

    const usual = median(gaps);

    if (usual < MIN_INTERVAL_MS || usual > MAX_INTERVAL_MS) {
      continue;
    }

    // How much the gaps vary, against how long they are. A rhythm that is not
    // regular is not a rhythm, and this is the test that keeps a favourite
    // restaurant out of a restocking list.
    const spread = median(gaps.map((gap) => Math.abs(gap - usual))) / usual;

    if (spread > MAX_IRREGULARITY) {
      continue;
    }

    const last = group.at[group.at.length - 1] ?? 0;
    const since = context.now - last;

    if (since < usual * OVERDUE_FACTOR) {
      continue;
    }

    // Long past the point of being useful. Something bought every two weeks and
    // last bought a year ago is not overdue, it is finished.
    if (since > usual * 6) {
      continue;
    }

    const written = recordObservation(db, {
      principalId: context.principalId,
      detectorId: "purchase_due",
      // Keyed to the week, so an overdue rhythm is mentioned once rather than
      // every time the pass runs.
      dedupKey: `purchase_due:${merchantKey(group.name)}:${String(
        Math.floor(context.now / (7 * 86_400_000)),
      )}`,
      title:
        `You buy from ${group.name} about every ${describeDays(usual)}, ` +
        `and it has been ${describeDays(since)}`,
      detail: `${String(group.at.length)} purchases on record, most recently ${describeDays(since)} ago`,
      // Modest on purpose. This is a suggestion, and it should never outrank a
      // commitment that is actually due.
      salience: 0.4,
      evidence: group.items.slice(-3),
      earliestUsefulAt: context.now,
      expiresAt: context.now + Math.min(usual, 21 * 86_400_000),
    });

    if (written) {
      created += 1;
    }
  }

  return { detectorId: "purchase_due", examined: groups.size, created, resolved: 0 };
}
