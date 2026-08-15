/**
 * Projections: structured facts pulled out of items.
 *
 * The layer that makes aggregate questions answerable. Retrieval ranks; it
 * cannot sum. "What did I spend at the grocery store in July" needs records
 * with a merchant, a date, and an amount, and nothing else in the store has
 * those shapes.
 *
 * Deliberately generic. Purchases are the first type and the table knows almost
 * nothing about them: a handful of columns that any commercial fact has
 * (merchant, currency, total, reference) hoisted out of the payload because
 * they are what people aggregate on, and everything else left as JSON. A second
 * type should not need a migration.
 *
 * A projection is always tied to the item it came from. That is what keeps it
 * checkable: the answer to "why does Harbor think I spent this" is the email,
 * one lookup away, and re-deriving after a fixed extractor is a matter of
 * clearing the version column, exactly as every other derived layer works.
 */
import { displayMerchant, merchantKey, sameMerchant } from "../projections/merchants.js";
import { createHash } from "node:crypto";
import type { DB } from "../kernel/db.js";

export interface ProjectionLine {
  readonly ordinal: number;
  readonly description: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly amountCents: number | null;
}

export interface Projection {
  readonly id: string;
  readonly itemId: string;
  readonly type: string;
  readonly occurredAt: number;
  readonly merchant: string | null;
  readonly currency: string | null;
  readonly totalCents: number | null;
  readonly reference: string | null;
  readonly payload: Record<string, unknown>;
  readonly confidence: number;
  readonly model: string | null;
}

interface ProjectionRow {
  readonly id: string;
  readonly item_id: string;
  readonly type: string;
  readonly occurred_at: number;
  readonly merchant: string | null;
  readonly currency: string | null;
  readonly total_cents: number | null;
  readonly reference: string | null;
  readonly payload: string;
  readonly confidence: number;
  readonly model: string | null;
}

function hydrate(row: ProjectionRow): Projection {
  return {
    id: row.id,
    itemId: row.item_id,
    type: row.type,
    occurredAt: row.occurred_at,
    merchant: row.merchant,
    currency: row.currency,
    totalCents: row.total_cents,
    reference: row.reference,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    confidence: row.confidence,
    model: row.model,
  };
}

export interface ProjectionInput {
  readonly principalId: string;
  readonly itemId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly occurredAt: number;
  readonly merchant?: string | null;
  readonly currency?: string | null;
  readonly totalCents?: number | null;
  readonly reference?: string | null;
  readonly payload: Record<string, unknown>;
  readonly confidence: number;
  readonly model?: string | null;
  readonly lines?: readonly Omit<ProjectionLine, "ordinal">[];
}

/**
 * Writes a projection, replacing any previous one of the same type for the
 * same item.
 *
 * Replacement rather than accumulation, because an item has one truth per type:
 * re-extracting a receipt after fixing the extractor should correct the record,
 * not leave two versions of the same purchase to be double-counted in a sum.
 */
