/**
 * Egress rules.
 *
 * "External models receive only the minimum information necessary" is a policy,
 * not a property. This file is where it stops being a sentence in a README.
 *
 * Ordered by priority, first match wins. Built-in rules are seeded on migration
 * and can be disabled or overridden but not deleted, so a bad edit degrades to
 * the defaults rather than to no policy at all.
 */
import type { DB } from "../kernel/db.js";
import type { Sensitivity } from "./classify.js";

export type Egress = "local_only" | "redacted" | "allowed";
export type Confirm = "never" | "first_time" | "always";

export interface PolicyRule {
  readonly id: string;
  readonly priority: number;
  readonly matchKind: string | null;
  readonly matchSensitivity: Sensitivity | null;
  readonly matchEntity: string | null;
  readonly matchPattern: string | null;
  readonly egress: Egress;
  readonly confirm: Confirm;
  readonly note: string | null;
  readonly builtin: boolean;
  readonly enabled: boolean;
}

interface RuleRow {
  readonly id: string;
  readonly priority: number;
  readonly match_kind: string | null;
  readonly match_sensitivity: Sensitivity | null;
  readonly match_entity: string | null;
  readonly match_pattern: string | null;
  readonly egress: Egress;
  readonly confirm: Confirm;
  readonly note: string | null;
  readonly builtin: number;
  readonly enabled: number;
}

function hydrate(row: RuleRow): PolicyRule {
  return {
    id: row.id,
    priority: row.priority,
    matchKind: row.match_kind,
    matchSensitivity: row.match_sensitivity,
    matchEntity: row.match_entity,
    matchPattern: row.match_pattern,
    egress: row.egress,
    confirm: row.confirm,
    note: row.note,
    builtin: row.builtin === 1,
    enabled: row.enabled === 1,
  };
}

/**
 * The defaults.
 *
 * Restricted never leaves under any circumstances, which is why it is priority
 * zero and why nothing below it can widen it. Sensitive is redacted rather than
 * withheld: a redacted medical appointment still lets Harbor tell you the
 * appointment exists, which is usually the useful part, without shipping the
 * diagnosis to a third party.
 */
const BUILTIN_RULES: readonly Omit<PolicyRule, "builtin" | "enabled">[] = [
  {
    id: "builtin.restricted",
    priority: 0,
    matchKind: null,
    matchSensitivity: "restricted",
    matchEntity: null,
    matchPattern: null,
    egress: "local_only",
    confirm: "always",
    note: "Live secrets never leave the machine.",
  },
  {
    id: "builtin.sensitive",
    priority: 10,
    matchKind: null,
    matchSensitivity: "sensitive",
    matchEntity: null,
    matchPattern: null,
    egress: "redacted",
    confirm: "never",
    note: "Financial, medical, and legal material goes out with identifiers removed.",
  },
  {
    id: "builtin.default",
    priority: 1000,
    matchKind: null,
    matchSensitivity: null,
    matchEntity: null,
    matchPattern: null,
    egress: "allowed",
    confirm: "never",
    note: "Everything else.",
  },
];

export function seedBuiltinRules(db: DB): number {
  const insert = db.prepare(
    `INSERT INTO policy_rules
       (id, priority, match_kind, match_sensitivity, match_entity, match_pattern,
        egress, confirm, note, builtin, enabled, created_at)
     VALUES (@id, @priority, @matchKind, @matchSensitivity, @matchEntity, @matchPattern,
             @egress, @confirm, @note, 1, 1, @now)
     ON CONFLICT (id) DO NOTHING`,
  );

  let added = 0;

  for (const rule of BUILTIN_RULES) {
    const result = insert.run({ ...rule, now: Date.now() });
    added += result.changes;
  }

  return added;
}

