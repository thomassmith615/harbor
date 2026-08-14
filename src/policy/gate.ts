/**
 * The gate.
 *
 * One function every item passes through on its way to a model. Policy decides
 * what may leave, redaction removes what may not, and the caller gets back both
 * the payload and an accounting of what happened to it.
 *
 * There is deliberately exactly one of these. A second chokepoint is how the
 * first one gets bypassed, and a policy layer with a bypass is theatre.
 */
import { evaluate, listRules } from "./rules.js";
import { byteLength, redact } from "./redact.js";
import type { DB } from "../kernel/db.js";
import type { Sensitivity } from "./classify.js";
import type { Confirm, Decision, PolicyRule } from "./rules.js";

export interface GateItem {
  readonly id: string;
  readonly kind: string;
  readonly sensitivity: Sensitivity;
  readonly entityIds: readonly string[];
  /** Everything about this item that would reach a model. */
  readonly text: string;
}

export interface GateOutcome<T> {
  readonly value: T | null;
  readonly decision: Decision;
  readonly redactions: number;
  readonly withheld: boolean;
}

export interface GateSummary {
  readonly included: number;
  readonly withheld: number;
  readonly redactions: number;
  readonly bytesOut: number;
  readonly ruleIds: readonly string[];
  readonly confirmRequired: Confirm;
}

export class Gate {
  private readonly rules: readonly PolicyRule[];

  private included = 0;
  private withheld = 0;
  private redactions = 0;
  private bytesOut = 0;
  private readonly ruleIds = new Set<string>();
  private confirm: Confirm = "never";

  constructor(rules: readonly PolicyRule[]) {
    this.rules = rules;
  }

  static open(db: DB): Gate {
    return new Gate(listRules(db));
  }

  /**
   * Runs one item through policy.
   *
   * `render` produces the payload from possibly-redacted text, so callers can
   * shape their own structures without the gate knowing about them. It is not
   * called at all when the decision is to withhold, which means a `local_only`
   * item cannot leak through a caller that forgot to check the flag.
   */
  admit<T>(item: GateItem, render: (text: string) => T): GateOutcome<T> {
    const decision = evaluate(this.rules, {
      kind: item.kind,
      sensitivity: item.sensitivity,
      entityIds: item.entityIds,
      text: item.text,
    });

    this.ruleIds.add(decision.ruleId);

    if (decision.confirm === "always") {
      this.confirm = "always";
    } else if (decision.confirm === "first_time" && this.confirm === "never") {
      this.confirm = "first_time";
    }

    if (decision.egress === "local_only") {
      this.withheld += 1;
      return { value: null, decision, redactions: 0, withheld: true };
    }

    if (decision.egress === "redacted") {
      const result = redact(item.text);
      this.redactions += result.total;
      this.included += 1;
      this.bytesOut += byteLength(result.text);

      return {
        value: render(result.text),
        decision,
        redactions: result.total,
        withheld: false,
      };
    }

    this.included += 1;
    this.bytesOut += byteLength(item.text);

    return { value: render(item.text), decision, redactions: 0, withheld: false };
  }

  /** Counts bytes that were never item text: a prompt, a question, a tool schema. */
  countOverhead(text: string): void {
    this.bytesOut += byteLength(text);
  }

  summary(): GateSummary {
    return {
      included: this.included,
      withheld: this.withheld,
      redactions: this.redactions,
      bytesOut: this.bytesOut,
      ruleIds: [...this.ruleIds],
      confirmRequired: this.confirm,
    };
  }
}

/**
 * A short line the model is told when something was held back.
 *
 * Silence would be worse than the withholding: a model that does not know it is
 * missing items will answer as though it saw everything, and the user has no
 * way to tell the difference.
 */
export function withholdingNotice(summary: GateSummary): string | null {
  if (summary.withheld === 0 && summary.redactions === 0) {
    return null;
  }

  const parts: string[] = [];

  if (summary.withheld > 0) {
    parts.push(
      `${String(summary.withheld)} item${summary.withheld === 1 ? "" : "s"} withheld by policy`,
    );
  }

  if (summary.redactions > 0) {
    parts.push(
      `${String(summary.redactions)} value${summary.redactions === 1 ? "" : "s"} redacted`,
    );
  }

  return `${parts.join(", ")}. Say so if it affects the answer; do not guess at what was removed.`;
}
