/**
 * The items table: one row per thing that happened, from any source.
 *
 * Connectors emit these and nothing else. They do not rank, query, or
 * interpret. Everything a connector knows that does not fit the columns below
 * survives verbatim in `raw`, which is what makes re-derivation possible.
 *
 * `raw` is gzipped on write (see migration 002). It is still verbatim: the
 * bytes round-trip exactly. Compression is a storage decision, not a fidelity
 * one, and `readRaw` is the only way anything reads it back.
 *
 * Upsert also clears `derived_version` whenever content changes. That single
 * line is what keeps the derivation pipeline honest: nothing has to remember to
 * invalidate chunks and embeddings, because the write that invalidates them
 * does it.
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DB } from "../kernel/db.js";

export type Direction = "inbound" | "outbound" | "internal";
export type Visibility = "private" | "household";

export interface ItemUpsert {
  readonly accountId: string;
  readonly streamId: string;
  readonly externalId: string;
  readonly kind: string;
  readonly direction?: Direction;
  readonly threadId?: string | null;
  readonly title?: string | null;
  readonly body?: string | null;
  readonly snippet?: string | null;
  readonly author?: string | null;
  readonly participants?: readonly string[];
  readonly occurredAt: number;
  /** End of a span, for kinds that have one. Null for point-in-time items. */
  readonly endsAt?: number | null;
  /**
   * For item kinds that are a state rather than an event. A reminder is
   * `open` or `completed`; a message has none. Part of the content hash,
   * because completing a reminder is a change and used not to be one.
   */
  readonly state?: string | null;
  readonly dueAt?: number | null;
  /** An RRULE as the source stated it, for items that repeat. */
  readonly recurrence?: string | null;
  /**
   * Files that came with the item.
   *
   * Not a column. Carried on the upsert so the engine can extract their text
   * once, right after the item lands, rather than re-fetching the message later
   * to reach content it already had in hand.
   */
  readonly attachments?: readonly {
    readonly filename: string | null;
    readonly mime: string | null;
    readonly content: Buffer | null;
    readonly sizeBytes: number;
  }[];
  readonly sourceUpdatedAt?: number | null;
  readonly uri?: string | null;
  readonly raw: unknown;
  readonly visibility?: Visibility;
}

export interface StoredItem {
  readonly id: string;
  readonly accountId: string;
  readonly streamId: string | null;
  readonly externalId: string;
  readonly kind: string;
  readonly direction: Direction | null;
  readonly threadId: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly snippet: string | null;
  readonly author: string | null;
  readonly participants: readonly string[];
  readonly occurredAt: number;
  readonly endsAt: number | null;
  readonly state: string | null;
  readonly dueAt: number | null;
  readonly recurrence: string | null;
  readonly uri: string | null;
}

export interface ItemRow {
  readonly id: string;
  readonly account_id: string;
  readonly stream_id: string | null;
  readonly external_id: string;
  readonly kind: string;
  readonly direction: Direction | null;
  readonly thread_id: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly snippet: string | null;
  readonly author: string | null;
  readonly participants: string | null;
  readonly occurred_at: number;
  readonly ends_at: number | null;
  readonly state: string | null;
  readonly due_at: number | null;
  readonly recurrence: string | null;
  readonly uri: string | null;
}

export function hydrateItem(row: ItemRow): StoredItem {
  return {
    id: row.id,
    accountId: row.account_id,
    streamId: row.stream_id,
    externalId: row.external_id,
    kind: row.kind,
    direction: row.direction,
    threadId: row.thread_id,
    title: row.title,
    body: row.body,
    snippet: row.snippet,
    author: row.author,
    participants: row.participants === null ? [] : (JSON.parse(row.participants) as string[]),
    occurredAt: row.occurred_at,
    endsAt: row.ends_at,
    state: row.state,
    dueAt: row.due_at,
    recurrence: row.recurrence,
    uri: row.uri,
  };
}

