/**
 * Windowing a conversation for retrieval.
 *
 * An episode was embedded by slicing its transcript every two thousand
 * characters. Two things are wrong with that and they compound.
 *
 * The slices are arbitrary. They cut mid-message and mid-sentence, so a window
 * routinely begins halfway through somebody's answer to a question it does not
 * contain, and the model embedding it has no way to know that.
 *
 * And they are too big. An embedding is an average over its input, so one
 * relevant sentence inside two thousand characters of unrelated chat gets its
 * signal divided by everything around it. A group chat that arranged an evening
 * *and* discussed a phone charger *and* mentioned somebody's sister produces
 * three slabs, each a blend of all three subjects, none of which is a good
 * match for a question about any of them. This is the dilution problem, and it
 * is why episode search has always felt approximately right and rarely exact.
 *
 * Two changes here, both cheap and neither involving a model.
 *
 * **Windows respect message boundaries and overlap.** A window is a run of
 * whole lines, around six hundred characters, with a couple of lines of overlap
 * so an exchange that straddles a boundary appears intact on one side of it.
 * Overlap costs storage and buys the case that matters most: a question in one
 * window and its answer in the next used to be two embeddings that each made
 * incomplete sense.
 *
 * **Every window carries a header.** Who is in this conversation, what it is
 * called, and when it happened, prepended to each window rather than to the
 * first one only. A window from the middle of a thread previously embedded as
 * anonymous prose: `yeah I'm going` with no indication of who said it, to whom,
 * or when. The header is what makes a mid-conversation window answerable by a
 * question like "when did I last talk to Dave about the pub". It is the same
 * reasoning that already puts an item's subject line on its first chunk,
 * applied to every window instead of one.
 *
 * What this does not do is rewrite anything. A window is still the participants'
 * own words, which keeps the store checkable: a person can read what was
 * embedded. Rewriting short messages into standalone statements is a real
 * improvement and a separate one, because it needs a model and it produces text
 * nobody wrote.
 */

/**
 * Target window size, in characters.
 *
 * Six hundred rather than two thousand. Small enough that one subject dominates
 * a window, large enough that an exchange fits: on real message data this lands
 * between six and twelve messages, which is about what a person means by "that
 * bit of the conversation".
 */
const TARGET_CHARS = 600;

/** Never split below this; a two-line window is noise with a header on it. */
const MIN_CHARS = 120;

/** Lines repeated into the next window so an exchange is never cut in half. */
const OVERLAP_LINES = 2;

/**
 * Hard ceiling per episode.
 *
 * A day-long group chat can run to hundreds of messages, and embedding every
 * window of it costs a forward pass each while the thirtieth window of a
 * hundred-message argument has never been the answer to anything. The cap
 * takes the beginning and the end rather than the beginning alone, because a
 * conversation's conclusion is usually the part worth finding.
 */
const MAX_WINDOWS = 12;

/** What a model can actually take in one go. */
export const MAX_WINDOW_CHARS = 2_000;

export interface WindowInput {
  readonly title: string | null;
  readonly transcript: string;
  readonly participants: readonly string[];
  readonly startsAt: number;
  readonly timezone: string;
  /**
   * Standalone rewrites of the short lines, keyed by line ordinal.
   *
   * Folded into the window that contains the line they rewrite, on their own
   * line, so the window gains searchable content without losing the words
   * somebody wrote. A window is embedded, not displayed, which is what makes
   * this safe: see `propositions.ts` for why the rewrite is a retrieval key
   * rather than a claim.
   */
  readonly propositions?: ReadonlyMap<number, string> | undefined;
}

export interface ConversationWindow {
  readonly ordinal: number;
  readonly text: string;
  /** The window without its header, for anything that needs the raw words. */
  readonly body: string;
}

function headerFor(input: WindowInput): string {
  const parts: string[] = [];

  if (input.title !== null && input.title.trim().length > 0) {
    parts.push(input.title.trim());
  }

  // Three names at most. A twelve-person group chat's header would otherwise
  // be longer than the window it introduces, and the embedding would be mostly
  // a list of names.
  const people = input.participants.filter((name) => name.trim().length > 0).slice(0, 3);

  if (people.length > 0) {
    parts.push(`with ${people.join(", ")}`);
  }

  const when = new Date(input.startsAt).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: input.timezone,
  });

  parts.push(when);

  return `[${parts.join(" · ")}]`;
}

/**
 * Splits a transcript into overlapping, line-aligned windows with headers.
 *
 * Deterministic and total: a transcript with no newlines comes back as one
 * window, and an empty one comes back as nothing rather than as a header with
 * no content under it.
 */
export function windowsFor(input: WindowInput): readonly ConversationWindow[] {
  const raw = input.transcript.split("\n").filter((line) => line.trim().length > 0);

  if (raw.length === 0) {
    return [];
  }

  // Interleaved rather than appended. A rewrite belongs beside the message it
  // rewrites, so that a window carrying "yeah I'm going" also carries the
  // sentence that makes it findable, and a window that does not contain the
  // message does not carry a sentence about it either.
  const lines: string[] = [];

  raw.forEach((line, ordinal) => {
    lines.push(line);

    const rewritten = input.propositions?.get(ordinal);

    if (rewritten !== undefined) {
      lines.push(`(${rewritten})`);
    }
  });

  const header = headerFor(input);
  const groups: string[][] = [];

  let current: string[] = [];
  let size = 0;

  for (const line of lines) {
    // A single line longer than the window target is a pasted block or a
    // forwarded mail. It becomes its own window rather than dragging a
    // neighbour over the limit with it.
    if (size > 0 && size + line.length > TARGET_CHARS) {
      groups.push(current);

      const carry = current.slice(-OVERLAP_LINES);

      current = [...carry];
      size = carry.reduce((total, entry) => total + entry.length + 1, 0);
    }

    current.push(line);
    size += line.length + 1;
  }

  if (current.length > 0) {
    // A final window barely longer than the overlap is entirely duplicate
    // text, so it is folded back rather than stored.
    const fresh = current.slice(OVERLAP_LINES).join("\n");

    if (groups.length > 0 && fresh.length < MIN_CHARS) {
      const last = groups[groups.length - 1];

      if (last !== undefined) {
        last.push(...current.slice(OVERLAP_LINES));
      }
    } else {
      groups.push(current);
    }
  }

  const kept = capped(groups);

  const budget = MAX_WINDOW_CHARS - header.length - 2;

  return kept.map((group, ordinal) => {
    // Trimmed by dropping whole lines, never by slicing characters. A window
    // cut mid-message reintroduces the exact defect this file exists to remove,
    // and it would do it only on the longest windows, which is the hardest
    // place to notice it.
    const lines: string[] = [];
    let size = 0;

    for (const line of group) {
      if (size + line.length + 1 > budget && lines.length > 0) {
        break;
      }

      lines.push(line);
      size += line.length + 1;
    }

    const body = lines.join("\n").slice(0, budget);

    return { ordinal, text: `${header}\n${body}`, body };
  });
}

/** Beginning and end, when there are too many. See MAX_WINDOWS. */
function capped(groups: readonly string[][]): readonly string[][] {
  if (groups.length <= MAX_WINDOWS) {
    return groups;
  }

  const head = Math.ceil(MAX_WINDOWS / 2);
  const tail = MAX_WINDOWS - head;

  return [...groups.slice(0, head), ...groups.slice(groups.length - tail)];
}