export function saveProjection(db: DB, input: ProjectionInput): string {
  const id = `pj_${createHash("sha256")
    .update(`${input.itemId}|${input.type}`)
    .digest("hex")
    .slice(0, 16)}`;

  const now = Date.now();

  const write = db.transaction(() => {
    db.prepare(`DELETE FROM projection_lines WHERE projection_id = ?`).run(id);

    db.prepare(
      `INSERT INTO projections
         (id, principal_id, item_id, type, schema_version, occurred_at, merchant, currency,
          total_cents, reference, payload, confidence, model, created_at)
       VALUES (@id, @principal, @itemId, @type, @schemaVersion, @occurredAt, @merchant,
               @currency, @totalCents, @reference, @payload, @confidence, @model, @now)
       ON CONFLICT (id) DO UPDATE SET
         schema_version = excluded.schema_version,
         occurred_at = excluded.occurred_at,
         merchant = excluded.merchant,
         currency = excluded.currency,
         total_cents = excluded.total_cents,
         reference = excluded.reference,
         payload = excluded.payload,
         confidence = excluded.confidence,
         model = excluded.model`,
    ).run({
      id,
      principal: input.principalId,
      itemId: input.itemId,
      type: input.type,
      schemaVersion: input.schemaVersion,
      occurredAt: input.occurredAt,
      merchant: input.merchant ?? null,
      currency: input.currency ?? null,
      totalCents: input.totalCents ?? null,
      reference: input.reference ?? null,
      payload: JSON.stringify(input.payload),
      confidence: input.confidence,
      model: input.model ?? null,
      now,
    });

    const insertLine = db.prepare(
      `INSERT INTO projection_lines
         (id, projection_id, ordinal, description, quantity, unit, amount_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    (input.lines ?? []).forEach((line, ordinal) => {
      insertLine.run(
        `${id}:${String(ordinal)}`,
        id,
        ordinal,
        line.description,
        line.quantity,
        line.unit,
        line.amountCents,
      );
    });
  });

  write();

  return id;
}

export function linesFor(db: DB, projectionId: string): readonly ProjectionLine[] {
  const rows = db
    .prepare(
      `SELECT ordinal, description, quantity, unit, amount_cents FROM projection_lines
       WHERE projection_id = ? ORDER BY ordinal`,
    )
    .all(projectionId) as {
    ordinal: number;
    description: string;
    quantity: number | null;
    unit: string | null;
    amount_cents: number | null;
  }[];

  return rows.map((row) => ({
    ordinal: row.ordinal,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    amountCents: row.amount_cents,
  }));
}

export interface ProjectionQuery {
  readonly principalId: string;
  readonly type: string;
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  readonly merchant?: string | undefined;
  readonly limit?: number | undefined;
}

export function listProjections(db: DB, query: ProjectionQuery): readonly Projection[] {
  const where = [`principal_id = @principal`, `type = @type`];
  const bind: Record<string, unknown> = {
    principal: query.principalId,
    type: query.type,
    limit: query.limit ?? 50,
  };

  if (query.since !== undefined) {
    where.push(`occurred_at >= @since`);
    bind["since"] = query.since;
  }

  if (query.until !== undefined) {
    where.push(`occurred_at <= @until`);
    bind["until"] = query.until;
  }

  if (query.merchant !== undefined) {
    where.push(`merchant LIKE @merchant`);
    bind["merchant"] = `%${query.merchant}%`;
  }

  const rows = db
    .prepare(
      `SELECT * FROM projections WHERE ${where.join(" AND ")}
       ORDER BY occurred_at DESC LIMIT @limit`,
    )
    .all(bind) as ProjectionRow[];

  return rows.map(hydrate);
}

export interface SpendRow {
  readonly merchant: string;
  readonly count: number;
  readonly totalCents: number;
  readonly currency: string | null;
}

/**
 * The query the whole layer exists for.
 *
 * Rows with no total are excluded rather than counted as zero: a receipt Harbor
 * could not read an amount from should make a sum smaller by being absent, not
 * silently correct-looking by being nothing.
 */
/**
 * The same purchase, arriving twice.
 *
 * An order confirmation and then a receipt with tax: PGA TOUR Superstore,
 * "LM1 Launch Monitor", $199.99 at midnight and $211.99 at nine the next
 * morning. Two emails, one launch monitor, and a spending report that says you
 * bought two.
 *
 * The later record wins, because it is the one with tax and shipping on it. The
 * window is a day and a half, which covers overnight confirmations without
 * merging a Tuesday coffee into a Wednesday one, and totals must be within a
 * quarter of each other so a genuine repeat order at the same price is still
 * two purchases only when it is far enough apart in time.
 */
const DUPLICATE_WINDOW_MS = 36 * 3_600_000;

export function dedupePurchases(
  rows: readonly { merchant: string | null; occurredAt: number; totalCents: number | null }[],
): readonly number[] {
  const keep: number[] = [];
  const chosen: { merchant: string; at: number; cents: number }[] = [];

  // Newest first, so the survivor of a pair is the later, richer record.
  const order = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.occurredAt - a.row.occurredAt);

  for (const { row, index } of order) {
    if (row.merchant === null || row.totalCents === null) {
      keep.push(index);
      continue;
    }

    const duplicate = chosen.some(
      (entry) =>
        sameMerchant(entry.merchant, row.merchant ?? "") &&
        Math.abs(entry.at - row.occurredAt) <= DUPLICATE_WINDOW_MS &&
        Math.abs(entry.cents - (row.totalCents ?? 0)) <= Math.max(entry.cents, 1) * 0.25,
    );

    if (duplicate) {
      continue;
    }

    chosen.push({ merchant: row.merchant, at: row.occurredAt, cents: row.totalCents });
    keep.push(index);
  }

  return keep.sort((a, b) => a - b);
}

export function spendByMerchant(
  db: DB,
  principalId: string,
  since: number,
  until: number,
): readonly SpendRow[] {
  // Grouped here rather than in SQL, because "the same merchant" is not string
  // equality. `GEEKSQUAD` and `GEEK SQUAD` were separate rows, and so were
  // three spellings of one pizza place, one of them truncated by a column
  // width. Spending by merchant is the entire point of this function and it was
  // splitting the answer three ways.
  const rows = db
    .prepare(
      `SELECT merchant, occurred_at AS occurredAt, total_cents AS totalCents, currency
       FROM projections
       WHERE principal_id = @principal AND type = 'purchase'
         AND total_cents IS NOT NULL
         AND occurred_at BETWEEN @since AND @until
       ORDER BY occurred_at DESC`,
    )
    .all({ principal: principalId, since, until }) as {
    merchant: string | null;
    occurredAt: number;
    totalCents: number;
    currency: string | null;
  }[];

  const kept = new Set(dedupePurchases(rows));

  const groups = new Map<
    string,
    { names: string[]; count: number; total: number; currency: string | null }
  >();

  for (const [index, row] of rows.entries()) {
    if (!kept.has(index)) {
      continue;
    }

    const name = row.merchant ?? "unknown";
    const key = row.merchant === null ? "unknown" : merchantKey(row.merchant);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, {
        names: [name],
        count: 1,
        total: row.totalCents,
        currency: row.currency,
      });
      continue;
    }

    existing.names.push(name);
    existing.count += 1;
    existing.total += row.totalCents;
    existing.currency = existing.currency ?? row.currency;
  }

  return [...groups.values()]
    .map((group) => ({
      merchant: displayMerchant(group.names),
      count: group.count,
      totalCents: group.total,
      currency: group.currency,
    }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

export function countProjections(db: DB, type: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM projections WHERE type = ?`).get(type) as { n: number }
  ).n;
}

export function projectionForItem(db: DB, itemId: string, type: string): Projection | null {
  const row = db
    .prepare(`SELECT * FROM projections WHERE item_id = ? AND type = ?`)
    .get(itemId, type) as ProjectionRow | undefined;

  return row === undefined ? null : hydrate(row);
}
