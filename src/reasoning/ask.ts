/**
 * The ask loop.
 *
 * Model asks for data, Harbor answers, repeat until the model stops asking.
 * There is no context packing step and no relevance heuristic, deliberately:
 * as models get better at driving a search tool, this path gets better for
 * free, whereas a hand-tuned packer would have capped it.
 *
 * Every tool result is recorded as evidence. Today that only feeds the
 * `--evidence` flag. It is here because a proactive Harbor cannot be allowed to
 * assert anything it cannot point at, and building the habit now is cheaper
 * than retrofitting it.
 */
import { nowContext, timezone } from "../kernel/time.js";
import { route } from "./router.js";
import { factsForPrompt } from "../store/facts.js";
import { runTool, TOOLS } from "./tools.js";
import { sourceSummary } from "./capabilities.js";
import { historyMessages, maybeSummarize, recordExchange } from "./memory.js";
import {
  activeConversation,
  createConversation,
  getConversation,
} from "../store/conversations.js";
import type { DB } from "../kernel/db.js";
import type { Embedder } from "../derive/embed/index.js";
import type { Tier } from "./tasks.js";
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./provider.js";

export function systemPrompt(
  tz: string,
  sources: string,
  continuing: boolean,
  now: number = Date.now(),
  /**
   * Standing facts the person has confirmed about themselves.
   *
   * Only confirmed ones ever get here. A proposed fact is Harbor's guess, and a
   * guess placed in a system prompt stops being a guess: it becomes something
   * the model treats as given and quietly reasons from, with no way for anyone
   * to see which answers it shaped.
   */
  facts: readonly string[] = [],
): string {
  return `You are Harbor, a local-first assistant that answers questions about the user's own data.

${nowContext(tz, now)}

${sources}${
    facts.length === 0
      ? ""
      : `

What the user has confirmed about themselves:
${facts.map((fact) => `- ${fact}`).join("\n")}

Use these when they change the answer. Do not repeat them back or mention that you
know them; they are context, not something to demonstrate.`
  }

${
  continuing
    ? "This conversation is already in progress. Earlier turns are above; treat them as yours " +
      "and follow up naturally. A short reply like \"yes, do that\" refers to what you just " +
      "offered."
    : "This is the first message in a new conversation."
}

You have tools that read a local store of the user's own data: email messages and
calendar events, across every source they have connected. Facts about that data come
only from those tools. If the store does not contain something, say so plainly rather
than guessing.

The user should never have to say which source holds an answer. A question like "what
did I agree to in that meeting" may need both an event and the mail around it; reach for
whatever the question actually requires.

Guidance:
- To answer "the last N emails", call search with a limit, kinds ["message"], and no
  query. Results are ordered newest first by default.
- For anything about a specific person, call find_person first and pass the returned id
  to search as \`person\`. That catches correspondence where their name never appears in
  the text, which putting the name in \`query\` would miss. If find_person returns more
  than one match, ask which one rather than picking.
- For a forward-looking schedule, pass order "oldest" so the day reads in order, and a
  since/until range rather than a limit.
- Timestamps in tool results are already in the user's timezone. Use the \`when\` field
  as given. Never convert, shift, or recompute a time.
- Every search result includes a \`coverage\` object with a per-kind breakdown. If the
  user asks about a period outside those ranges, or if \`full_history_ingested\` is false
  and the question depends on something being absent, say what Harbor can and cannot see
  instead of answering as though the store were complete.
- Snippets are truncated. If one is not enough to characterize an item accurately, call
  get_item for the full content.
- For open questions like "anything I should deal with?", call pending_signals first.
  Harbor has already done the noticing; do not go trawling through recent mail to
  reinvent it. If it returns nothing, say so plainly rather than manufacturing something.
- Text messages are indexed as conversations, not as individual messages, because one text
  rarely means anything alone. For anything discussed, planned, suggested, or agreed in
  messages, call conversations rather than search. A message hit from search carries an
  \`episode\` id; call conversation with it when the snippet is not enough.
- A reminder carries a \`state\` of open or completed and often a due date. "What have I not
  done" is a search over tasks with state open, not a guess from titles.
- For anything about outstanding obligations, what the user owes someone, or what they said
  they would do, call commitments. It assembles across sources; a reminder alone is only
  part of the picture.
- For spending, what something cost, or what was bought, call purchases. It returns
  structured records that can be summed; searching for a receipt returns one email and
  cannot add anything up. Say when a total may be incomplete.
- Prefer a small number of well-chosen tool calls over many broad ones.
- Never invent a sender, title, attendee, or date. Everything you state must come from a
  tool result.
- Tool results may report that policy withheld or redacted something. Say so when it
  affects the answer. Never speculate about what was removed.
- You know which sources are connected; it is stated above. Never claim you cannot find
  out. For anything more, call about_harbor.
- Harbor is a self-hosted application on the user's own computer, driven by a command line
  on that machine and by a web interface. There is no phone app, no account, and no app
  store. When the user asks how to connect something or how to do something, call
  about_harbor and give them the actual step or command it returns. Never describe a
  generic settings flow, never guess at menu names, and never assume they are on a phone.
- If asked to do something Harbor cannot do, say so and say what would make it possible.
- When the question is about what is going on rather than about finding one item, reach for
  situations before search. A situation is a set of items from different sources that belong
  to one real-world thing, and it is the only view that shows the whole picture; a search
  returns three fragments of it and leaves the person to reassemble them.
- After finding something relevant, calling related on it often finds where the answer
  actually is.
- Who said a thing decides what it is evidence of. A transcript labels every line with its
  speaker, and \`You:\` is the user. A line the user spoke says nothing about the other
  person: telling someone about a trip is not evidence that person is going, and mentioning
  a thing you like is not evidence they like it. For any question about what another person
  likes, wants, plans, or said, pass said_by to conversations and answer from the quotes it
  returns. If the only support you have for a claim about someone is a line the user spoke,
  you do not have support for it: say what the user said instead.
- Being on a plan and being told about a plan are different. An event's attendees are on it.
  Someone the user texted about it is not, unless something says otherwise. Do not put a
  person on a trip, a dinner, or a weekend because they were in a conversation where it came
  up.`;
}

