/**
 * Two screenshots of one receipt.
 *
 * The specific problem: a receipt is longer than a phone screen, so people take
 * the top of it and then the bottom of it, and the two overlap in the middle.
 * Treating them as two documents double-counts everything in the overlap, which
 * on a receipt means the total appears twice and the line items appear twice.
 * Treating them as one document requires knowing where one ends and the other
 * begins.
 *
 * ## Why this is not a similarity problem
 *
 * The obvious approach is to cluster screenshots by how much text they share.
 * That is the approach this codebase spent an entire pass arguing against, for
 * the same reason as before: similarity is transitive when you cluster on it,
 * and three screenshots of three different receipts from the same shop share
 * the header, the address and the VAT line. Cluster on overlap and they fuse.
 *
 * What actually distinguishes two halves of one receipt from two receipts is
 * not how much they share. It is that they were captured seconds apart, in
 * order, as one act. So stitching follows the capture sequence: only screenshots
 * adjacent in time are considered, and a chain extends one link at a time. That
 * mirrors the physical process rather than approximating it, and it cannot
 * chain across a gap because the gap is the thing being checked.
 *
 * ## The stitch itself
 *
 * Sequence overlap on lines, not set overlap. The bottom N lines of the first
 * shot should be the top N lines of the second, and finding the largest N that
 * matches tells you exactly where to join them. Set overlap would say the same
 * thing about a receipt photographed twice from different angles, which is a
 * duplicate rather than a continuation and wants the longer of the two rather
 * than a concatenation.
 *
 * OCR output is noisy, so line matching is normalised and fuzzy at the edges: a
 * line that differs by a character or two is the same line, because it is.
 */

/** How far apart two captures can be and still be one act. */
const CHAIN_WINDOW_MS = 120_000;

/** The fewest matching lines that count as a real overlap rather than a coincidence. */
const MIN_OVERLAP_LINES = 2;

/**
 * How similar two lines must be to be the same line.
 *
 * OCR reads the same pixels differently at different crops, so exact equality
 * loses most real overlaps. A ratio rather than a distance, because a long line
 * can absorb more errors than a short one before it stops being itself.
 */
const LINE_SIMILARITY = 0.85;

export interface Capture {
  readonly id: string;
  readonly takenAt: number;
  readonly text: string;
  readonly isScreenshot: boolean;
}

export interface Document {
  /** Every capture that went into it, in capture order. */
  readonly parts: readonly string[];
  readonly text: string;
  readonly takenAt: number;
  /** How the parts were combined, for the explanation shown to a person. */
  readonly how: "single" | "stitched" | "deduplicated";
  readonly note: string | null;
}

function lines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Comparable form. Case and punctuation are where OCR disagrees with itself. */
function normalize(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similar(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);

  if (left === right) {
    return true;
  }

  if (left.length === 0 || right.length === 0) {
    return false;
  }

  // Cheap edit-distance ratio. A full Levenshtein over every line pair is
  // quadratic in a place where the inputs are OCR output and can be long, and
  // the discrimination this needs is coarse: same line or not.
  const longer = left.length >= right.length ? left : right;
  const shorter = left.length >= right.length ? right : left;

  if (longer.includes(shorter) && shorter.length / longer.length >= LINE_SIMILARITY) {
    return true;
  }

  let matched = 0;

  for (let index = 0; index < shorter.length; index += 1) {
    if (shorter[index] === longer[index]) {
      matched += 1;
    }
  }

  return matched / longer.length >= LINE_SIMILARITY;
}

/**
 * The largest N where the last N lines of `first` are the first N lines of
 * `second`.
 *
 * Zero when they do not continue each other. Searched from the largest possible
 * overlap down, because the largest true overlap is the right join: a shorter
 * accidental match near the end would drop everything between.
 */
export function overlapLength(first: readonly string[], second: readonly string[]): number {
  const most = Math.min(first.length, second.length);

  for (let size = most; size >= MIN_OVERLAP_LINES; size -= 1) {
    let matches = true;

    for (let index = 0; index < size; index += 1) {
      if (!similar(first[first.length - size + index] ?? "", second[index] ?? "")) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return size;
    }
  }

  return 0;
}