/**
 * The earliest timestamp Harbor will believe: 1990.
 *
 * A source returning 0, or a date that failed to parse into one, previously
 * sailed through because `Number.isFinite(0)` is true. One such row makes
 * coverage claim the store reaches back to 1970, which is both wrong and the
 * kind of wrong that makes a model answer confidently about a decade that is
 * not in the store.
 */
const EARLIEST_PLAUSIBLE = Date.parse("1990-01-01T00:00:00Z");

/**
 * And a ceiling, one year out.
 *
 * A floor alone let a message dated 2056 through, which then became the "last
 * contact" for that person forever, because the newest thing always wins.
 * Calendars legitimately reach into the future and pass their own dates
 * straight through; a message or a contact card cannot.
 */
const YEAR = 365 * 86_400_000;

export function plausibleTime(
  value: number | null | undefined,
  fallback: number,
  options: { readonly allowFuture?: boolean } = {},
): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  if (value < EARLIEST_PLAUSIBLE) {
    return fallback;
  }

  if (options.allowFuture !== true && value > Date.now() + YEAR) {
    return fallback;
  }

  return value;
}

/** Stable, derived from source identity so re-ingestion never duplicates. */
export function itemId(accountId: string, externalId: string): string {
  return createHash("sha256").update(`${accountId}\u0000${externalId}`).digest("hex").slice(0, 24);
}

function contentHash(input: ItemUpsert): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.title ?? "",
        input.body ?? "",
        input.author ?? "",
        input.participants ?? [],
        input.occurredAt,
        input.endsAt ?? 0,
        input.state ?? "",
        input.dueAt ?? 0,
        input.recurrence ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * Level 6 rather than 9: gzip's last three levels cost noticeably more CPU for
 * low single-digit percentage gains, and a backfill runs this tens of thousands
 * of times.
 */
function encodeRaw(raw: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(raw), "utf8"), { level: 6 });
}

/**
 * Reads a raw payload back, transparently handling rows written before
 * migration 002. Nothing else in Harbor touches the `raw` column.
 */
export function readRaw(db: DB, id: string): unknown | null {
  const row = db.prepare(`SELECT raw, raw_encoding FROM items WHERE id = ?`).get(id) as
    | { raw: Buffer | string; raw_encoding: string }
    | undefined;

  if (row === undefined) {
    return null;
  }

  if (row.raw_encoding === "gzip") {
    const buffer = Buffer.isBuffer(row.raw) ? row.raw : Buffer.from(row.raw, "binary");
    return JSON.parse(gunzipSync(buffer).toString("utf8")) as unknown;
  }

  return JSON.parse(typeof row.raw === "string" ? row.raw : row.raw.toString("utf8")) as unknown;
}

export interface UpsertOutcome {
  readonly id: string;
  /** False when the row already existed with identical content. */
  readonly changed: boolean;
}

/**
 * Idempotent by (account, external id). Unchanged content is a no-op, which is
 * what lets a re-sync be cheap and lets the full-text index stay consistent
 * without a rebuild.
 */