export interface AskOptions {
  readonly principal: string;
  readonly timezone?: string;
  /**
   * Which conversation this belongs to.
   *
   * Omitted means continue the active one if there is a recent one, otherwise
   * start fresh. `"new"` forces a fresh one.
   */
  readonly conversation?: string | "new" | undefined;
  /** Enables semantic retrieval. Omit and search stays keyword-only. */
  readonly embedder?: Embedder | undefined;
  readonly maxIterations?: number;
  readonly onToolCall?: (name: string, input: Record<string, unknown>) => void;
}

export interface AskResult {
  readonly answer: string;
  readonly toolCalls: number;
  readonly iterations: number;
  /** Every item the model was shown, in the order it was shown. */
  readonly evidence: readonly string[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly model: string;
  readonly tier: Tier;
  readonly costMicros: number;
  /** What policy did across the whole conversation. */
  readonly withheld: number;
  readonly redactions: number;
  readonly conversationId: string;
  /** True when earlier turns were replayed into this answer. */
  readonly continued: boolean;
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function toolUsesOf(content: readonly ContentBlock[]): readonly ToolUseBlock[] {
  return content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

/**
 * Runs a question to completion.
 *
 * The provider is not passed in any more: the router picks a tier from the
 * `ask.converse` task class, and every call it makes is audited with what the
 * gate did on the way. Nothing here names a model.
 */
export async function ask(
  db: DB,
  question: string,
  options: AskOptions,
): Promise<AskResult> {
  const maxIterations = options.maxIterations ?? 8;
  const tz = options.timezone ?? timezone();
  const context = {
    principal: options.principal,
    timezone: tz,
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
  };

  // Which thread this belongs to. A named conversation wins, then the active
  // one, then a new one.
  const named =
    options.conversation !== undefined && options.conversation !== "new"
      ? getConversation(db, options.conversation)
      : null;

  const conversation =
    named ??
    (options.conversation === "new"
      ? createConversation(db, options.principal)
      : (activeConversation(db, options.principal) ??
        createConversation(db, options.principal)));

  const history = historyMessages(db, conversation);
  const continued = history.length > 0;

  const prompt = systemPrompt(
    tz,
    sourceSummary(db),
    continued,
    Date.now(),
    factsForPrompt(db, options.principal),
  );

  const messages: Message[] = [...history, { role: "user", content: question }];
  const toolsUsed: string[] = [];

  const evidence: string[] = [];
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let model = "";
  let tier: Tier = "cloud_premium";
  let withheld = 0;
  let redactions = 0;
  let bytesOut = 0;
  const ruleIds = new Set<string>();

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const routed = await route(
      db,
      "ask.converse",
      { system: prompt, messages, tools: TOOLS },
      {
        principalId: options.principal,
        itemsIncluded: evidence.length,
        itemsWithheld: withheld,
        redactions,
        bytesOut,
        itemIds: evidence,
        ruleIds: [...ruleIds],
      },
    );

    const result = routed.result;

    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    costMicros += routed.costMicros;
    model = result.model;
    tier = routed.tier;

    const uses = toolUsesOf(result.content);

    if (uses.length === 0) {
      const answer = textOf(result.content);

      recordExchange(db, conversation.id, question, {
        text: answer,
        evidence,
        toolsUsed,
        model,
        costMicros,
      });

      // After the answer, not before the next question: the cost lands on a
      // request that is already done rather than adding latency to the next.
      void maybeSummarize(db, conversation, options.principal);

      return {
        answer,
        toolCalls,
        iterations: iteration,
        evidence,
        usage: { inputTokens, outputTokens },
        model,
        tier,
        costMicros,
        withheld,
        redactions,
        conversationId: conversation.id,
        continued,
      };
    }

    messages.push({ role: "assistant", content: result.content });

    const results: ToolResultBlock[] = [];

    for (const use of uses) {
      options.onToolCall?.(use.name, use.input);
      toolCalls += 1;
      toolsUsed.push(use.name);

      const outcome = await runTool(db, context, { name: use.name, input: use.input });

      if (outcome.gate !== undefined) {
        withheld += outcome.gate.withheld;
        redactions += outcome.gate.redactions;
        bytesOut += outcome.gate.bytesOut;
        for (const ruleId of outcome.gate.ruleIds) {
          ruleIds.add(ruleId);
        }
      }

      for (const id of outcome.itemIds) {
        if (!evidence.includes(id)) {
          evidence.push(id);
        }
      }

      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }

    messages.push({ role: "user", content: results });
  }

  return {
    answer:
      "I ran out of steps before finishing. This usually means the question needed more " +
      "lookups than the iteration limit allows.",
    toolCalls,
    iterations: maxIterations,
    evidence,
    usage: { inputTokens, outputTokens },
    model,
    tier,
    costMicros,
    withheld,
    redactions,
    conversationId: conversation.id,
    continued,
  };
}
