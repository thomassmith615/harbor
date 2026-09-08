/**
 * Photos.
 *
 * The library is a SQLite database like `chat.db` and is read the same way: a
 * snapshot copy, opened read-only, never written to. Apple changes the schema
 * between releases more often than they change Messages, so every column here
 * is looked up rather than assumed and a missing one degrades that field rather
 * than the sync.
 *
 * ## What is ingested, and what is not
 *
 * Metadata, always: when it was taken, whether it is a screenshot, its
 * dimensions, whether it is a favourite, and where it was taken if the asset
 * carries coordinates. Small, free, and enough to answer "what was I doing that
 * afternoon" from the shape of a day.
 *
 * Pixels, never. No image is copied into Harbor's store, no image is sent
 * anywhere, and the only thing that reads one is an on-device text recogniser
 * running against the file in place. What lands in the store is the text and a
 * path back to the original.
 *
 * That is a privacy position as much as a cost one, and worth stating plainly
 * because a photo library is the most sensitive thing on most people's machines.
 * The rule is that Harbor learns what a picture *says*, never what it depicts.
 *
 * ## Why an item per photo
 *
 * Because everything downstream then works for free. A photo becomes an item
 * with its OCR text as the body, so the term index reads it, `datesIn` and
 * `timeHintsIn` read the printed date on a receipt, `references.ts` reads the
 * order number, and the event layer can attach it to the evening it belongs to
 * without a line of photo-specific code. The alternative -- a parallel photo
 * table with its own matching -- is a second world model, which this codebase
 * has already learned not to build twice.
 *
 * The one thing that needs care is time. An item's `occurredAt` is when the
 * photo was taken, not when the thing in it happened: a screenshot of a
 * confirmation for next Thursday was taken today. The printed date becomes an
 * anchor, and the distinction between observation time and event time is
 * exactly what the event layer already handles.
 */
import Database from "better-sqlite3-multiple-ciphers";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { UpstreamError } from "../../kernel/errors.js";
import { plausibleTime } from "../../store/items.js";
import type { ItemUpsert } from "../../store/items.js";
import type { SourceConnector, SyncBatch, SyncContext } from "../types.js";

/** Apple's epoch: 1 January 2001, UTC. Same convention as Messages. */
const APPLE_EPOCH_MS = 978_307_200_000;

function libraryPath(): string {
  return (
    process.env["HARBOR_PHOTOS_DB"] ??
    join(homedir(), "Pictures", "Photos Library.photoslibrary", "database", "Photos.sqlite")
  );
}

interface AssetRow {
  readonly uuid: string;
  readonly filename: string | null;
  readonly created: number | null;
  readonly added: number | null;
  readonly kind: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly favourite: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly directory: string | null;
}

/**
 * Column names across Photos schema versions.
 *
 * Apple renames these between macOS releases and there is no version marker to
 * branch on, so each field is resolved by asking the table what it has. A field
 * that is missing everywhere comes back null and the photo is ingested without
 * it, which is right: a library that does not record whether something is a
 * screenshot should still have its photos.
 */
const COLUMNS: Readonly<Record<string, readonly string[]>> = {
  uuid: ["ZUUID"],
  filename: ["ZORIGINALFILENAME", "ZFILENAME"],
  created: ["ZDATECREATED"],
  added: ["ZADDEDDATE"],
  // 10 is a screenshot in every schema that has this column.
  kind: ["ZKINDSUBTYPE", "ZSAVEDASSETTYPE"],
  width: ["ZWIDTH"],
  height: ["ZHEIGHT"],
  favourite: ["ZFAVORITE"],
  latitude: ["ZLATITUDE"],
  longitude: ["ZLONGITUDE"],
  directory: ["ZDIRECTORY"],
};

