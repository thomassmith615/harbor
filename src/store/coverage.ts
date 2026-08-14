/**
 * Coverage: what the store actually holds.
 *
 * This exists because the most dangerous answer Harbor can give is a confident
 * one drawn from an incomplete window. With a hundred messages ingested,
 * "what did I promise last week" produces a fluent, well-sourced, wrong answer
 * and nothing anywhere says why.
 *
 * So coverage travels with search results. The model is told the boundaries of
 * what it can see and is instructed to say when a question reaches past them.
 */
import type { DB } from "../kernel/db.js";

export interface KindCoverage {
  readonly kind: string;
  readonly count: number;
  readonly oldest: number | null;
  readonly newest: number | null;
}

export interface Coverage {
  readonly items: number;
  readonly oldest: number | null;
  readonly newest: number | null;
  readonly inbound: number;
  readonly outbound: number;
  /** True when a completed backfill exists for every account in scope. */
  readonly complete: boolean;
}

interface CoverageRow {
  readonly n: number;
  readonly oldest: number | null;
  readonly newest: number | null;
  readonly inbound: number;
  readonly outbound: number;
}

export function coverageFor(
  db: DB,
  principal: string,
  kinds?: readonly string[],
): Coverage {
  const bind: Record<string, unknown> = { principal };
  let kindClause = "";

  if (kinds !== undefined && kinds.length > 0) {
    const placeholders = kinds.map((_, index) => `@kind${String(index)}`);
    kindClause = ` AND i.kind IN (${placeholders.join(", ")})`;
    kinds.forEach((kind, index) => {
      bind[`kind${String(index)}`] = kind;
    });
  }

  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS n,
         MIN(i.occurred_at) AS oldest,
         MAX(i.occurred_at) AS newest,
         SUM(CASE WHEN i.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
         SUM(CASE WHEN i.direction = 'outbound' THEN 1 ELSE 0 END) AS outbound
       FROM items i
       JOIN accounts a ON a.id = i.account_id
       WHERE i.deleted_at IS NULL
         AND (a.custodian_person_id = @principal OR i.visibility = 'household')
         ${kindClause}`,
    )
    .get(bind) as CoverageRow;

  // Complete means every stream has finished a backfill, not every account.
  // With two connectors under one credential, an account can be half ingested.
  const streams = db
    .prepare(
      `SELECT COUNT(*) AS n FROM streams s
       JOIN accounts a ON a.id = s.account_id
       WHERE a.custodian_person_id = @principal`,
    )
    .get({ principal }) as { n: number };

  const backfilled = db
    .prepare(
      `SELECT COUNT(DISTINCT s.stream_id) AS n
       FROM sync_runs s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.mode = 'backfill' AND s.state = 'complete'
         AND a.custodian_person_id = @principal`,
    )
    .get({ principal }) as { n: number };

  return {
    items: row.n,
    oldest: row.oldest,
    newest: row.newest,
    inbound: row.inbound ?? 0,
    outbound: row.outbound ?? 0,
    complete: streams.n > 0 && backfilled.n >= streams.n,
  };
}

/** Per-kind breakdown, so an answer can say "mail back to 2019, calendar to 2023". */
export function coverageByKind(db: DB, principal: string): readonly KindCoverage[] {
  return db
    .prepare(
      `SELECT i.kind AS kind, COUNT(*) AS count,
              MIN(i.occurred_at) AS oldest, MAX(i.occurred_at) AS newest
       FROM items i
       JOIN accounts a ON a.id = i.account_id
       WHERE i.deleted_at IS NULL
         AND (a.custodian_person_id = @principal OR i.visibility = 'household')
       GROUP BY i.kind
       ORDER BY i.kind`,
    )
    .all({ principal }) as KindCoverage[];
}

export function databaseSize(db: DB): number {
  const page = db.pragma("page_count", { simple: true }) as number;
  const size = db.pragma("page_size", { simple: true }) as number;
  return page * size;
}

export interface RawStats {
  readonly rawBytes: number;
  readonly bodyBytes: number;
  readonly gzipRows: number;
  readonly plainRows: number;
}

/** Where the space actually went. Answers "is compression working". */
export function rawStats(db: DB): RawStats {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(LENGTH(raw)), 0) AS rawBytes,
         COALESCE(SUM(LENGTH(COALESCE(body, ''))), 0) AS bodyBytes,
         SUM(CASE WHEN raw_encoding = 'gzip' THEN 1 ELSE 0 END) AS gzipRows,
         SUM(CASE WHEN raw_encoding <> 'gzip' THEN 1 ELSE 0 END) AS plainRows
       FROM items`,
    )
    .get() as RawStats;

  return {
    rawBytes: row.rawBytes,
    bodyBytes: row.bodyBytes,
    gzipRows: row.gzipRows ?? 0,
    plainRows: row.plainRows ?? 0,
  };
}
