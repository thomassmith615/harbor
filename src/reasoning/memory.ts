/**
 * Conversation memory.
 *
 * Builds the message list for a turn: the rolling summary of what came before,
 * then the turns kept verbatim, then the new question. And rolls the summary
 * forward when the verbatim window overflows.
 *
 * The summary is written by whatever tier the router picks for
 * `chat.summarize`, which will normally be the cheapest one available. That is
 * the point of having a ladder: a housekeeping task that runs after every tenth
 * question should not be paying frontier prices.
 */
import { route } from "./router.js";
import {
  appendTurn,
  MAX_REPLAYED_TURNS,
  saveSummary,
  turnsAfter,
  VERBATIM_TURNS,
} from "../store/conversations.js";
import type { DB } from "../kernel/db.js";
import type { Conversation, Turn } from "../store/conversations.js";
import type { Message } from "./provider.js";

/**
 * History as messages.
 *
 * Assistant turns are replayed as plain text rather than as their original
 * tool-call blocks. The tool results are gone by then and replaying calls
 * without results would be malformed; what matters for continuity is what was
 * said, not how it was found.
 */
export function historyMessages(db: DB, conversation: Conversation): readonly Message[] {
  const messages: Message[] = [];
  const stored = turnsAfter(db, conversation.id, conversation.summarizedThrough);

  // The cap, in case summarization is not running. Keeps cost flat rather than
  // letting a long conversation grow until it fails.
  const truncated = stored.length > MAX_REPLAYED_TURNS;
  const recent = truncated ? stored.slice(-MAX_REPLAYED_TURNS) : stored;

  const preamble =
    conversation.summary !== null && conversation.summary.length > 0
      ? `[Earlier in this conversation]\n${conversation.summary}\n\n`
      : "";

  const note = truncated
    ? "[Earlier turns in this conversation are no longer available. If the user refers to " +
      "something you cannot see, say so rather than guessing.]\n\n"
      : "";

  if (preamble.length > 0 || note.length > 0) {
    messages.push({
      role: "user",
      content: `${preamble}${note}[The conversation continues below.]`,
    });

    messages.push({
      role: "assistant",
      content: "Understood, I have that context.",
    });
  }

  for (const turn of recent) {
    messages.push({ role: turn.role, content: turn.content });
  }

  return messages;
}

const SUMMARY_PROMPT = `You are compressing the earlier part of a conversation so it can be carried forward.

Write a short third-person summary of what the user asked about and what they were told.
Keep anything a later question might refer back to: names, dates, decisions, what was
looked up and what was found. Drop pleasantries and anything already resolved.

Write plain prose, under 200 words. No preamble, no headings, no bullet list.`;

/**
 * Rolls older turns into the summary once the verbatim window overflows.
 *
 * Runs after a turn is stored rather than before the next one, so the cost
 * lands on a request that has already been answered instead of adding latency
 * to the next question.
 */
export async function maybeSummarize(
  db: DB,
  conversation: Conversation,
  principalId: string,
): Promise<boolean> {
  const recent = turnsAfter(db, conversation.id, conversation.summarizedThrough);

  if (recent.length <= VERBATIM_TURNS) {
    return false;
  }

  // Everything except the last few turns gets folded in.
  const fold = recent.slice(0, recent.length - VERBATIM_TURNS + 2);
  const through = fold[fold.length - 1]?.seq;

  if (through === undefined || fold.length === 0) {
    return false;
  }

  const transcript = fold
    .map((turn) => `${turn.role === "user" ? "User" : "Harbor"}: ${turn.content}`)
    .join("\n\n");

  const existing =
    conversation.summary === null || conversation.summary.length === 0
      ? ""
      : `Summary so far:\n${conversation.summary}\n\nNewer exchanges to fold in:\n`;

  try {
    const routed = await route(
      db,
      "chat.summarize",
      {
        system: SUMMARY_PROMPT,
        messages: [{ role: "user", content: `${existing}${transcript}` }],
      },
      { principalId },
    );

    const text = routed.result.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (text.length === 0) {
      return false;
    }

    saveSummary(db, conversation.id, text, through);
    return true;
  } catch {
    // Summarization is housekeeping. Failing it should never fail the
    // conversation; the window just stays wider until it succeeds.
    return false;
  }
}

export function recordExchange(
  db: DB,
  conversationId: string,
  question: string,
  answer: {
    readonly text: string;
    readonly evidence: readonly string[];
    readonly toolsUsed: readonly string[];
    readonly model: string;
    readonly costMicros: number;
  },
): { readonly user: Turn; readonly assistant: Turn } {
  const user = appendTurn(db, conversationId, { role: "user", content: question });

  const assistant = appendTurn(db, conversationId, {
    role: "assistant",
    content: answer.text,
    evidence: answer.evidence,
    toolsUsed: answer.toolsUsed,
    model: answer.model,
    costMicros: answer.costMicros,
  });

  return { user, assistant };
}
