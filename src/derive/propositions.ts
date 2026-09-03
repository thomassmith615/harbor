/**
 * Making a short message mean something on its own.
 *
 * This is the preprocessing step that fixes the bits-and-pieces problem, and
 * the problem is worth stating precisely because the fix looks like cheating
 * until it is.
 *
 * "yeah I'm going" is four words. Two of them are stopwords, one is a pronoun,
 * and the fourth is the most common verb in English. It carries no distinctive
 * term, so the term index cannot anchor it. It embeds close to every other
 * agreement anybody has ever sent, so a vector cannot separate it. It shares no
 * vocabulary with the evening it belongs to, so no linker can join it. Every
 * retrieval mechanism Harbor has fails on it for the same underlying reason:
 * the meaning is not in the message, it is in the message plus what came
 * before, and only one of those is being indexed.
 *
 * A proposition is that message rewritten with its context folded in. *Thomas
 * agreed to go to the bar with Dave, Sam and Nina.* That sentence has proper
 * nouns, a verb that means something, and vocabulary shared with the
 * confirmation, the reminder and the plan. It is findable by every mechanism
 * the original defeated, and it took a 3B model a fraction of a second to
 * write.
 *
 * ## The obvious objection
 *
 * This produces text nobody wrote, and Harbor's entire discipline is that a
 * claim can be checked against the words somebody used. That objection is
 * right, and the answer is that a proposition is never shown and never quoted.
 * It lives in the retrieval index and nowhere else. It is a key by which the
 * real message is found, and what a person reads afterwards is always the real
 * message. `sourceLine` is stored alongside precisely so that anything
 * surfacing a hit can show the original instead.
 *
 * The failure mode this leaves is a proposition that is subtly wrong sending a
 * search to the wrong message. That is a bad search result, which is recoverable
 * and visible. It is not a false claim in an answer, which is neither.
 *
 * ## What gets rewritten
 *
 * Only messages that are short, conversational, and near something with
 * content. A long email already carries its own meaning and rewriting it would
 * lose detail while costing a forward pass. The gate is deliberately tight:
 * the value here is concentrated in exactly the messages that are useless
 * alone, and those are cheap to identify.
 */
import { route } from "../reasoning/router.js";
import { linesOf } from "./plans.js";
import { pendingPropositions, savePropositions } from "../store/propositions.js";
import type { DB } from "../kernel/db.js";

/** Bump to rewrite every proposition again. */
export const PROPOSITION_VERSION = 1;

/**
 * Longer than this and a message says enough by itself.
 *
 * A hundred and forty characters is about a sentence and a half. Above it a
 * message reliably contains a noun somebody could search for; below it, more
 * often than not, it does not.
 */
const SHORT_ENOUGH = 140;

/**
 * How many neighbouring lines a rewrite may see.
 *
 * Enough to resolve a pronoun and a referent, not enough to import a different
 * subject. Six either side covers the overwhelming majority of "what does this
 * refer to" cases in real message data; twenty would start folding the phone
 * charger into the plan.
 */
const CONTEXT_LINES = 6;

/**
 * Messages that are short and still carry their own meaning.
 *
 * A number, a name, an address, a time. Rewriting these buys nothing because
 * the thing worth finding is already present, and the rewrite would only add a
 * chance of getting it wrong.
 */
const SELF_SUFFICIENT = /\d{3}|[A-Z]{2,}|@|https?:|\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/;

/**
 * Words that are long enough to look like content and are not.
 *
 * Deliberately small and conversational rather than a general stopword list:
 * these are the words that make short replies look substantive to a
 * length-based filter. A general list would start removing words that genuinely
 * distinguish a message.
 */
const EMPTY = new Set([
  "yeah", "yes", "okay", "sure", "cool", "nice", "same", "true", "sounds",
  "good", "great", "fine", "well", "just", "actually", "really", "maybe",
  "going", "gonna", "went", "come", "coming", "want", "know", "think", "sorry",
  "haha", "lmao", "thanks", "thank", "please", "there", "here", "that", "this",
  "have", "will", "with", "your", "mine", "them", "they", "were", "been",
  "what", "when", "then", "than", "also", "much", "very", "some", "like",
]);

