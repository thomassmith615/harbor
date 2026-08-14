/**
 * The sync engine.
 *
 * This is the part that used to be Gmail-shaped and is now source-agnostic.
 * It owns everything a connector should not have to think about: mode
 * selection, resume, checkpointing, tombstones, cursor promotion, and the
 * fallback when a source forgets our cursor.
 *
 * The ordering rule that matters, and the one bug here that would be invisible:
 * a backfill captures the source's watermark *before* it fetches anything, and
 * promotes it to the stream cursor only when the run completes. Recorded at the
 * end instead, everything that arrived during a long backfill falls into a gap
 * and is never seen again.
 */
import { CursorExpiredError } from "./types.js";
import { recordSelfHandles } from "../store/entities.js";
import { saveAttachment } from "../store/attachments.js";
import { tombstoneExternal, upsertItem } from "../store/items.js";
import { checkpoint, finishRun, resumableRun, startRun } from "../store/syncruns.js";
import { ensureStream, markPhase, recordStreamSync } from "../store/streams.js";
import type { DB } from "../kernel/db.js";
import type { ItemUpsert } from "../store/items.js";
import type { SourceConnector, SyncBatch, SyncContext } from "./types.js";

export type SyncMode = "recent" | "historical" | "backfill" | "incremental" | "auto";
export type ResolvedMode = "recent" | "historical" | "backfill" | "incremental";

/**
 * How far back "recent" reaches.
 *
 * Ninety days is the number that makes a first run take minutes instead of an
 * hour while still being long enough to be useful: the unclosed-loop detector
 * looks back forty-five days, the brief only ever cares about the last few
 * weeks, and "what did I agree to last month" works. Everything older arrives
 * behind it without anyone waiting.
 */
export const RECENT_DAYS = Number.parseInt(process.env["HARBOR_RECENT_DAYS"] ?? "90", 10) || 90;

/**
 * How far back Harbor reaches, in months, across every source and every mode.
 *
 * The one number that decides how long a first run takes and how much of
 * somebody's life ends up on disk. Six months by default, which is enough for
 * every detector here (the longest looks back forty-five days), enough to
 * answer "what did I agree to in the spring", and short enough that a mailbox
 * of forty thousand messages and a chat history of a quarter million finish in
 * a sitting rather than a weekend.
 *
 * It used to be ten years, and `backfill` ignored even that: the mode passed no
 * window at all, so "sync this source" meant "read everything that has ever
 * happened". On real volume that is not a setting anybody chose, it is just
 * what happens.
 *
 *   HARBOR_HISTORY_MONTHS=24    two years
 *   HARBOR_HISTORY_MONTHS=0     no limit, everything (the old behaviour)
 *
 * Raising it later costs nothing but time: clear the cursor for a source and
 * re-sync, and the store fills in behind what is already there. Nothing is
 * discarded when it is lowered either; the horizon only governs what is
 * fetched, never what is kept.
 */
export const HISTORY_MONTHS = (() => {
  const raw = process.env["HARBOR_HISTORY_MONTHS"];

  if (raw === undefined) {
    return 6;
  }

  const parsed = Number.parseInt(raw, 10);

  // Zero is meaningful and NaN is not, so they cannot share a fallback.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 6;
})();

/** Approximate, deliberately: a month here is a rough horizon, not a calendar. */
const MONTH_MS = 30 * 86_400_000;

/** The oldest moment any pass will reach for, or null when unbounded. */
export function historyFloor(now = Date.now()): number | null {
  return HISTORY_MONTHS === 0 ? null : now - HISTORY_MONTHS * MONTH_MS;
}

function recentWindow(now = Date.now()): { since: number; until: null } {
  const floor = historyFloor(now);
  const recent = now - RECENT_DAYS * 86_400_000;

  // A horizon shorter than the recent pass wins. Setting one month and then
  // being handed ninety days would make the setting a suggestion.
  return { since: floor === null ? recent : Math.max(recent, floor), until: null };
}

