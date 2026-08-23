/**
 * Saying what a situation is about.
 *
 * Everything else in `derive/` is deterministic, and this is not, so it is
 * worth being clear about what it is allowed to decide. It writes one sentence
 * describing a set of things Harbor already grouped. It does not group them, it
 * does not judge whether the grouping is right, and nothing downstream reads
 * what it wrote. If this pass never ran, every situation, every edge and every
 * piece of evidence would be exactly the same.
 *
 * That boundary is the point. `threads.ts` explains why titles are taken rather
 * than generated: a model asked to name things produces a plausible label that
 * outruns the evidence. True, and the answer is not to keep the label off the
 * screen but to keep it away from anything that reasons. A person reading a
 * situation needs to know what it is about before deciding whether to open it,
 * and "Test rename" or "+15551230001" does not tell them. The sentence sits
 * above the evidence, and the evidence is still there to contradict it.
 *
 * Local only, by task class. The payload is the most revealing thing Harbor
 * assembles: messages, mail and calendar entries about one episode of somebody's
 * life, in one prompt. A small local model writes an adequate sentence about
 * text handed to it, and no part of that is worth sending anywhere.
 */
import type { DB } from "../kernel/db.js";
import {
  setThreadSummary,
  threadNodes,
  unsummarisedThreads,
  type Thread,
} from "../store/relationships.js";
import { NodeResolver } from "../store/nodes.js";
import { nameHandles, nameTranscript } from "../store/entities.js";
import { getStream } from "../store/streams.js";
import { route } from "../reasoning/router.js";
import type { CompletionRequest } from "../reasoning/provider.js";

export interface NameOptions {
  readonly principalId: string;
  readonly timezone: string;
  /** How many situations to summarise in one pass. */
  readonly limit?: number;
  readonly onNote?: (note: string) => void;
  readonly shouldStop?: () => boolean;
}

export interface NameReport {
  readonly considered: number;
  readonly written: number;
  readonly failed: number;
  readonly tookMs: number;
}

/**
 * How much of each member the model sees.
 *
 * Enough to recognise what the thing is, not enough to make the prompt a
 * transcript. A situation with a forty-message conversation in it would
 * otherwise be most of a context window, and the opening of a conversation is
 * what says what it is about.
 */
const PER_MEMBER = 400;
const MAX_MEMBERS = 12;

/**
 * The instruction, and the words that are deliberately not in it.
 *
 * The first version of this listed what to look for: "a place, a plan, a
 * purchase, a trip". A small model read that as a menu and picked the last
 * item every time. A haircut reminder became a trip to Puerto Rico; a taxi
 * receipt became a trip to the taxi office; roughly every situation in a store
 * of fifty became "a trip". Naming the categories is what caused it, so no
 * category is named here.
 *
 * The rest is about confabulation. A model given six fragments will invent the
 * connective tissue between them unless told not to, and the invented parts are
 * the fluent, confident, wrong parts. Hence the flat prohibition on any noun
 * that is not in the text, and the explicit permission to be boring.
 */
const SYSTEM = [
  "You are given several things from one person's own messages, mail, calendar",
  "and reminders. Something already decided they belong together.",
  "",
  "Say what they are about, in one sentence of at most 25 words.",
  "",
  "Rules:",
  "- Use only names, places, dates and facts that appear in the text below.",
  "  Never introduce one that does not. If you are not certain where something",
  "  happened, do not say where it happened.",
  "- Write to the person whose things these are: 'you', not 'the user'.",
  "- Be specific and dull rather than general and interesting. 'You had dinner",
  "  with friends at Coyote Crossing twice in July' is a good answer. So is",
  "  'You bought pretzels and had a reminder to pick them up.'",
  "- If the things do not obviously belong together, say what they are rather",
  "  than inventing a reason: 'A dinner reservation and an unrelated reminder",
  "  about laundry.'",
  "",
  "Reply with the sentence and nothing else. No preamble, no quotes, no",
  "commentary about what you were given or how confident you are.",
].join("\n");

