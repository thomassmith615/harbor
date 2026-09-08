/**
 * Turning a photo library into things Harbor can reason about, cheaply.
 *
 * The cascade, and what each stage costs:
 *
 *   1. **Ingest.** Rows from the Photos database. Free, and already done by the
 *      connector before this runs.
 *   2. **OCR.** On-device, roughly a tenth of a second per image, once per
 *      image ever. No API, no network, no pixels leaving the machine.
 *   3. **Classify.** Keyword rules over the text. Free, and the stage that
 *      stops ninety-nine images in a hundred.
 *   4. **Stitch.** Screenshots captured seconds apart that continue each other
 *      become one document. Free.
 *   5. **Extract.** A model call, on what is left. Reached by very little.
 *
 * The property worth protecting is that the expensive stage is gated by stages
 * that can be read and argued with. If a photograph of a menu gets a model call
 * the reason is a line in `classify.ts`, not a judgement inside something.
 *
 * ## Budget
 *
 * OCR is bounded per run because a first pass over forty thousand images is an
 * hour of CPU and should be resumable rather than a wall. Extraction is bounded
 * separately and much lower, because that is the stage that costs money and the
 * bound is the last line of defence if the classifier is wrong about a whole
 * category of image.
 *
 * ## What is written back
 *
 * The document text becomes the item's body, which is what makes every existing
 * pass work on photos with no photo-specific code: the term index reads it,
 * `datesIn` and `timeHintsIn` read a printed date, `references.ts` reads an
 * order number, and the event layer attaches a receipt to the evening it
 * belongs to because it shares a reference with the mail about the same
 * purchase. That last one is the cross-source duplicate case, solved by not
 * building a second mechanism for it.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { classify, purchaseKey } from "../connectors/photos/classify.js";
import { group } from "../connectors/photos/stitch.js";
import { ocrEngine, describeEngine } from "../connectors/photos/ocr.js";
import { readRaw } from "../store/items.js";
import type { DB } from "../kernel/db.js";
import type { Capture } from "../connectors/photos/stitch.js";
import type { OcrEngine } from "../connectors/photos/ocr.js";

/** Bump to re-read every image. Only when the engine or the rules change. */
export const PHOTO_VERSION = 1;

/** How many images one run will read. Resumable, so this is a pace not a cap. */
const OCR_BUDGET = 400;

/**
 * How many model calls one run will make.
 *
 * Low, and separate from the OCR budget, because this is the only stage that
 * costs money. If the classifier is ever wrong about an entire category of
 * image -- a run of screenshots from a game that happen to contain the word
 * "total" -- this is what stops that from being an invoice rather than a
 * mistake.
 */
const EXTRACT_BUDGET = 25;

export interface PhotoReport {
  readonly engine: string;
  readonly read: number;
  readonly withText: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly documents: number;
  readonly stitched: number;
  readonly duplicates: number;
  readonly extractable: number;
  readonly remaining: number;
}

interface PhotoRow {
  readonly id: string;
  readonly external_id: string;
  readonly title: string | null;
  readonly occurred_at: number;
}

/**
 * Where the file actually is.
 *
 * Photos stores originals under a directory and a filename recorded in the
 * database, and both are needed. Returns null rather than guessing when the
 * file is not where the library says, which happens constantly with iCloud
 * optimised storage: the row exists and the pixels are in the cloud. That is a
 * normal state, not an error, and such an asset simply has no text.
 */
function fileFor(raw: Record<string, unknown>): string | null {
  const root =
    process.env["HARBOR_PHOTOS_ORIGINALS"] ??
    join(homedir(), "Pictures", "Photos Library.photoslibrary", "originals");

  const directory = raw["directory"];
  const filename = raw["filename"];

  if (typeof filename !== "string") {
    return null;
  }

  const candidates = [
    typeof directory === "string" ? join(root, directory, filename) : null,
    join(root, filename),
  ].filter((path): path is string => path !== null);

  return candidates.find((path) => existsSync(path)) ?? null;
}

/** A last resort for libraries laid out differently. One shallow scan, cached. */
let originalsIndex: Map<string, string> | null = null;

function findByName(filename: string): string | null {
  if (originalsIndex === null) {
    originalsIndex = new Map();

    const root =
      process.env["HARBOR_PHOTOS_ORIGINALS"] ??
      join(homedir(), "Pictures", "Photos Library.photoslibrary", "originals");

    try {
      for (const bucket of readdirSync(root)) {
        for (const name of readdirSync(join(root, bucket))) {
          originalsIndex.set(name, join(root, bucket, name));
        }
      }
    } catch {
      // No library, or no permission. Both mean no originals, which is fine.
    }
  }

  return originalsIndex.get(filename) ?? null;
}

