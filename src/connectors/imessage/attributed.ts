/**
 * Pulling text out of `attributedBody`.
 *
 * Modern macOS often leaves `message.text` NULL and puts the content in
 * `attributedBody`, an NSArchiver `streamtyped` blob holding a serialized
 * NSAttributedString. Getting this wrong is the worst kind of failure: the
 * connector reports success and the store is empty. On a real Mac the first
 * version of this recovered twelve messages out of sixteen thousand.
 *
 * Fully decoding NSKeyedArchiver would mean implementing a format Apple does
 * not document and changes without announcement. So this is layered instead:
 * three strategies from most precise to most desperate, each validated before
 * it is accepted. Layering is the point. Any single heuristic will meet a blob
 * it does not recognise, and the cost of that should be one message rather than
 * a mailbox.
 */

/** Class names the archive uses. Never message content. */
const CLASS_NAMES =
  /^(NS|__kIM|kIM|IM|streamtyped|iI|\+|\$)|^(Mutable)?(String|Dictionary|Attributed|Object|Number|Array|Value)$/;

/** Length prefixes: bare byte, 0x81 + uint16, 0x82 + uint32. */
interface Prefix {
  readonly length: number;
  readonly start: number;
}

function readLength(blob: Buffer, at: number): Prefix | null {
  const first = blob[at];

  if (first === undefined) {
    return null;
  }

  if (first > 0 && first < 0x80) {
    return { length: first, start: at + 1 };
  }

  if (first === 0x81 && at + 2 < blob.length) {
    return { length: blob.readUInt16LE(at + 1), start: at + 3 };
  }

  if (first === 0x82 && at + 4 < blob.length) {
    return { length: blob.readUInt32LE(at + 1), start: at + 5 };
  }

  return null;
}

/**
 * Is this plausible message text rather than archive scaffolding?
 *
 * Control characters other than the usual whitespace mean the length prefix was
 * misread and we are looking at binary. Replacement characters mean the slice
 * cut a multi-byte sequence in half.
 */
function plausible(text: string): boolean {
  if (text.length === 0 || text.length > 20_000) {
    return false;
  }

  if (CLASS_NAMES.test(text)) {
    return false;
  }

  if (text.includes("\uFFFD")) {
    return false;
  }

  // eslint-disable-next-line no-control-regex
  const control = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g);

  return control === null || control.length / text.length < 0.02;
}

function candidatesAfter(blob: Buffer, marker: Buffer): string[] {
  const found: string[] = [];
  let search = 0;

  for (let guard = 0; guard < 64; guard += 1) {
    const at = blob.indexOf(marker, search);

    if (at === -1) {
      break;
    }

    search = at + marker.length;

    // The text follows a `+` (0x2b) type marker a short distance after the
    // class name. The gap varies between macOS versions, which is why this
    // scans rather than assuming a fixed offset.
    for (let offset = 0; offset < 16; offset += 1) {
      const plus = search + offset;

      if (blob[plus] !== 0x2b) {
        continue;
      }

      const prefix = readLength(blob, plus + 1);

      if (prefix === null || prefix.start + prefix.length > blob.length) {
        continue;
      }

      const text = blob.subarray(prefix.start, prefix.start + prefix.length).toString("utf8");

      if (plausible(text)) {
        found.push(text);
      }

      break;
    }
  }

  return found;
}

/**
 * Every length-prefixed string in the blob.
 *
 * The fallback for archives whose class names are laid out unexpectedly. It
 * finds far more than it should and relies on validation plus taking the
 * longest, which in an attributed string is reliably the body: the other
 * entries are attribute names and font identifiers, all short.
 */
function everyString(blob: Buffer): string[] {
  const found: string[] = [];

  for (let at = 0; at < blob.length - 1; at += 1) {
    if (blob[at] !== 0x2b) {
      continue;
    }

    const prefix = readLength(blob, at + 1);

    if (prefix === null || prefix.length < 2 || prefix.start + prefix.length > blob.length) {
      continue;
    }

    const text = blob.subarray(prefix.start, prefix.start + prefix.length).toString("utf8");

    if (plausible(text)) {
      found.push(text);
    }
  }

  return found;
}

/**
 * The last resort: the longest run of printable text in the blob.
 *
 * No structure assumed at all. This will occasionally include a trailing byte
 * of scaffolding, which is a far better outcome than losing the message.
 */
function longestPrintableRun(blob: Buffer): string | null {
  const text = blob.toString("utf8");
  const runs = text.match(/[\p{L}\p{N}\p{P}\p{Zs}\p{S}\p{Emoji}]{4,}/gu);

  if (runs === null) {
    return null;
  }

  const usable = runs
    .map((run) => run.trim())
    .filter((run) => plausible(run) && /[\p{L}\p{N}]/u.test(run));

  if (usable.length === 0) {
    return null;
  }

  return usable.reduce((longest, run) => (run.length > longest.length ? run : longest));
}

export function extractText(blob: Buffer | null | undefined): string | null {
  if (blob === null || blob === undefined || blob.length === 0) {
    return null;
  }

  // Most precise first. NSMutableString appears in place of NSString on some
  // versions, and checking both costs nothing.
  for (const marker of ["NSString", "NSMutableString"]) {
    const found = candidatesAfter(blob, Buffer.from(marker, "utf8"));

    if (found.length > 0) {
      return longest(found);
    }
  }

  const anywhere = everyString(blob);

  if (anywhere.length > 0) {
    return longest(anywhere);
  }

  return longestPrintableRun(blob);
}

function longest(candidates: readonly string[]): string {
  return candidates.reduce((best, entry) => (entry.length > best.length ? entry : best));
}

/**
 * Apple epoch to unix milliseconds.
 *
 * Two eras in one column. Before macOS Sierra the value was seconds since
 * 2001-01-01; since then it is nanoseconds. Reading one as the other puts
 * messages in the wrong century, so the magnitude decides.
 */
export function appleDate(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value === 0) {
    return null;
  }

  const APPLE_EPOCH_OFFSET = 978_307_200_000;

  const milliseconds = value > 1e11 ? value / 1_000_000 : value * 1000;

  return Math.round(milliseconds) + APPLE_EPOCH_OFFSET;
}