export function upsertItem(db: DB, input: ItemUpsert): UpsertOutcome {
  const id = itemId(input.accountId, input.externalId);
  const hash = contentHash(input);

  const existing = db.prepare(`SELECT content_hash FROM items WHERE id = ?`).get(id) as
    | { content_hash: string }
    | undefined;

  if (existing !== undefined && existing.content_hash === hash) {
    return { id, changed: false };
  }

  const now = Date.now();

  db.prepare(
    `INSERT INTO items (
       id, account_id, stream_id, external_id, kind, direction, thread_id, title, body,
       snippet, author, participants, occurred_at, ends_at, source_updated_at, ingested_at,
       content_hash, uri, raw, raw_encoding, visibility, state, due_at, recurrence
     ) VALUES (
       @id, @accountId, @streamId, @externalId, @kind, @direction, @threadId, @title, @body,
       @snippet, @author, @participants, @occurredAt, @endsAt, @sourceUpdatedAt, @ingestedAt,
       @contentHash, @uri, @raw, 'gzip', @visibility, @state, @dueAt, @recurrence
     )
     ON CONFLICT (id) DO UPDATE SET
       stream_id = excluded.stream_id,
       kind = excluded.kind,
       direction = excluded.direction,
       thread_id = excluded.thread_id,
       title = excluded.title,
       body = excluded.body,
       snippet = excluded.snippet,
       author = excluded.author,
       participants = excluded.participants,
       occurred_at = excluded.occurred_at,
       ends_at = excluded.ends_at,
       state = excluded.state,
       due_at = excluded.due_at,
       recurrence = excluded.recurrence,
       source_updated_at = excluded.source_updated_at,
       content_hash = excluded.content_hash,
       uri = excluded.uri,
       raw = excluded.raw,
       raw_encoding = 'gzip',
       deleted_at = NULL,
       -- The staleness link. Content changed, so chunks and vectors derived
       -- from it are wrong and harbor derive must pick this item up again.
       derived_version = NULL,
       derived_at = NULL,
       entities_version = NULL,
       classified_version = NULL,
       -- Relationships and references are derived from content too, and used
       -- not to be cleared here. An edited item kept the edges drawn from its
       -- old text and was never reconsidered, which is the same class of bug as
       -- stale chunks and was simply missed when the columns were added.
       relationships_version = NULL,
       references_version = NULL,
       episode_version = NULL,
       commitment_version = NULL,
       projection_version = NULL,
       anchors_version = NULL`,
  ).run({
    id,
    accountId: input.accountId,
    streamId: input.streamId,
    externalId: input.externalId,
    kind: input.kind,
    direction: input.direction ?? null,
    threadId: input.threadId ?? null,
    title: input.title ?? null,
    body: input.body ?? null,
    snippet: input.snippet ?? null,
    author: input.author ?? null,
    participants: JSON.stringify(input.participants ?? []),
    occurredAt: input.occurredAt,
    endsAt: input.endsAt ?? null,
    state: input.state ?? null,
    dueAt: input.dueAt ?? null,
    recurrence: input.recurrence ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    ingestedAt: now,
    contentHash: hash,
    uri: input.uri ?? null,
    raw: encodeRaw(input.raw),
    visibility: input.visibility ?? "private",
  });

  db.prepare(`DELETE FROM items_fts WHERE item_id = ?`).run(id);
  db.prepare(
    `INSERT INTO items_fts (item_id, title, body, author) VALUES (?, ?, ?, ?)`,
  ).run(id, input.title ?? "", input.body ?? "", input.author ?? "");

  return { id, changed: true };
}

/** Soft delete. Nothing in Harbor removes a row because a source stopped listing it. */
export function tombstoneItem(db: DB, id: string, at: number): void {
  db.prepare(`UPDATE items SET deleted_at = ? WHERE id = ?`).run(at, id);
}

export function tombstoneExternal(
  db: DB,
  accountId: string,
  externalIds: readonly string[],
  at: number,
): number {
  let count = 0;

  const statement = db.prepare(`UPDATE items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`);

  for (const externalId of externalIds) {
    const result = statement.run(at, itemId(accountId, externalId));
    count += result.changes;
  }

  return count;
}

export function countItems(db: DB, accountId?: string): number {
  const row =
    accountId === undefined
      ? (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL`).get() as {
          n: number;
        })
      : (db
          .prepare(
            `SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND account_id = ?`,
          )
          .get(accountId) as { n: number });

  return row.n;
}

export function getItem(db: DB, id: string): StoredItem | null {
  const row = db.prepare(`SELECT * FROM items WHERE id = ? AND deleted_at IS NULL`).get(id) as
    | ItemRow
    | undefined;

  return row === undefined ? null : hydrateItem(row);
}