function historicalWindow(now = Date.now()): { since: number | null; until: number } {
  return {
    since: historyFloor(now),
    // Stops where the recent pass began, so the two do not overlap and nothing
    // is fetched twice.
    until: now - RECENT_DAYS * 86_400_000,
  };
}

/**
 * The window for a plain backfill.
 *
 * Open at the recent end, because a backfill is meant to be the whole picture
 * rather than the old half of it, and bounded at the far end by the horizon.
 */
function backfillWindow(now = Date.now()): { since: number | null; until: null } | undefined {
  const floor = historyFloor(now);

  return floor === null ? undefined : { since: floor, until: null };
}

export interface EngineOptions {
  readonly concurrency?: number;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly timezone: string;
  readonly onProgress?: (phase: string, done: number, total: number | null) => void;
  readonly onNote?: (message: string) => void;
}

export interface StreamReport {
  readonly streamId: string;
  readonly connectorId: string;
  readonly connectorLabel: string;
  readonly mode: ResolvedMode;
  readonly upserted: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly tombstoned: number;
  readonly resumed: boolean;
  readonly complete: boolean;
  readonly durationMs: number;
}

/**
 * Extracts attachment text after a batch commits.
 *
 * Outside the transaction on purpose: parsing a PDF is async and slow, and
 * holding SQLite's single writer open while it happens would stall every other
 * pass. Failures are swallowed at the item level, because an unreadable
 * attachment is not a reason to fail an ingest that otherwise worked.
 */
async function storeAttachments(
  db: DB,
  pending: readonly PendingAttachments[],
): Promise<number> {
  let stored = 0;

  for (const entry of pending) {
    for (const attachment of entry.attachments) {
      try {
        await saveAttachment(db, {
          itemId: entry.itemId,
          filename: attachment.filename,
          mime: attachment.mime,
          content: attachment.content,
          sizeBytes: attachment.sizeBytes,
        });

        stored += 1;
      } catch {
        // Recorded nowhere by design: the attachment simply does not exist as
        // far as the rest of Harbor is concerned, and the item is unaffected.
      }
    }
  }

  return stored;
}

interface PendingAttachments {
  readonly itemId: string;
  readonly attachments: NonNullable<ItemUpsert["attachments"]>;
}

function writeBatch(
  db: DB,
  accountId: string,
  batch: SyncBatch,
): {
  changed: number;
  unchanged: number;
  tombstoned: number;
  pendingAttachments: readonly PendingAttachments[];
} {
  let changed = 0;
  let unchanged = 0;
  let tombstoned = 0;
  const pendingAttachments: PendingAttachments[] = [];

  // One transaction per batch. The checkpoint below is only recorded after the
  // data it describes is durable, so an interruption costs at most one batch.
  const write = db.transaction((upserts: readonly ItemUpsert[], deletes: readonly string[]) => {
    for (const upsert of upserts) {
      const outcome = upsertItem(db, upsert);

      if (upsert.attachments !== undefined && upsert.attachments.length > 0) {
        // Collected, not written. Text extraction is async (a PDF parser is)
        // and this runs inside a transaction, so the work happens after the
        // commit. An item whose attachments fail to extract is still a
        // correctly ingested item.
        pendingAttachments.push({ itemId: outcome.id, attachments: upsert.attachments });
      }

      if (outcome.changed) {
        changed += 1;
      } else {
        unchanged += 1;
      }
    }

    if (deletes.length > 0) {
      tombstoned = tombstoneExternal(db, accountId, deletes, Date.now());
    }
  });

  write(batch.upserts, batch.deletes ?? []);
  return { changed, unchanged, tombstoned, pendingAttachments };
}