export function worthRewriting(line: string): boolean {
  const text = line.trim();

  if (text.length === 0 || text.length > SHORT_ENOUGH) {
    return false;
  }

  if (SELF_SUFFICIENT.test(text)) {
    return false;
  }

  // Words long enough to be indexed *and* uncommon enough to be worth
  // indexing. Length alone is the wrong test and it fails on the flagship
  // case: "yeah I'm going" has two words of four letters or more and is the
  // single most meaningless message in the store. What makes a message
  // findable is a word that distinguishes it, and the commonest hundred
  // conversational words distinguish nothing.
  const contentful = text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/\W/g, ""))
    .filter((word) => word.length >= 4 && !EMPTY.has(word));

  return contentful.length < 2;
}

export interface Proposition {
  /** Which line of the transcript this rewrites. */
  readonly ordinal: number;
  /** The words somebody actually wrote. Always what gets shown. */
  readonly sourceLine: string;
  /** The standalone rewrite. Indexed, never displayed. */
  readonly text: string;
}

const SYSTEM = `You rewrite short chat messages so they make sense on their own.

You are given a numbered conversation and a list of line numbers to rewrite. For
each one, write a single sentence stating what that message means, using the names
and details from the surrounding lines instead of pronouns and references.

Rules:
- One sentence per line, stating only what that message says. Never summarise the
  conversation and never add anything the messages do not say.
- Replace pronouns and references with the names they refer to: "he" becomes the
  person's name, "there" becomes the place, "then" becomes the time as it was
  written.
- Use "Thomas" for the speaker labelled Me.
- Keep the original words where they are already specific. Do not paraphrase a
  name, a time or a place into a different one.
- If a line still cannot be made to stand alone, return null for it rather than
  guessing what it meant.

Respond with JSON only, no prose and no code fences:
{"lines":[{"n":11,"text":"..."},{"n":14,"text":null}]}`;

interface ModelLine {
  readonly n?: unknown;
  readonly text?: unknown;
}

/**
 * The lines in a transcript worth rewriting, with their context.
 *
 * Returned rather than rewritten so the caller can decide whether a model call
 * is worth it: a transcript with one candidate line is usually not.
 */
export function candidates(transcript: string): readonly { ordinal: number; text: string }[] {
  return linesOf(transcript)
    .filter((line) => worthRewriting(line.text))
    .map((line) => ({ ordinal: line.index, text: line.text }));
}

/**
 * Numbers every line, so the model can refer to one without repeating it.
 *
 * Numbering rather than quoting is what keeps the output checkable. A model
 * that has to name a line number cannot invent a message that was not there,
 * and a returned number outside the range is a rejection rather than a
 * mystery.
 */
function numbered(transcript: string, wanted: ReadonlySet<number>): string {
  const lines = linesOf(transcript);
  const keep = new Set<number>();

  for (const ordinal of wanted) {
    for (let offset = -CONTEXT_LINES; offset <= CONTEXT_LINES; offset += 1) {
      keep.add(ordinal + offset);
    }
  }

  return lines
    .filter((line) => keep.has(line.index))
    .map((line) => `${String(line.index)}. ${line.speaker}: ${line.text}`)
    .join("\n");
}

export interface RewriteResult {
  readonly propositions: readonly Proposition[];
  readonly rejected: readonly string[];
}

/**
 * Rewrites the short lines of one transcript.
 *
 * Every returned line is checked three ways: the number has to be one that was
 * asked for, the rewrite has to be longer than the original (a rewrite that is
 * shorter has dropped the context that was the entire point), and it has to
 * differ from the original (a model that echoes the input has understood
 * nothing and the echo would be indexed as though it were an improvement).
 */
