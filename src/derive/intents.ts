/**
 * Finding stated intentions in conversation.
 *
 * The only part of the commitment layer where a model is involved, and it is
 * fenced in tightly. A deterministic predicate decides which conversations are
 * even worth reading, so the model never sees the other ninety-odd percent of a
 * message history; the output has to parse against a schema; and every
 * extracted commitment has to quote the words it came from, checked against the
 * transcript, so a fabricated obligation cannot survive.
 *
 * That last check is the important one. A model asked to find commitments in
 * ordinary chatter will find them, because that is what it was asked to do. The
 * quote requirement turns a plausible-sounding claim into a verifiable one, and
 * anything that fails it is dropped rather than saved with low confidence.
 */
import { route } from "../reasoning/router.js";
import type { DB } from "../kernel/db.js";

/**
 * Phrases that suggest somebody committed to something.
 *
 * Deliberately narrow, and matched against the transcript before any model is
 * called. Widening this is cheap and safe; the extractor's own judgement is
 * what stops a false candidate becoming a false commitment.
 */
const INTENT_PATTERNS: readonly RegExp[] = [
  /\bi(?:'| a)?ll\b/i,
  /\bi will\b/i,
  /\bi need to\b/i,
  /\bi have to\b/i,
  /\bi should\b/i,
  /\bi'm going to\b/i,
  /\bim gonna\b/i,
  /\bi'?m gonna\b/i,
  /\blet'?s\b/i,
  /\bwe should\b/i,
  /\bwe need to\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bremind me\b/i,
  /\bdon'?t forget\b/i,
  /\bi'?ll send\b/i,
  /\bi'?ll get\b/i,
  /\bi'?ll book\b/i,
  /\bi'?ll call\b/i,
  /\bpromise\b/i,
];

export function looksLikeIntent(text: string): boolean {
  return INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export interface ExtractedIntent {
  /** What was committed to, as a short imperative. */
  readonly title: string;
  readonly owner: "me" | "them" | "shared";
  /** Words from the transcript that support this, verified before use. */
  readonly quote: string;
  /** An ISO date if one was actually stated, never inferred from context. */
  readonly due: string | null;
  readonly confidence: number;
}

const SYSTEM = `You extract commitments from a conversation transcript.

A commitment is something a participant said would happen and that is not obviously
finished within the conversation itself: an errand, a promise, a thing to buy, send,
book, or arrange.

Rules:
- Only extract what is actually stated. Never infer an obligation from tone or topic.
- "Me" is the person whose Harbor this is; their lines are labelled Me.
- quote must be a verbatim substring of the transcript. If you cannot quote it, do not
  extract it.
- title is a short imperative: "Buy a ski rack", "Send Dana the draft".
- due is an ISO 8601 date ONLY if a specific date or day was stated. Otherwise null.
  Never guess a date from context.
- Small talk, opinions, hypotheticals, and things already done are not commitments.
- Most conversations contain zero commitments. Returning an empty list is the correct
  answer far more often than not.

Respond with JSON only, no prose and no code fences:
{"commitments":[{"title":"...","owner":"me|them|shared","quote":"...","due":null,"confidence":0.0}]}`;

/** Loose normalization so a quote check survives whitespace and case differences. */
function loose(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export interface ExtractionResult {
  readonly intents: readonly ExtractedIntent[];
  readonly model: string;
  readonly tier: string;
  readonly costMicros: number;
  readonly rejected: readonly string[];
}

export async function extractIntents(
  db: DB,
  transcript: string,
  principalId: string,
  pipelineVersion: number,
): Promise<ExtractionResult> {
  const routed = await route(
    db,
    "extract.structured",
    {
      system: SYSTEM,
      messages: [{ role: "user", content: transcript }],
    },
    { principalId, pipelineVersion },
  );

  const text = routed.result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let parsed: { commitments?: unknown };

  try {
    parsed = JSON.parse(cleaned) as { commitments?: unknown };
  } catch {
    // Schema verification, and it is the whole reason `extract.structured`
    // declares it: a tier that cannot produce JSON reliably fails visibly here
    // rather than quietly writing nonsense into the commitment table.
    return {
      intents: [],
      model: routed.result.model,
      tier: routed.tier,
      costMicros: routed.costMicros,
      rejected: ["response was not JSON"],
    };
  }

  const raw = Array.isArray(parsed.commitments) ? parsed.commitments : [];
  const haystack = loose(transcript);
  const intents: ExtractedIntent[] = [];
  const rejected: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const title = typeof record["title"] === "string" ? record["title"].trim() : "";
    const quote = typeof record["quote"] === "string" ? record["quote"].trim() : "";
    const owner = record["owner"];

    if (title.length < 3 || quote.length < 4) {
      rejected.push(`${title || "(untitled)"}: no usable title or quote`);
      continue;
    }

    // The check that makes this trustworthy. A commitment Harbor cannot point
    // at in the transcript does not get written.
    if (!haystack.includes(loose(quote))) {
      rejected.push(`${title}: quote not found in the transcript`);
      continue;
    }

    if (owner !== "me" && owner !== "them" && owner !== "shared") {
      rejected.push(`${title}: unknown owner`);
      continue;
    }

    const dueRaw = record["due"];
    let due: string | null = null;

    if (typeof dueRaw === "string" && dueRaw.length > 0) {
      const parsedDue = Date.parse(dueRaw);
      due = Number.isNaN(parsedDue) ? null : dueRaw;
    }

    const confidence =
      typeof record["confidence"] === "number"
        ? Math.min(1, Math.max(0, record["confidence"]))
        : 0.5;

    intents.push({ title, owner, quote, due, confidence });
  }

  return {
    intents,
    model: routed.result.model,
    tier: routed.tier,
    costMicros: routed.costMicros,
    rejected,
  };
}
