/**
 * Conversations.
 *
 * Two decisions worth naming, because both are the kind that look arbitrary and
 * are not.
 *
 * **Recent turns verbatim, older turns summarized.** Replaying everything makes
 * each question in a long conversation cost more than the last until it stops
 * working. Dropping old turns loses the thread. A watermark plus a rolling
 * summary keeps the cost flat and the thread intact, and the summary is written
 * by the cheapest tier that can do it.
 *
 * **Continuity is time-bounded.** Picking up a thread from three days ago and
 * treating it as live produces answers anchored to a context the person has
 * forgotten. After a few hours idle, the next question starts fresh, and the
 * old conversation is still there to name explicitly.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "../kernel/db.js";

/** How long a conversation stays the active one without a new turn. */
export const IDLE_HOURS = 4;

/** Turns kept verbatim before the older ones roll into the summary. */
export const VERBATIM_TURNS = 10;

/**
 * Hard ceiling on turns replayed, whatever the summary is doing.
 *
 * Summarization runs on the cheapest tier that can do it, which is normally a
 * local model. If there is no local model server, it fails quietly and forever,
 * and without this cap every question in a long conversation would replay the
 * whole thing and cost more than the last until it stopped working. Dropping
 * the oldest turns loses some context; unbounded growth loses the feature.
 */
export const MAX_REPLAYED_TURNS = 30;

export interface Conversation {
  readonly id: string;
  readonly principalId: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly summarizedThrough: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Turn {
  readonly id: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly evidence: readonly string[];
  readonly toolsUsed: readonly string[];
  readonly model: string | null;
  readonly createdAt: number;
}

interface ConversationRow {
  readonly id: string;
  readonly principal_id: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly summarized_through: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface TurnRow {
  readonly id: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly evidence: string | null;
  readonly tools_used: string | null;
  readonly model: string | null;
  readonly created_at: number;
}

function hydrate(row: ConversationRow): Conversation {
  return {
    id: row.id,
    principalId: row.principal_id,
    title: row.title,
    summary: row.summary,
    summarizedThrough: row.summarized_through,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    evidence: row.evidence === null ? [] : (JSON.parse(row.evidence) as string[]),
    toolsUsed: row.tools_used === null ? [] : (JSON.parse(row.tools_used) as string[]),
    model: row.model,
    createdAt: row.created_at,
  };
}

export function createConversation(db: DB, principalId: string): Conversation {
  const id = `c_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO conversations (id, principal_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, principalId, now, now);

  const conversation = getConversation(db, id);

  if (conversation === null) {
    throw new Error(`Conversation ${id} vanished immediately after being written`);
  }

  return conversation;
}

export function getConversation(db: DB, id: string): Conversation | null {
  const row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
    | ConversationRow
    | undefined;

  return row === undefined ? null : hydrate(row);
}

/**
 * The conversation a bare question belongs to.
 *
 * The most recent one, if it has been touched recently enough to still be the
 * thing the person has in mind. Otherwise a new one.
 */
export function activeConversation(
  db: DB,
  principalId: string,
  now = Date.now(),
): Conversation | null {
  const row = db
    .prepare(
      `SELECT * FROM conversations
       WHERE principal_id = ? AND updated_at > ?
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(principalId, now - IDLE_HOURS * 3_600_000) as ConversationRow | undefined;

  return row === undefined ? null : hydrate(row);
}

export function listConversations(db: DB, principalId: string, limit = 20): readonly Conversation[] {
  const rows = db
    .prepare(
      `SELECT * FROM conversations WHERE principal_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(principalId, limit) as ConversationRow[];

  return rows.map(hydrate);
}

export function appendTurn(
  db: DB,
  conversationId: string,
  input: {
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly evidence?: readonly string[];
    readonly toolsUsed?: readonly string[];
    readonly model?: string | null;
    readonly costMicros?: number | null;
  },
): Turn {
  const next = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turns WHERE conversation_id = ?`)
    .get(conversationId) as { seq: number };

  const id = `t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO turns
       (id, conversation_id, seq, role, content, evidence, tools_used, model, cost_micros, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    conversationId,
    next.seq,
    input.role,
    input.content,
    input.evidence === undefined ? null : JSON.stringify(input.evidence),
    input.toolsUsed === undefined ? null : JSON.stringify(input.toolsUsed),
    input.model ?? null,
    input.costMicros ?? null,
    now,
  );

  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, conversationId);

  // The first thing asked is a better name than anything a model would invent,
  // and it costs nothing.
  if (input.role === "user" && next.seq === 1) {
    db.prepare(`UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL`).run(
      input.content.slice(0, 80),
      conversationId,
    );
  }

  const turn = getTurn(db, id);

  if (turn === null) {
    throw new Error(`Turn ${id} vanished immediately after being written`);
  }

  return turn;
}

function getTurn(db: DB, id: string): Turn | null {
  const row = db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id) as TurnRow | undefined;
  return row === undefined ? null : hydrateTurn(row);
}

export function turnsAfter(db: DB, conversationId: string, seq: number): readonly Turn[] {
  const rows = db
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? AND seq > ? ORDER BY seq`)
    .all(conversationId, seq) as TurnRow[];

  return rows.map(hydrateTurn);
}

export function allTurns(db: DB, conversationId: string): readonly Turn[] {
  const rows = db
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq`)
    .all(conversationId) as TurnRow[];

  return rows.map(hydrateTurn);
}

export function turnCount(db: DB, conversationId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`)
    .get(conversationId) as { n: number };

  return row.n;
}

export function saveSummary(
  db: DB,
  conversationId: string,
  summary: string,
  through: number,
): void {
  db.prepare(
    `UPDATE conversations SET summary = ?, summarized_through = ? WHERE id = ?`,
  ).run(summary, through, conversationId);
}

export function deleteConversation(db: DB, id: string): boolean {
  const remove = db.transaction(() => {
    db.prepare(`DELETE FROM turns WHERE conversation_id = ?`).run(id);
    return db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id).changes;
  });

  return remove() > 0;
}
