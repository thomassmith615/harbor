/**
 * Attachments, stored as text rather than as bytes.
 *
 * A large share of real receipts, statements, and confirmations arrive as a PDF
 * with an email body that says little more than "your receipt is attached".
 * Without the attachment those items are invisible to search and worthless to
 * the projection layer.
 *
 * Keeping the bytes was the obvious design and is the wrong one. A mailbox of
 * PDFs would multiply the database for content nobody reads directly, and the
 * bytes are re-fetchable from the mail server while the extracted text is what
 * every layer above actually consumes. The digest is kept so a later pass can
 * tell whether a file genuinely changed.
 *
 * Extraction never throws. An attachment Harbor cannot read records why and
 * moves on, because a corrupt PDF in a mailbox of thirty thousand messages must
 * not be able to stop an ingest.
 */
import { createHash } from "node:crypto";
import type { DB } from "../kernel/db.js";

export const ATTACHMENT_TEXT_VERSION = 1;

/** Beyond this, an attachment is a file rather than a document. */
const MAX_EXTRACT_BYTES = 5 * 1_024 * 1_024;

/** How much text is kept from any one attachment. */
const MAX_TEXT_CHARS = 40_000;

export interface AttachmentInput {
  readonly itemId: string;
  readonly filename: string | null;
  readonly mime: string | null;
  readonly content: Buffer | null;
  readonly sizeBytes: number;
}

export interface StoredAttachment {
  readonly id: string;
  readonly filename: string | null;
  readonly mime: string | null;
  readonly sizeBytes: number;
  readonly textLength: number;
  readonly error: string | null;
}

function attachmentId(itemId: string, filename: string | null, sha: string | null): string {
  return `at_${createHash("sha256")
    .update(`${itemId}|${filename ?? ""}|${sha ?? ""}`)
    .digest("hex")
    .slice(0, 16)}`;
}

/** HTML to something a person, or a regex, can read. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Text out of a PDF.
 *
 * The parser is imported lazily and its absence is not an error. Harbor should
 * install and run without a PDF dependency, and a mailbox with no PDF receipts
 * should never pay for one. When the module is missing the attachment records
 * that it was skipped, which is visible in `harbor attachments` and fixable
 * with one npm install.
 */
async function pdfToText(content: Buffer): Promise<{ text: string | null; error: string | null }> {
  try {
    // Specifier built at run time so the type checker does not require the
    // package to be present. It is an optional dependency by design: Harbor
    // installs and runs without it, and a mailbox with no PDFs never needs it.
    const specifier = "pdf-parse";
    const module_ = (await import(specifier)) as unknown as {
      default: (data: Buffer) => Promise<{ text: string }>;
    };

    const parsed = await module_.default(content);

    return { text: parsed.text, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/cannot find (module|package)/i.test(message)) {
      return { text: null, error: "pdf-parse not installed (npm install pdf-parse)" };
    }

    return { text: null, error: `pdf could not be read: ${message.slice(0, 120)}` };
  }
}

export async function extractAttachmentText(
  filename: string | null,
  mime: string | null,
  content: Buffer,
): Promise<{ text: string | null; error: string | null }> {
  if (content.length > MAX_EXTRACT_BYTES) {
    return { text: null, error: "larger than the extraction limit" };
  }

  const type = (mime ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();

  if (type.includes("pdf") || name.endsWith(".pdf")) {
    return pdfToText(content);
  }

  if (type.startsWith("text/html") || name.endsWith(".html") || name.endsWith(".htm")) {
    return { text: htmlToText(content.toString("utf8")), error: null };
  }

  if (
    type.startsWith("text/") ||
    name.endsWith(".txt") ||
    name.endsWith(".csv") ||
    type.includes("json")
  ) {
    return { text: content.toString("utf8"), error: null };
  }

  // Images, archives, calendar invites, and everything else. Recorded so the
  // attachment is visible, with no text and no error: not being readable is not
  // a failure.
  return { text: null, error: null };
}

export async function saveAttachment(db: DB, input: AttachmentInput): Promise<string> {
  const sha =
    input.content === null ? null : createHash("sha256").update(input.content).digest("hex");

  const id = attachmentId(input.itemId, input.filename, sha);

  let text: string | null = null;
  let error: string | null = null;

  if (input.content !== null) {
    const extracted = await extractAttachmentText(input.filename, input.mime, input.content);
    text = extracted.text === null ? null : extracted.text.slice(0, MAX_TEXT_CHARS);
    error = extracted.error;
  }

  db.prepare(
    `INSERT INTO attachments
       (id, item_id, filename, mime, size_bytes, sha256, text, text_version, extract_error, created_at)
     VALUES (@id, @itemId, @filename, @mime, @size, @sha, @text, @version, @error, @now)
     ON CONFLICT (id) DO UPDATE SET
       text = excluded.text,
       text_version = excluded.text_version,
       extract_error = excluded.extract_error`,
  ).run({
    id,
    itemId: input.itemId,
    filename: input.filename,
    mime: input.mime,
    size: input.sizeBytes,
    sha,
    text,
    version: text === null ? null : ATTACHMENT_TEXT_VERSION,
    error,
    now: Date.now(),
  });

  return id;
}

/**
 * All extracted attachment text for one item, concatenated.
 *
 * Returns null rather than an empty string when there is nothing, so callers
 * can tell "no attachments" from "an attachment with no words in it".
 */
export function attachmentTextFor(db: DB, itemId: string): string | null {
  const rows = db
    .prepare(
      `SELECT text FROM attachments WHERE item_id = ? AND text IS NOT NULL AND text <> ''`,
    )
    .all(itemId) as { text: string }[];

  if (rows.length === 0) {
    return null;
  }

  return rows.map((row) => row.text).join("\n\n");
}

export function attachmentsFor(db: DB, itemId: string): readonly StoredAttachment[] {
  const rows = db
    .prepare(
      `SELECT id, filename, mime, size_bytes, LENGTH(COALESCE(text, '')) AS len, extract_error
       FROM attachments WHERE item_id = ? ORDER BY filename`,
    )
    .all(itemId) as {
    id: string;
    filename: string | null;
    mime: string | null;
    size_bytes: number;
    len: number;
    extract_error: string | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    textLength: row.len,
    error: row.extract_error,
  }));
}

export interface AttachmentSummary {
  readonly total: number;
  readonly withText: number;
  readonly failed: number;
  readonly bytes: number;
  readonly byType: readonly { readonly mime: string; readonly count: number }[];
}

export function attachmentSummary(db: DB): AttachmentSummary {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN text IS NOT NULL AND text <> '' THEN 1 ELSE 0 END) AS withText,
              SUM(CASE WHEN extract_error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(size_bytes), 0) AS bytes
       FROM attachments`,
    )
    .get() as { total: number; withText: number | null; failed: number | null; bytes: number };

  const byType = db
    .prepare(
      `SELECT COALESCE(mime, 'unknown') AS mime, COUNT(*) AS count FROM attachments
       GROUP BY COALESCE(mime, 'unknown') ORDER BY count DESC LIMIT 8`,
    )
    .all() as { mime: string; count: number }[];

  return {
    total: totals.total,
    withText: totals.withText ?? 0,
    failed: totals.failed ?? 0,
    bytes: totals.bytes,
    byType,
  };
}