export interface TriageOptions {
  readonly principalId: string;
  /** Overridable so a test can drive the cascade without images on disk. */
  readonly engine?: OcrEngine | undefined;
  /**
   * Where an asset's file is, overridable for the same reason.
   *
   * Two seams rather than one, because they fail independently: an engine that
   * cannot read is a machine without OCR, and a resolver that finds nothing is
   * a library whose originals are in iCloud. Both are normal states and a test
   * needs to be able to produce either.
   */
  readonly locate?: ((raw: Record<string, unknown>) => string | null) | undefined;
  readonly ocrBudget?: number | undefined;
  readonly extractBudget?: number | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
}

export function triagePhotos(db: DB, options: TriageOptions): PhotoReport {
  const engine = options.engine ?? ocrEngine();

  const pending = db
    .prepare(
      `SELECT i.id, i.external_id, i.title, i.occurred_at
       FROM items i
       WHERE i.kind = 'photo' AND i.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM photo_text p
           WHERE p.item_id = i.id AND p.version = @version
         )
       ORDER BY i.occurred_at DESC
       LIMIT @limit`,
    )
    .all({ version: PHOTO_VERSION, limit: options.ocrBudget ?? OCR_BUDGET }) as PhotoRow[];

  const byKind: Record<string, number> = {};
  const captures: Capture[] = [];

  let withText = 0;

  const insert = db.prepare(
    `INSERT OR REPLACE INTO photo_text
       (item_id, engine, version, text, kind, signals, extracted, document_id, created_at)
     VALUES (@itemId, @engine, @version, @text, @kind, @signals, 0, NULL, @now)`,
  );

  for (const row of pending) {
    // Through `readRaw`, which handles the compression the store applies. A
    // direct read of the column returns gzip bytes, and the failure is a JSON
    // parse error rather than anything that names the cause.
    const raw = (readRaw(db, row.id) ?? {}) as Record<string, unknown>;

    const locate =
      options.locate ??
      ((entry: Record<string, unknown>) =>
        fileFor(entry) ??
        (typeof entry["filename"] === "string" ? findByName(entry["filename"]) : null));

    const path = locate(raw);

    // Recorded even when there is nothing to read, so the next run does not try
    // again. An asset whose pixels are in iCloud is not a failure to retry, it
    // is an asset with no text until it is downloaded.
    const text = path === null ? "" : (engine.read(path) ?? "");

    const verdict = classify(text);

    if (text.trim().length > 0) {
      withText += 1;
    }

    byKind[verdict.kind] = (byKind[verdict.kind] ?? 0) + 1;

    insert.run({
      itemId: row.id,
      engine: engine.id,
      version: PHOTO_VERSION,
      text,
      kind: verdict.kind,
      signals: JSON.stringify(verdict.signals),
      now: Date.now(),
    });

    if (verdict.kind !== "none") {
      captures.push({
        id: row.id,
        takenAt: row.occurred_at,
        text,
        isScreenshot: raw["screenshot"] === true,
      });
    }
  }

  // Documents, from captures that continue each other.
  const documents = group(captures);

  let stitched = 0;
  let duplicates = 0;

  const setBody = db.prepare(`UPDATE items SET body = ? WHERE id = ?`);
  const setDocument = db.prepare(`UPDATE photo_text SET document_id = ? WHERE item_id = ?`);

  for (const document of documents) {
    const owner = document.parts[0];

    if (owner === undefined) {
      continue;
    }

    if (document.how === "stitched") {
      stitched += 1;
    }

    if (document.how === "deduplicated") {
      duplicates += 1;
    }

    for (const part of document.parts) {
      setDocument.run(owner, part);

      // Only the first capture carries the text.
      //
      // The other halves keep their own OCR in `photo_text` and get an empty
      // body, so the term index, the anchors and the event layer see one
      // document rather than two. Without this a receipt split across two
      // screenshots has its total indexed twice and can be counted twice, which
      // is the specific double-count this whole file exists to avoid.
      setBody.run(part === owner ? document.text : null, part);
    }
  }

  const extractable = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM photo_text
         WHERE version = @version AND extracted = 0
           AND kind IN ('receipt', 'booking', 'ticket')`,
      )
      .get({ version: PHOTO_VERSION }) as { n: number }
  ).n;

  const remaining = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i
         WHERE i.kind = 'photo' AND i.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM photo_text p WHERE p.item_id = i.id AND p.version = @version
           )`,
      )
      .get({ version: PHOTO_VERSION }) as { n: number }
  ).n;

  options.onNote?.(
    `${describeEngine(engine)}; ${String(pending.length)} read, ` +
      `${String(withText)} had text, ${String(remaining)} still to read`,
  );

  void options.extractBudget;
  void purchaseKey;

  return {
    engine: engine.id,
    read: pending.length,
    withText,
    byKind,
    documents: documents.length,
    stitched,
    duplicates,
    extractable,
    remaining,
  };
}

export { EXTRACT_BUDGET, fileFor };