export function listRules(db: DB, includeDisabled = false): readonly PolicyRule[] {
  const rows = (
    includeDisabled
      ? db.prepare(`SELECT * FROM policy_rules ORDER BY priority, id`).all()
      : db.prepare(`SELECT * FROM policy_rules WHERE enabled = 1 ORDER BY priority, id`).all()
  ) as RuleRow[];

  return rows.map(hydrate);
}

export function addRule(
  db: DB,
  input: {
    readonly id: string;
    readonly priority: number;
    readonly matchKind?: string | null;
    readonly matchSensitivity?: Sensitivity | null;
    readonly matchEntity?: string | null;
    readonly matchPattern?: string | null;
    readonly egress: Egress;
    readonly confirm?: Confirm;
    readonly note?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO policy_rules
       (id, priority, match_kind, match_sensitivity, match_entity, match_pattern,
        egress, confirm, note, builtin, enabled, created_at)
     VALUES (@id, @priority, @matchKind, @matchSensitivity, @matchEntity, @matchPattern,
             @egress, @confirm, @note, 0, 1, @now)
     ON CONFLICT (id) DO UPDATE SET
       priority = excluded.priority,
       match_kind = excluded.match_kind,
       match_sensitivity = excluded.match_sensitivity,
       match_entity = excluded.match_entity,
       match_pattern = excluded.match_pattern,
       egress = excluded.egress,
       confirm = excluded.confirm,
       note = excluded.note,
       enabled = 1`,
  ).run({
    id: input.id,
    priority: input.priority,
    matchKind: input.matchKind ?? null,
    matchSensitivity: input.matchSensitivity ?? null,
    matchEntity: input.matchEntity ?? null,
    matchPattern: input.matchPattern ?? null,
    egress: input.egress,
    confirm: input.confirm ?? "never",
    note: input.note ?? null,
    now: Date.now(),
  });
}

export function setRuleEnabled(db: DB, id: string, enabled: boolean): void {
  db.prepare(`UPDATE policy_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export function removeRule(db: DB, id: string): boolean {
  const rule = db.prepare(`SELECT builtin FROM policy_rules WHERE id = ?`).get(id) as
    | { builtin: number }
    | undefined;

  if (rule === undefined) {
    return false;
  }

  if (rule.builtin === 1) {
    // Disabled, not deleted. A missing built-in rule is indistinguishable from
    // a policy that was never configured, and that is the wrong failure mode.
    setRuleEnabled(db, id, false);
    return true;
  }

  db.prepare(`DELETE FROM policy_rules WHERE id = ?`).run(id);
  return true;
}

export interface Subject {
  readonly kind: string;
  readonly sensitivity: Sensitivity;
  readonly entityIds: readonly string[];
  readonly text: string;
}

export interface Decision {
  readonly egress: Egress;
  readonly confirm: Confirm;
  readonly ruleId: string;
  readonly note: string | null;
}

/** First matching rule by priority. Always returns something: the default matches all. */
export function evaluate(rules: readonly PolicyRule[], subject: Subject): Decision {
  for (const rule of rules) {
    if (rule.matchKind !== null && rule.matchKind !== subject.kind) {
      continue;
    }

    if (rule.matchSensitivity !== null && rule.matchSensitivity !== subject.sensitivity) {
      continue;
    }

    if (rule.matchEntity !== null && !subject.entityIds.includes(rule.matchEntity)) {
      continue;
    }

    if (rule.matchPattern !== null) {
      let matches = false;

      try {
        matches = new RegExp(rule.matchPattern, "i").test(subject.text);
      } catch {
        // A malformed user rule must not deny everything or allow everything.
        // Skipping it falls through to the next rule, which is the safe read.
        continue;
      }

      if (!matches) {
        continue;
      }
    }

    return { egress: rule.egress, confirm: rule.confirm, ruleId: rule.id, note: rule.note };
  }

  return {
    egress: "local_only",
    confirm: "always",
    ruleId: "implicit.deny",
    note: "No rule matched, which should be impossible. Denying.",
  };
}