function resolveColumns(db: Database.Database): Readonly<Record<string, string | null>> {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(ZASSET)`).all() as { name: string }[]).map((row) => row.name),
  );

  const resolved: Record<string, string | null> = {};

  for (const [field, candidates] of Object.entries(COLUMNS)) {
    resolved[field] = candidates.find((column) => present.has(column)) ?? null;
  }

  return resolved;
}

/**
 * A read-only snapshot.
 *
 * Photos.app holds the library open and writes to it constantly, so this copies
 * the database and its sidecars rather than reading the live file. Identical
 * reasoning to the Messages connector, and the same failure it prevents: a read
 * of a file mid-write returns rows that never existed together.
 */
function snapshot(): { db: Database.Database; close: () => void } {
  const source = libraryPath();

  if (!existsSync(source)) {
    throw new UpstreamError(
      "No Photos library found. Set HARBOR_PHOTOS_DB if it is somewhere unusual.",
    );
  }

  const directory = mkdtempSync(join(tmpdir(), "harbor-photos-"));

  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${source}${suffix}`;

    if (existsSync(path)) {
      copyFileSync(path, join(directory, `Photos.sqlite${suffix}`));
    }
  }

  const db = new Database(join(directory, "Photos.sqlite"), { readonly: true });

  return {
    db,
    close: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function appleDate(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 1000) + APPLE_EPOCH_MS;
}

function toItem(row: AssetRow, context: SyncContext): ItemUpsert | null {
  const takenAt = appleDate(row.created) ?? appleDate(row.added);

  if (takenAt === null) {
    return null;
  }

  const isScreenshot = row.kind === 10;

  // The body is empty at ingest and filled by the triage pass. Ingest is
  // metadata only, deliberately: reading text is slower than reading rows by
  // orders of magnitude, and a sync that stalls on OCR is a sync people turn
  // off.
  return {
    accountId: context.accountId,
    streamId: context.streamId,
    externalId: row.uuid,
    kind: "photo",
    threadId: null,
    title: row.filename,
    body: null,
    author: null,
    participants: [],
    occurredAt: plausibleTime(takenAt, Date.now()),
    endsAt: null,
    state: null,
    raw: {
      uuid: row.uuid,
      filename: row.filename,
      screenshot: isScreenshot,
      width: row.width,
      height: row.height,
      favourite: row.favourite === 1,
      // Kept so the triage pass can find the file, and so nothing else has to.
      directory: row.directory,
      ...(row.latitude === null || row.latitude === -180
        ? {}
        : { latitude: row.latitude, longitude: row.longitude }),
    },
  };
}

const PAGE = 500;

function* pages(context: SyncContext, since: number): Generator<SyncBatch> {
  const held = snapshot();

  try {
    const columns = resolveColumns(held.db);

    const select = Object.entries(columns)
      .map(([field, column]) => (column === null ? `NULL AS ${field}` : `${column} AS ${field}`))
      .join(", ");

    const created = columns["created"] ?? columns["added"];

    if (created === null || created === undefined) {
      throw new UpstreamError("This Photos library has no date column Harbor recognises.");
    }

    let cursor = since;

    for (;;) {
      const rows = held.db
        .prepare(
          `SELECT ${select} FROM ZASSET
           WHERE ${created} > @cursor AND ZTRASHEDSTATE = 0
           ORDER BY ${created} LIMIT ${String(PAGE)}`,
        )
        .all({ cursor }) as AssetRow[];

      if (rows.length === 0) {
        return;
      }

      const upserts: ItemUpsert[] = [];

      for (const row of rows) {
        const item = toItem(row, context);

        if (item !== null) {
          upserts.push(item);
        }

        cursor = Math.max(cursor, row.created ?? row.added ?? cursor);
      }

      yield { upserts, cursor: String(cursor) };

      if (rows.length < PAGE) {
        return;
      }
    }
  } finally {
    held.close();
  }
}

export const photosConnector: SourceConnector = {
  id: "apple-photos",
  sourceType: "apple",
  label: "Photos",
  scopes: [],
  kinds: ["photo"],

  async *backfill(context, cursor) {
    yield* pages(context, cursor === null ? 0 : Number.parseFloat(cursor));
  },

  async *incremental(context, cursor) {
    yield* pages(context, Number.parseFloat(cursor));
  },

  async watermark() {
    // Apple's clock, not ours, because the cursor is compared against a column
    // in Apple's epoch.
    return String((Date.now() - APPLE_EPOCH_MS) / 1000);
  },
};

export { libraryPath, APPLE_EPOCH_MS };