function describe(db: DB, thread: Thread, timezone: string): string | null {
  const resolver = new NodeResolver(db);
  const lines: string[] = [];

  for (const ref of threadNodes(db, thread.id).slice(0, MAX_MEMBERS)) {
    const node = resolver.node(ref);

    if (node === null) {
      continue;
    }

    const stream = getStream(db, node.streamId);
    const when = new Date(node.occurredAt).toLocaleDateString("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    // Handles become names before the model sees them. It cannot resolve
    // "+15551230001" into anybody, and a prompt full of phone numbers produces
    // a sentence full of phone numbers.
    const title = nameHandles(db, node.title ?? "");
    const text = nameTranscript(db, node.text).slice(0, PER_MEMBER);

    lines.push(
      `[${stream?.connectorId ?? "unknown"}, ${when}] ${title}\n${text}`.trim(),
    );
  }

  return lines.length === 0 ? null : lines.join("\n\n");
}

export async function nameSituations(db: DB, options: NameOptions): Promise<NameReport> {
  const started = Date.now();
  const pending = unsummarisedThreads(db, options.principalId, options.limit ?? 25);

  let written = 0;
  let failed = 0;
  let consecutive = 0;

  for (const thread of pending) {
    if (options.shouldStop?.() === true) {
      break;
    }

    // Three failures in a row is not three unlucky situations, it is a missing
    // API key or a model server that is down, and the next twenty-two calls
    // will fail the same way. Stopping says it once instead of twenty-five
    // times, and everything stays unsummarised for the next pass to pick up.
    if (consecutive >= 3) {
      options.onNote?.("stopping: three failed in a row, so something is wrong upstream");
      break;
    }

    const body = describe(db, thread, options.timezone);

    if (body === null) {
      continue;
    }

    const request: CompletionRequest = {
      system: SYSTEM,
      messages: [{ role: "user", content: body }],
      maxTokens: 220,
    };

    let routed;

    try {
      routed = await route(db, "situation.summarize", request, {
        principalId: options.principalId,
      });
    } catch (error) {
      // One situation failing is not the pass failing. It stays unsummarised
      // and is picked up next run, the same contract every other pass honours.
      options.onNote?.(`could not summarise ${thread.id}: ${String(error)}`);
      failed += 1;
      consecutive += 1;
      continue;
    }

    const text = routed.result.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const summary = tidy(text);

    if (summary === null) {
      // The model answered and the answer was unusable. That is a different
      // thing from the call failing, and it should not count toward giving up:
      // one refusal among twenty good summaries is normal.
      failed += 1;
      continue;
    }

    setThreadSummary(db, thread.id, summary);
    written += 1;
    consecutive = 0;
  }

  return {
    considered: pending.length,
    written,
    failed,
    tookMs: Date.now() - started,
  };
}

/**
 * What a small model actually returns, made into one sentence or nothing.
 *
 * Local models preface things. They open with "Sure!", they wrap the answer in
 * quotes, they add a second sentence of advice nobody asked for. Rejecting
 * those outright would mean most situations never get a summary; taking the
 * first sentence and stripping the wrapper keeps the useful part. Anything left
 * that is too short, too long, or still talking about itself is dropped, and no
 * summary is a better outcome than a wrong one.
 */
export function tidy(text: string): string | null {
  let out = text.trim();

  // A leading "Sure, here you go:" and similar.
  // The terminator has to include "!", because "Sure!" is what a 3B model says
  // and without it the first-sentence rule below takes "Sure!" as the whole
  // answer, finds it too short, and throws away a perfectly good summary.
  const colon = /^(sure|certainly|of course|here(?: is|'s)?[^:!]{0,40}|summary)\s*[:,!]\s*/i;
  out = out.replace(colon, "").trim();

  out = out.replace(/^["'\u201c\u2018]+/, "").replace(/["'\u201d\u2019]+$/, "").trim();

  // First sentence only. The instruction says one; models give two.
  const stop = /[.!?](\s|$)/.exec(out);

  if (stop !== null) {
    out = out.slice(0, stop.index + 1).trim();
  }

  if (out.length < 12 || out.length > 240) {
    return null;
  }

  // Talking about the task, or about its own confidence, rather than about the
  // situation. Every phrase here came back from a real run: "These belong to
  // you, but I don't see any explicit indication...", "It appears it's about...",
  // "These are items for...". All fluent, all useless, all passed the first
  // version of this filter because it only looked for "the user".
  const meta =
    /\b(as an ai|language model|i cannot|i'm sorry|i don't see|i do not see|the user|these messages|these items|these are items|the text below|it appears|it seems|based on the|appears to be about|belong to you)\b/i;

  if (meta.test(out)) {
    return null;
  }

  return out;
}
