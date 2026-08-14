/**
 * Chunking.
 *
 * Deliberately simple, because it is guaranteed to be wrong and guaranteed to
 * be replaced. Bumping PIPELINE_VERSION re-derives everything from `body`
 * without a re-sync, which is the property that makes it safe to ship a naive
 * version now.
 *
 * The one non-obvious choice: the item's title and sender are prepended to the
 * first chunk. A body chunk with no subject line embeds as generic prose, and
 * "the email from Dana about redlines" is mostly a query about the header, not
 * the body.
 */

/** Bump to re-derive everything. Chunking or embedding changes both count. */
export const PIPELINE_VERSION = 2;

const TARGET_CHARS = 1_200;
const OVERLAP_CHARS = 150;
const MIN_CHARS = 40;
/** Beyond this, an item is quoted threads and footers; embedding it adds noise. */
const MAX_CHARS_PER_ITEM = 8_000;

/**
 * Hard cap on chunks per item.
 *
 * v1 had no cap and produced 6.1 chunks per message across a real mailbox,
 * because a marketing email with stripped HTML runs to ten chunks of nearly
 * worthless text. Each one costs a forward pass and three kilobytes of vector,
 * and the tenth chunk of a newsletter has never been the answer to anything.
 * Four is generous for genuine correspondence.
 */
const MAX_CHUNKS_PER_ITEM = 4;

/**
 * Boilerplate that appears at the end of a large fraction of all email and
 * carries no signal. Cutting it before chunking is worth more than any amount
 * of cleverness afterwards.
 */
const BOILERPLATE = [
  /\bunsubscribe\b[\s\S]*$/i,
  /\bview (this email )?in (your )?browser\b[\s\S]*$/i,
  /\byou are receiving this (email|message)\b[\s\S]*$/i,
  /\bthis (e-?mail|message) (and any attachments )?(is|are) (intended|confidential)\b[\s\S]*$/i,
  /\bsent from my i(phone|pad)\b[\s\S]*$/i,
  /^\s*on .{0,80}wrote:[\s\S]*$/im,
  /^\s*-{2,}\s*original message\s*-{2,}[\s\S]*$/im,
  /^\s*>{1,}.*$/gm,
];

function stripBoilerplate(text: string): string {
  let output = text;

  for (const pattern of BOILERPLATE) {
    output = output.replace(pattern, "");
  }

  return output.replace(/\n{3,}/g, "\n\n").trim();
}

export interface ChunkInput {
  readonly title: string | null;
  readonly author: string | null;
  readonly body: string | null;
  readonly snippet: string | null;
  readonly kind: string;
}

export interface Chunk {
  readonly ordinal: number;
  readonly text: string;
}

function header(input: ChunkInput): string {
  const parts: string[] = [];

  if (input.title !== null && input.title.length > 0) {
    parts.push(input.kind === "event" ? `Event: ${input.title}` : input.title);
  }

  if (input.author !== null && input.author.length > 0) {
    parts.push(`From: ${input.author}`);
  }

  return parts.join("\n");
}

/** Splits on paragraph boundaries where possible, falling back to hard cuts. */
function split(text: string): readonly string[] {
  if (text.length <= TARGET_CHARS) {
    return [text];
  }

  const pieces: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const end = Math.min(cursor + TARGET_CHARS, text.length);

    let cut = end;

    if (end < text.length) {
      // Prefer a paragraph break, then a sentence end, then a space.
      for (const pattern of ["\n\n", ". ", " "]) {
        const found = text.lastIndexOf(pattern, end);
        if (found > cursor + TARGET_CHARS / 2) {
          cut = found + pattern.length;
          break;
        }
      }
    }

    const piece = text.slice(cursor, cut).trim();

    if (piece.length >= MIN_CHARS || pieces.length === 0) {
      pieces.push(piece);
    }

    if (cut >= text.length) {
      break;
    }

    cursor = Math.max(cut - OVERLAP_CHARS, cursor + 1);
  }

  return pieces;
}

export function chunkItem(input: ChunkInput): readonly Chunk[] {
  const source = stripBoilerplate(input.body ?? input.snippet ?? "")
    .slice(0, MAX_CHARS_PER_ITEM)
    .trim();

  const head = header(input);

  if (source.length === 0) {
    return head.length === 0 ? [] : [{ ordinal: 0, text: head }];
  }

  const pieces = split(source).slice(0, MAX_CHUNKS_PER_ITEM);

  return pieces.map((piece, index) => ({
    ordinal: index,
    // Header on the first chunk only; repeating it on all of them would make
    // every chunk of a long thread look alike to the index.
    text: index === 0 && head.length > 0 ? `${head}\n\n${piece}` : piece,
  }));
}