/** How much of the shorter one appears in the longer one, ignoring order. */
export function containment(first: readonly string[], second: readonly string[]): number {
  const [shorter, longer] = first.length <= second.length ? [first, second] : [second, first];

  if (shorter.length === 0) {
    return 0;
  }

  const held = longer.map(normalize);

  let found = 0;

  for (const line of shorter) {
    if (held.some((other) => similar(line, other))) {
      found += 1;
    }
  }

  return found / shorter.length;
}

/**
 * Whether the second capture continues, repeats, or has nothing to do with the
 * first.
 *
 * Order matters and is checked both ways: people screenshot the bottom of a
 * receipt first about as often as they get it right.
 */
function relate(
  first: readonly string[],
  second: readonly string[],
): { kind: "continues"; at: number } | { kind: "duplicate" } | { kind: "unrelated" } {
  const forward = overlapLength(first, second);
  const backward = overlapLength(second, first);

  const shared = containment(first, second);

  // A near-total containment is a duplicate, not a continuation: the second
  // shot added nothing. Checked first, because a duplicate also has a large
  // sequence overlap and would otherwise be concatenated with itself.
  if (shared >= 0.9) {
    return { kind: "duplicate" };
  }

  if (forward >= MIN_OVERLAP_LINES && forward >= backward) {
    return { kind: "continues", at: forward };
  }

  if (backward >= MIN_OVERLAP_LINES) {
    return { kind: "continues", at: -backward };
  }

  return { kind: "unrelated" };
}

/**
 * Groups captures into documents.
 *
 * Sorted by capture time, then chained forward one link at a time. A capture
 * joins the document being built only if it relates to the *previous* capture
 * and was taken within the window; otherwise it starts a new document. That is
 * what keeps this from being transitive clustering: three receipts from the
 * same shop share their header and would cluster together on similarity, and
 * they cannot chain because they were not taken one after another.
 */
export function group(captures: readonly Capture[]): readonly Document[] {
  const ordered = [...captures].sort((a, b) => a.takenAt - b.takenAt);
  const documents: Document[] = [];

  let current: { parts: string[]; lines: string[]; takenAt: number; how: Document["how"]; note: string | null } | null =
    null;

  const flush = (): void => {
    if (current === null) {
      return;
    }

    documents.push({
      parts: current.parts,
      text: current.lines.join("\n"),
      takenAt: current.takenAt,
      how: current.how,
      note: current.note,
    });

    current = null;
  };

  for (const capture of ordered) {
    const own = lines(capture.text);

    if (current === null) {
      current = {
        parts: [capture.id],
        lines: [...own],
        takenAt: capture.takenAt,
        how: "single",
        note: null,
      };

      continue;
    }

    const gap = capture.takenAt - (ordered.find((entry) => entry.id === current?.parts.at(-1))?.takenAt ?? 0);

    // Only screenshots chain. A photograph of a receipt taken twice is a
    // duplicate and handled as one; a photograph followed by an unrelated
    // photograph two seconds later is the normal way people use a camera.
    if (!capture.isScreenshot || gap > CHAIN_WINDOW_MS) {
      flush();

      current = {
        parts: [capture.id],
        lines: [...own],
        takenAt: capture.takenAt,
        how: "single",
        note: null,
      };

      continue;
    }

    const relation = relate(current.lines, own);

    if (relation.kind === "unrelated") {
      flush();

      current = {
        parts: [capture.id],
        lines: [...own],
        takenAt: capture.takenAt,
        how: "single",
        note: null,
      };

      continue;
    }

    if (relation.kind === "duplicate") {
      // Keep whichever read more. Two shots of the same screen differ only in
      // how much the OCR got, and there is no reason to prefer the earlier.
      current.parts.push(capture.id);
      current.how = "deduplicated";
      current.note = `${String(current.parts.length)} captures of the same thing`;

      if (own.length > current.lines.length) {
        current.lines = [...own];
      }

      continue;
    }

    if (relation.at > 0) {
      current.lines = [...current.lines, ...own.slice(relation.at)];
    } else {
      current.lines = [...own.slice(0, own.length + relation.at), ...current.lines];
    }

    current.parts.push(capture.id);
    current.how = "stitched";
    current.note = `${String(current.parts.length)} screenshots of one document, joined on ${String(
      Math.abs(relation.at),
    )} shared lines`;
  }

  flush();

  return documents;
}
