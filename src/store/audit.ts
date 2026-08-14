/**
 * The audit log.
 *
 * Every model call, every policy denial, and eventually every action lands
 * here. This is the table that turns "your data belongs to you" from a claim
 * into something you can query, and it is deliberately append-only: there is no
 * update path and no delete path in this file.
 */
import type { DB } from "../kernel/db.js";

export type AuditKind = "model_call" | "policy_denial" | "action";
export type AuditOutcome = "ok" | "error" | "denied";

export interface AuditEntry {
  readonly principalId: string;
  readonly kind: AuditKind;
  readonly taskClass?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly tier?: string | null;
  readonly itemIds?: readonly string[];
  readonly itemsIncluded?: number;
  readonly itemsWithheld?: number;
  readonly redactions?: number;
  readonly bytesOut?: number;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly costMicros?: number | null;
  readonly ruleIds?: readonly string[];
  readonly outcome: AuditOutcome;
  readonly note?: string | null;
}

export function record(db: DB, entry: AuditEntry): number {
  const result = db
    .prepare(
      `INSERT INTO audit_log
         (at, principal_id, kind, task_class, provider, model, tier, item_ids,
          items_included, items_withheld, redactions, bytes_out, input_tokens,
          output_tokens, cost_micros, rule_ids, outcome, note)
       VALUES (@at, @principalId, @kind, @taskClass, @provider, @model, @tier, @itemIds,
               @itemsIncluded, @itemsWithheld, @redactions, @bytesOut, @inputTokens,
               @outputTokens, @costMicros, @ruleIds, @outcome, @note)`,
    )
    .run({
      at: Date.now(),
      principalId: entry.principalId,
      kind: entry.kind,
      taskClass: entry.taskClass ?? null,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      tier: entry.tier ?? null,
      itemIds: entry.itemIds === undefined ? null : JSON.stringify(entry.itemIds),
      itemsIncluded: entry.itemsIncluded ?? 0,
      itemsWithheld: entry.itemsWithheld ?? 0,
      redactions: entry.redactions ?? 0,
      bytesOut: entry.bytesOut ?? 0,
      inputTokens: entry.inputTokens ?? null,
      outputTokens: entry.outputTokens ?? null,
      costMicros: entry.costMicros ?? null,
      ruleIds: entry.ruleIds === undefined ? null : JSON.stringify(entry.ruleIds),
      outcome: entry.outcome,
      note: entry.note ?? null,
    });

  return Number(result.lastInsertRowid);
}

export interface AuditRow {
  readonly id: number;
  readonly at: number;
  readonly kind: AuditKind;
  readonly task_class: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly tier: string | null;
  readonly items_included: number;
  readonly items_withheld: number;
  readonly redactions: number;
  readonly bytes_out: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost_micros: number | null;
  readonly outcome: AuditOutcome;
  readonly note: string | null;
  readonly item_ids: string | null;
  readonly rule_ids: string | null;
}

export function recent(db: DB, limit: number, kind?: AuditKind): readonly AuditRow[] {
  return (
    kind === undefined
      ? db.prepare(`SELECT * FROM audit_log ORDER BY at DESC LIMIT ?`).all(limit)
      : db
          .prepare(`SELECT * FROM audit_log WHERE kind = ? ORDER BY at DESC LIMIT ?`)
          .all(kind, limit)
  ) as AuditRow[];
}

export interface SpendRow {
  readonly taskClass: string;
  readonly tier: string;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly bytesOut: number;
}

/**
 * Spend broken down by task class.
 *
 * A total is not actionable: the only available response to a total is to
 * worry. Knowing that classification cost four dollars and the morning brief
 * cost sixty cents is a decision you can act on.
 */
export function spend(db: DB, since: number): readonly SpendRow[] {
  return db
    .prepare(
      `SELECT
         COALESCE(task_class, 'unknown') AS taskClass,
         COALESCE(tier, 'unknown') AS tier,
         COALESCE(model, 'unknown') AS model,
         COUNT(*) AS calls,
         COALESCE(SUM(input_tokens), 0) AS inputTokens,
         COALESCE(SUM(output_tokens), 0) AS outputTokens,
         COALESCE(SUM(cost_micros), 0) AS costMicros,
         COALESCE(SUM(bytes_out), 0) AS bytesOut
       FROM audit_log
       WHERE kind = 'model_call' AND at >= ?
       GROUP BY taskClass, tier, model
       ORDER BY costMicros DESC`,
    )
    .all(since) as SpendRow[];
}

export interface EgressSummary {
  readonly itemsIncluded: number;
  readonly itemsWithheld: number;
  readonly redactions: number;
  readonly bytesOut: number;
  readonly calls: number;
}

export function egressSince(db: DB, since: number): EgressSummary {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(items_included), 0) AS itemsIncluded,
         COALESCE(SUM(items_withheld), 0) AS itemsWithheld,
         COALESCE(SUM(redactions), 0) AS redactions,
         COALESCE(SUM(bytes_out), 0) AS bytesOut,
         COUNT(*) AS calls
       FROM audit_log WHERE kind = 'model_call' AND at >= ?`,
    )
    .get(since) as EgressSummary;

  return row;
}