export async function rewrite(
  db: DB,
  transcript: string,
  principalId: string,
): Promise<RewriteResult> {
  const wanted = candidates(transcript);

  if (wanted.length === 0) {
    return { propositions: [], rejected: [] };
  }

  const ordinals = new Set(wanted.map((line) => line.ordinal));

  const routed = await route(
    db,
    "extract.structured",
    {
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `${numbered(transcript, ordinals)}\n\n` +
            `Rewrite lines: ${[...ordinals].join(", ")}`,
        },
      ],
    },
    { principalId, pipelineVersion: PROPOSITION_VERSION },
  );

  const text = routed.result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  let parsed: { lines?: readonly ModelLine[] };

  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()) as {
      lines?: readonly ModelLine[];
    };
  } catch {
    return { propositions: [], rejected: ["the model did not return JSON"] };
  }

  const byOrdinal = new Map(wanted.map((line) => [line.ordinal, line.text]));
  const propositions: Proposition[] = [];
  const rejected: string[] = [];

  for (const line of parsed.lines ?? []) {
    const ordinal = typeof line.n === "number" ? line.n : Number.NaN;
    const rewritten = typeof line.text === "string" ? line.text.trim() : "";

    const source = byOrdinal.get(ordinal);

    if (source === undefined) {
      rejected.push(`line ${String(ordinal)} was not one of the lines asked for`);
      continue;
    }

    if (rewritten.length === 0) {
      // The model declining is a valid answer and the prompt asks for it. Some
      // messages genuinely cannot be made to stand alone.
      continue;
    }

    if (rewritten.length <= source.length) {
      rejected.push(`line ${String(ordinal)}: the rewrite added no context`);
      continue;
    }

    if (rewritten.toLowerCase() === source.toLowerCase()) {
      rejected.push(`line ${String(ordinal)}: the model echoed the input`);
      continue;
    }

    propositions.push({ ordinal, sourceLine: source, text: rewritten });
  }

  return { propositions, rejected };
}

/* -------------------------------------------------------------------------
 * The pass.
 * ---------------------------------------------------------------------- */

export interface ProposeReport {
  readonly considered: number;
  readonly read: number;
  readonly written: number;
  readonly failed: number;
  readonly rejected: readonly string[];
}

export interface ProposeOptions {
  readonly principalId: string;
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
}

/**
 * Rewrites the short messages in every conversation a model has not read.
 *
 * Newest first, because a budget spent on last week is worth more than a budget
 * spent on 2019, and because the first run of this over a decade of history
 * would otherwise begin at the least useful end.
 *
 * An episode whose propositions change is marked for re-derivation rather than
 * re-embedded here. That keeps one pass responsible for chunking and embedding
 * instead of two, at the cost of the improvement landing on the next derive.
 * The convergence is worth naming plainly: `harbor update` twice, or a derive
 * after this pass, is what puts the rewrites into the index.
 */
export async function proposePropositions(
  db: DB,
  options: ProposeOptions,
): Promise<ProposeReport> {
  const batch = pendingPropositions(db, PROPOSITION_VERSION, options.limit ?? 50);

  const rejected: string[] = [];
  let read = 0;
  let written = 0;
  let failed = 0;

  for (const episode of batch) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const wanted = candidates(episode.transcript);

    if (wanted.length === 0) {
      // Nothing short enough to be worth rewriting. Recorded as an empty set
      // so the episode is not reconsidered on every run.
      savePropositions(db, episode.id, [], PROPOSITION_VERSION);
      continue;
    }

    read += 1;

    let result;

    try {
      result = await rewrite(db, episode.transcript, options.principalId);
    } catch (error) {
      failed += 1;
      options.onNote?.(
        `could not rewrite one conversation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    rejected.push(...result.rejected);

    savePropositions(
      db,
      episode.id,
      result.propositions.map((proposition) => ({
        ordinal: proposition.ordinal,
        sourceLine: proposition.sourceLine,
        text: proposition.text,
      })),
      PROPOSITION_VERSION,
    );

    if (result.propositions.length > 0) {
      written += result.propositions.length;

      // The window that contains these lines is now stale. Clearing the version
      // is what puts it back in front of the derive pass.
      db.prepare(`UPDATE episodes SET derived_version = NULL WHERE id = ?`).run(episode.id);
    }
  }

  return {
    considered: batch.length,
    read,
    written,
    failed,
    rejected: rejected.slice(0, 20),
  };
}
