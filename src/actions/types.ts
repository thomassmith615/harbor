/**
 * Write actions.
 *
 * Everything Harbor does to the outside world goes through here, and the shape
 * is always the same four steps:
 *
 *   propose -> approve -> execute -> verify
 *
 * Nothing skips a step, and in particular nothing a model asks for executes
 * without a human saying yes. Reads are recoverable: a wrong answer is
 * annoying and you move on. Writes are not. "The model cancelled it" is not a
 * failure you can undo by asking again, so the approval gate is structural
 * rather than a setting.
 *
 * The fourth step is the one usually left out. An API returning 200 is not the
 * same as the thing having happened, so every action declares how to check, and
 * the check runs against the source rather than against our own optimism.
 */
import { createHash, randomUUID } from "node:crypto";
import { record } from "../store/audit.js";
import type { DB } from "../kernel/db.js";

export type ActionState = "pending" | "approved" | "rejected" | "executed" | "failed";
export type VerificationResult = "passed" | "failed" | "skipped";

export interface ActionSpec {
  readonly id: string;
  readonly connectorId: string;
  readonly description: string;
  /** OAuth scopes this action needs beyond read access. */
  readonly scopes: readonly string[];
  /** Renders a one-line human summary from the arguments, for the approval prompt. */
  summarize(args: Record<string, unknown>): string;
  /** Performs the write. Returns an id the verifier can look up. */
  execute(
    context: ActionContext,
    args: Record<string, unknown>,
  ): Promise<{ readonly externalId: string; readonly detail: string }>;
  /**
   * Reads the result back from the source and confirms it matches.
   *
   * Returning false is a real outcome, not an error: it means the write
   * reported success and did not take effect, which is exactly the failure
   * worth catching.
   */
  verify(
    context: ActionContext,
    args: Record<string, unknown>,
    externalId: string,
  ): Promise<boolean>;
}

export interface ActionContext {
  readonly token: string;
  readonly accountId: string;
  readonly timezone: string;
}

export interface PendingAction {
  readonly id: string;
  readonly principalId: string;
  readonly connectorId: string;
  readonly action: string;
  readonly args: Record<string, unknown>;
  readonly summary: string;
  readonly state: ActionState;
  readonly requestedBy: string | null;
  readonly verification: VerificationResult | null;
  readonly externalId: string | null;
  readonly result: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

interface ActionRow {
  readonly id: string;
  readonly principal_id: string;
  readonly connector_id: string;
  readonly action: string;
  readonly args: string;
  readonly summary: string;
  readonly state: ActionState;
  readonly requested_by: string | null;
  readonly verification: VerificationResult | null;
  readonly external_id: string | null;
  readonly result: string | null;
  readonly created_at: number;
  readonly expires_at: number | null;
}

function hydrate(row: ActionRow): PendingAction {
  return {
    id: row.id,
    principalId: row.principal_id,
    connectorId: row.connector_id,
    action: row.action,
    args: JSON.parse(row.args) as Record<string, unknown>,
    summary: row.summary,
    state: row.state,
    requestedBy: row.requested_by,
    verification: row.verification,
    externalId: row.external_id,
    result: row.result,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Proposals go stale. An approval three days later is not the same decision. */
const PROPOSAL_TTL_HOURS = 24;

export function propose(
  db: DB,
  input: {
    readonly principalId: string;
    readonly spec: ActionSpec;
    readonly args: Record<string, unknown>;
    readonly requestedBy: string;
  },
): PendingAction {
  const id = `a_${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO pending_actions
       (id, principal_id, connector_id, action, args, summary, state, requested_by,
        created_at, expires_at)
     VALUES (@id, @principalId, @connectorId, @action, @args, @summary, 'pending',
             @requestedBy, @now, @expires)`,
  ).run({
    id,
    principalId: input.principalId,
    connectorId: input.spec.connectorId,
    action: input.spec.id,
    args: JSON.stringify(input.args),
    summary: input.spec.summarize(input.args),
    requestedBy: input.requestedBy,
    now,
    expires: now + PROPOSAL_TTL_HOURS * 3_600_000,
  });

  const action = getAction(db, id);

  if (action === null) {
    throw new Error(`Action ${id} vanished immediately after being written`);
  }

  return action;
}

export function getAction(db: DB, id: string): PendingAction | null {
  const row = db.prepare(`SELECT * FROM pending_actions WHERE id = ?`).get(id) as
    | ActionRow
    | undefined;

  return row === undefined ? null : hydrate(row);
}

export function listActions(db: DB, state?: ActionState, limit = 20): readonly PendingAction[] {
  const rows = (
    state === undefined
      ? db.prepare(`SELECT * FROM pending_actions ORDER BY created_at DESC LIMIT ?`).all(limit)
      : db
          .prepare(
            `SELECT * FROM pending_actions WHERE state = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(state, limit)
  ) as ActionRow[];

  return rows.map(hydrate);
}

export function reject(db: DB, id: string): void {
  db.prepare(`UPDATE pending_actions SET state = 'rejected', decided_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

export interface ExecuteReport {
  readonly action: PendingAction;
  readonly externalId: string | null;
  readonly detail: string;
  readonly verification: VerificationResult;
}

/**
 * Approves and runs one action.
 *
 * Verification failure does not roll anything back, because most sources have
 * no transaction to roll back to. It is recorded and reported, which is the
 * honest outcome: something happened upstream that we cannot confirm, and you
 * need to know that rather than be told it worked.
 */
export async function approveAndExecute(
  db: DB,
  id: string,
  spec: ActionSpec,
  context: ActionContext,
): Promise<ExecuteReport> {
  const action = getAction(db, id);

  if (action === null) {
    throw new Error(`No action ${id}`);
  }

  if (action.state !== "pending") {
    throw new Error(`Action ${id} is ${action.state}, not pending`);
  }

  if (action.expiresAt !== null && action.expiresAt < Date.now()) {
    db.prepare(`UPDATE pending_actions SET state = 'rejected', decided_at = ? WHERE id = ?`).run(
      Date.now(),
      id,
    );

    throw new Error(
      `Action ${id} expired. Proposals are only good for ${String(PROPOSAL_TTL_HOURS)} hours; ` +
        "re-propose it rather than approving a stale decision.",
    );
  }

  db.prepare(`UPDATE pending_actions SET state = 'approved', decided_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );

  let externalId: string;
  let detail: string;

  try {
    const result = await spec.execute(context, action.args);
    externalId = result.externalId;
    detail = result.detail;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    db.prepare(
      `UPDATE pending_actions SET state = 'failed', executed_at = ?, result = ? WHERE id = ?`,
    ).run(Date.now(), message.slice(0, 500), id);

    record(db, {
      principalId: action.principalId,
      kind: "action",
      taskClass: action.action,
      outcome: "error",
      note: message.slice(0, 300),
    });

    throw error;
  }

  let verification: VerificationResult = "skipped";

  try {
    verification = (await spec.verify(context, action.args, externalId)) ? "passed" : "failed";
  } catch {
    verification = "skipped";
  }

  db.prepare(
    `UPDATE pending_actions
     SET state = 'executed', executed_at = ?, external_id = ?, result = ?, verification = ?
     WHERE id = ?`,
  ).run(Date.now(), externalId, detail.slice(0, 500), verification, id);

  record(db, {
    principalId: action.principalId,
    kind: "action",
    taskClass: action.action,
    outcome: verification === "failed" ? "error" : "ok",
    note: `${action.summary} [verification: ${verification}]`,
  });

  const updated = getAction(db, id);

  return {
    action: updated ?? action,
    externalId,
    detail,
    verification,
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
