/**
 * The connector contract.
 *
 * This interface was deliberately not written until there were two real
 * sources to extract it from, and adding the second one moved it. Three things
 * that looked obvious with only Gmail in hand turned out to be wrong:
 *
 *   1. The cursor does not belong to the account. Gmail tracks a `historyId`
 *      and Calendar tracks a `syncToken`, both under one OAuth grant. A cursor
 *      is a property of a *stream* (an account plus a connector), which is why
 *      migration 003 moves it out of `accounts`.
 *
 *   2. The cursor must be opaque to the framework. Calendar needs one token
 *      per calendar, so its cursor is a JSON map. The framework stores a string
 *      and never looks inside it.
 *
 *   3. Paging belongs to the connector, checkpointing belongs to the framework.
 *      An async generator gives both: the connector yields whenever it has a
 *      durable point, the engine writes and records it. Neither has to know how
 *      the other works.
 *
 * A connector fetches and emits. It does not rank, query, summarize, or decide
 * what matters.
 */
import type { ItemUpsert } from "../store/items.js";

/** Raised when a source can no longer serve incremental changes from a cursor. */
export class CursorExpiredError extends Error {
  constructor(source: string) {
    super(`${source} can no longer serve changes from that cursor`);
    this.name = "CursorExpiredError";
  }
}

export interface SyncContext {
  /** The bare credential. Refresh, where relevant, happens before this is built. */
  readonly token: string;
  /**
   * How to present it. Google uses OAuth bearer tokens; iCloud uses Basic auth
   * with an app-specific password. Connectors build the header from both rather
   * than hardcoding a scheme, which is what let a DAV source drop in beside two
   * REST ones without widening the interface.
   */
  readonly authScheme: "Bearer" | "Basic";
  readonly accountId: string;
  readonly streamId: string;
  /** For sources whose native representation is timezone-dependent (all-day events). */
  readonly timezone: string;
  /**
   * The slice of time to read.
   *
   * Bounded server-side wherever the source allows it, which is the whole point:
   * asking Gmail for the last ninety days is one query, and filtering a decade
   * of results locally is a decade of downloads.
   *
   * A connector with no time dimension, like an address book, ignores it.
   */
  readonly window?: { readonly since: number | null; readonly until: number | null } | undefined;
  /**
   * Whether to stop.
   *
   * The engine checks between batches, which is right for a source whose batch
   * is quick. A mailbox page is two hundred messages fetched over a socket and
   * run through a MIME parser, so "between batches" can be a minute, and a stop
   * button that does nothing for a minute is indistinguishable from one that is
   * broken. Connectors with slow batches check inside them.
   */
  readonly shouldStop?: (() => boolean) | undefined;
  readonly concurrency: number;
}

/**
 * One durable unit of work. The engine writes it in a transaction and only
 * then records `cursor`, so an interruption costs at most one batch.
 */
/** One reaction, keyed to the source's own id for the message it is about. */
export interface ReactionUpsert {
  readonly targetExternalId: string;
  readonly author: string | null;
  readonly kind: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
  readonly occurredAt: number;
}

export interface SyncBatch {
  readonly upserts: readonly ItemUpsert[];
  /**
   * Marks on other messages, rather than messages.
   *
   * Separate from `upserts` because a reaction is not an item and giving it a
   * row in `items` would put it in search, in the term index and in coverage
   * counts. A source with no notion of reacting simply never sets this.
   */
  readonly reactions?: readonly ReactionUpsert[] | undefined;
  /** External ids the source says are gone. Tombstoned, never deleted. */
  readonly deletes?: readonly string[] | undefined;
  /** Opaque resume point. Null means "no further resume point exists". */
  readonly cursor: string | null;
  /**
   * How much there is in total, if the source knows. Deliberately NOT how much
   * is done: a connector resuming a backfill has no idea how many items an
   * earlier run already wrote, and reporting its own local count made a resumed
   * run restart the progress display at zero. The engine owns `done`.
   */
  readonly progress?: { readonly total: number | null } | undefined;
  readonly note?: string | undefined;
}

export interface SourceConnector {
  /** Stable within a source type. Part of every stream id. */
  readonly id: string;
  readonly sourceType: string;
  readonly label: string;
  /** OAuth scopes this connector needs. The union is what `harbor auth` asks for. */
  readonly scopes: readonly string[];
  /** Item kinds this connector emits. Used for coverage reporting. */
  readonly kinds: readonly string[];

  /**
   * Everything, from the beginning, resumable from `cursor`.
   *
   * Must yield a cursor the connector can restart from, not a cursor that means
   * "caught up". The engine promotes `finalCursor` separately.
   */
  backfill(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch>;

  /**
   * Only what changed since `cursor`.
   *
   * Throws CursorExpiredError when the source's retention window has moved
   * past it, which the engine handles by falling back to a backfill.
   */
  incremental(context: SyncContext, cursor: string): AsyncGenerator<SyncBatch>;

  /**
   * The cursor that means "caught up as of now", captured before a backfill
   * starts so that nothing arriving mid-run falls into a gap.
   */
  watermark(context: SyncContext): Promise<string | null>;

  /**
   * Addresses and phone numbers this source knows belong to the user.
   *
   * Optional, and worth the widening of the interface for one reason: an
   * outbound iMessage has no author, because Apple stores no handle for a
   * message you sent. The self entity was therefore built entirely from the
   * addresses on connected mail accounts, your phone number was never an
   * identity anchor, and "have I replied to them" was unanswerable for the
   * source where most replying actually happens.
   *
   * A connector that cannot say anything useful omits this. Nothing here is
   * parsed further than a kind and a value; deciding that two handles are one
   * person is entity resolution's job, not a connector's.
   */
  selfHandles?(): readonly SelfHandle[];
}

export interface SelfHandle {
  readonly kind: "email" | "phone";
  readonly value: string;
}