async function runBackfill(
  db: DB,
  connector: SourceConnector,
  context: SyncContext,
  options: EngineOptions,
  phase: "recent" | "historical" | "backfill" = "backfill",
): Promise<Omit<StreamReport, "streamId" | "connectorId" | "connectorLabel" | "mode" | "durationMs">> {
  // Each phase gets its own resumable run, so stopping a background history
  // fill never disturbs the recent pass that made Harbor usable.
  const runMode = phase === "historical" ? "backfill" : phase === "recent" ? "recent" : "backfill";
  const existing = resumableRun(db, context.streamId, runMode);
  const resumed = existing !== null;

  // Captured before the first fetch, promoted only on completion.
  const watermark = existing?.startHistoryId ?? (await connector.watermark(context));
  const run = existing ?? startRun(db, context.accountId, context.streamId, runMode, watermark);

  if (resumed) {
    options.onNote?.(`resuming ${connector.label} backfill from ${String(run.fetched)} items in`);
  }

  let upserted = run.fetched;
  let changed = run.changed;
  let unchanged = 0;
  let tombstoned = 0;
  let lastCursor: string | null = run.pageCursor;

  try {
    // A connector that throws mid-stream ends the run, which for a mailbox is
    // hours of work lost to one malformed message. The generator cannot be
    // resumed after a throw, so the run is closed cleanly and left resumable
    // rather than marked failed: the checkpoint is sound and the next attempt
    // picks up from it.
    for await (const batch of connector.backfill(context, run.pageCursor)) {
      const outcome = writeBatch(db, context.accountId, batch);
      await storeAttachments(db, outcome.pendingAttachments);

      changed += outcome.changed;
      unchanged += outcome.unchanged;
      tombstoned += outcome.tombstoned;
      upserted += batch.upserts.length;
      lastCursor = batch.cursor;

      checkpoint(db, run.id, batch.cursor, upserted, changed);

      // Stopped between batches, after the checkpoint. The run stays resumable,
      // which is the only reason cancelling a backfill is cheap.
      if (options.shouldStop?.() === true) {
        finishRun(db, run.id, "running", "cancelled");
        return { upserted, changed, unchanged, tombstoned, resumed, complete: false };
      }

      if (batch.note !== undefined) {
        options.onNote?.(batch.note);
      }
      if (batch.progress !== undefined) {
        // `upserted` is seeded from the resumed run and is the only numerator
        // that is right after a restart. The connector's `total`, though,
        // reports what *remains*, so pairing them produced fractions like
        // 21450/16541: a cumulative count over a remaining count, two different
        // quantities in one ratio, starting above 1 and getting worse.
        //
        // Adding the numerator to what remains gives a denominator in the same
        // units as the numerator, so the fraction means what it looks like.
        options.onProgress?.(
          connector.id,
          upserted,
          batch.progress.total === null ? null : upserted + batch.progress.total,
        );
      }
    }
  } catch (error: unknown) {
    // Stays 'running' so the next attempt resumes. Only completion clears it.
    finishRun(db, run.id, "running", error instanceof Error ? error.message : String(error));
    throw error;
  }

  finishRun(db, run.id, "complete");

  if (phase === "recent") {
    markPhase(db, context.streamId, "recent", true);
    // Only the recent pass sets the incremental cursor. A history fill reading
    // 2019 must never claim Harbor is caught up to now.
    recordStreamSync(db, context.streamId, watermark ?? lastCursor, Date.now());
  } else {
    markPhase(db, context.streamId, "historical", true, context.window?.since ?? null);

    if (phase === "backfill") {
      markPhase(db, context.streamId, "recent", true);
      recordStreamSync(db, context.streamId, watermark ?? lastCursor, Date.now());
    }
  }

  return { upserted, changed, unchanged, tombstoned, resumed, complete: true };
}

async function runIncremental(
  db: DB,
  connector: SourceConnector,
  context: SyncContext,
  cursor: string,
  options: EngineOptions,
): Promise<Omit<StreamReport, "streamId" | "connectorId" | "connectorLabel" | "mode" | "durationMs">> {
  let upserted = 0;
  let changed = 0;
  let unchanged = 0;
  let tombstoned = 0;
  let latest = cursor;

  for await (const batch of connector.incremental(context, cursor)) {
    const outcome = writeBatch(db, context.accountId, batch);
    await storeAttachments(db, outcome.pendingAttachments);

    changed += outcome.changed;
    unchanged += outcome.unchanged;
    tombstoned += outcome.tombstoned;
    upserted += batch.upserts.length;

    if (batch.cursor !== null) {
      latest = batch.cursor;
    }

    // Incremental batches are small and each carries a valid cursor, so
    // recording as we go means an interruption never replays work.
    recordStreamSync(db, context.streamId, latest, Date.now());

    if (batch.progress !== undefined) {
      options.onProgress?.(
        connector.id,
        upserted,
        batch.progress.total === null ? null : upserted + batch.progress.total,
      );
    }
  }

  recordStreamSync(db, context.streamId, latest, Date.now());

  return { upserted, changed, unchanged, tombstoned, resumed: false, complete: false };
}

export async function syncStream(
  db: DB,
  connector: SourceConnector,
  accountId: string,
  token: string,
  mode: SyncMode,
  options: EngineOptions,
  authScheme: "Bearer" | "Basic" = "Bearer",
): Promise<StreamReport> {
  const started = Date.now();
  const stream = ensureStream(db, accountId, connector.id);

  // Connectors with no time dimension read whole. An address book is small and
  // is what turns addresses into people, so windowing it would slow nothing
  // down and make every other source worth less.
  const timeless = connector.kinds.includes("contact");

  const window =
    timeless || mode === "incremental"
      ? undefined
      : mode === "recent"
        ? recentWindow()
        : mode === "historical"
          ? historicalWindow()
          : // Every other mode, backfill included. This branch used to be
            // `undefined`, which is how a single `harbor sync` came to mean
            // "read a decade".
            backfillWindow();

  const context: SyncContext = {
    token,
    authScheme,
    accountId,
    streamId: stream.id,
    timezone: options.timezone,
    concurrency: options.concurrency ?? 3,
    ...(window === undefined ? {} : { window }),
    ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
  };

  // Before anything is read. A connector that knows which handles belong to the
  // user says so once per sync, and it is idempotent, so the first pass over a
  // fresh store already has them.
  if (connector.selfHandles !== undefined) {
    try {
      recordSelfHandles(db, connector.id, connector.selfHandles());
    } catch {
      // Never a reason to fail a sync. The self entity is simply weaker, and
      // `harbor doctor` reports that.
    }
  }

  const base = {
    streamId: stream.id,
    connectorId: connector.id,
    connectorLabel: connector.label,
  };

  if (mode === "recent" || mode === "historical" || mode === "backfill") {
    // A source with no time dimension has one pass, not two: asking for its
    // history after its recent pass is asking for the same thing twice.
    if (timeless && mode === "historical") {
      markPhase(db, stream.id, "historical", true);

      return {
        ...base,
        mode: "historical",
        upserted: 0,
        changed: 0,
        unchanged: 0,
        tombstoned: 0,
        resumed: false,
        complete: true,
        durationMs: Date.now() - started,
      };
    }

    const result = await runBackfill(db, connector, context, options, mode);
    return { ...base, ...result, mode, durationMs: Date.now() - started };
  }

  const wantsIncremental =
    (mode === "auto" || mode === "incremental") &&
    stream.cursor !== null &&
    resumableRun(db, stream.id, "backfill") === null;

  if (wantsIncremental && stream.cursor !== null) {
    try {
      const result = await runIncremental(db, connector, context, stream.cursor, options);
      return { ...base, ...result, mode: "incremental", durationMs: Date.now() - started };
    } catch (error: unknown) {
      if (!(error instanceof CursorExpiredError)) {
        throw error;
      }

      options.onNote?.(
        `${connector.label}: ${error.message}; falling back to a full pass`,
      );
      recordStreamSync(db, stream.id, null, Date.now());
    }
  }

  if (mode === "incremental" && stream.cursor === null) {
    options.onNote?.(`${connector.label}: no cursor yet, running a full pass instead`);
  }

  const result = await runBackfill(db, connector, context, options);
  return { ...base, ...result, mode: "backfill", durationMs: Date.now() - started };
}
