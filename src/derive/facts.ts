/**
 * Noticing standing facts in conversation.
 *
 * The same shape as commitment extraction, with the safety margin turned up. A
 * commitment is about one thing and expires; a fact about a person persists and
 * colours everything Harbor says afterwards, so a wrong one does more damage
 * for longer and is much harder to notice.
 *
 * Three things keep it honest. The candidate predicate only looks at
 * conversations containing first-person statements of the right shape. Every
 * proposal has to quote the words it came from, checked against the transcript.
 * And nothing extracted here is ever used: proposals sit until a person accepts
 * them, and only accepted facts reach a model.
 *
 * That last constraint costs real value. Harbor will notice true things that
 * never get confirmed because nobody got round to it. That is the right trade:
 * the alternative is a system that has quietly decided things about somebody
 * and acts on them, which is worse when it is wrong and unsettling when it is
 * right.
 */
import { route } from "../reasoning/router.js";
import { recordFact } from "../store/facts.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";
import type { FactKind } from "../store/facts.js";

export const FACT_VERSION = 1;

/**
 * Conversations worth reading for standing facts.
 *
 * First person, present tense, about a durable state rather than an event.
 * Narrow on purpose: the cost of missing a fact is that somebody types it in
 * later, and the cost of a bad candidate set is model spend on every group chat
 * in a decade of history.
 */
const FACT_PATTERNS: readonly RegExp[] = [
  /\bi (?:always|never|usually|generally|prefer|hate|love|can'?t stand)\b/i,
  /\bi (?:don'?t|do not|can'?t|cannot) (?:eat|drink|do|go|use|take)\b/i,
  /\bi'?m (?:allergic|vegetarian|vegan|gluten)\b/i,
  /\bi (?:work|live|fly|drive|commute) (?:at|in|from|out of|to)\b/i,
  /\bmy (?:landlord|dentist|doctor|boss|manager|barber|mechanic|gym|office)\b/i,
  /\bevery (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)\b/i,
];

export function looksLikeFact(text: string): boolean {
  return FACT_PATTERNS.some((pattern) => pattern.test(text));
}

const SYSTEM = `You find standing facts about a person in a conversation transcript.

A standing fact is something durable and general: a preference, a restriction, a
recurring routine, or who somebody is to them. Not events, not plans, not one-off
opinions, not anything about other participants.

Rules:
- Only about the person labelled Me. Never about anyone else in the conversation.
- Durable only. "I'm hungry" is not a fact. "I don't eat pork" is.
- quote must be a verbatim substring of the transcript. If you cannot quote it, do
  not propose it.
- statement is short, third person, and plain: "Does not eat pork", "Flies out of
  PHL", "Dana is a client, not a colleague".
- kind is one of: preference, constraint, relationship, routine, detail.
- Never propose anything about health conditions, finances, religion, politics, or
  anyone's private circumstances. Skip those entirely even when stated plainly.
- Most conversations contain no standing facts. An empty list is the usual answer.

Respond with JSON only, no prose and no code fences:
{"facts":[{"statement":"...","kind":"preference","quote":"...","confidence":0.0}]}`;

/**
 * Categories Harbor will not keep about a person, whatever they say in a chat.
 *
 * A model told not to propose these will mostly comply, and mostly is not a
 * standard worth having for this category of information. Checked again here,
 * after the model, because the cost of being wrong is not symmetric with the
 * benefit of being right.
 */
const NEVER_STORE =
  /\b(diagnos|depress|anxiety|therapy|therapist|medication|prescription|salary|debt|mortgage|bankrupt|church|mosque|synagogue|temple|republican|democrat|voted|pregnan|divorce|affair)\w*/i;

function toKind(value: unknown): FactKind {
  const known: readonly FactKind[] = ["preference", "constraint", "relationship", "routine", "detail"];

  return known.includes(value as FactKind) ? (value as FactKind) : "detail";
}

function loose(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export interface FactReport {
  readonly considered: number;
  readonly read: number;
  readonly proposed: number;
  readonly rejected: readonly string[];
  readonly costMicros: number;
  readonly model: string | null;
  readonly remaining: number;
}

export interface FactCandidate {
  readonly id: string;
  readonly participants: readonly string[];
  readonly endsAt: number;
  readonly preview: string;
}

export function factCandidates(db: DB, limit: number): readonly FactCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, transcript, participants, ends_at FROM episodes
       WHERE fact_version IS NULL OR fact_version <> @version
       ORDER BY ends_at DESC
       LIMIT @pool`,
    )
    .all({ version: FACT_VERSION, pool: limit * 10 }) as {
    id: string;
    transcript: string;
    participants: string;
    ends_at: number;
  }[];

  const found: FactCandidate[] = [];

  for (const row of rows) {
    if (!looksLikeFact(row.transcript)) {
      continue;
    }

    found.push({
      id: row.id,
      participants: JSON.parse(row.participants) as string[],
      endsAt: row.ends_at,
      preview: row.transcript.split("\n")[0]?.slice(0, 90) ?? "",
    });

    if (found.length >= limit) {
      break;
    }
  }

  return found;
}

function markUninteresting(db: DB, pool: number): number {
  const rows = db
    .prepare(
      `SELECT id, transcript FROM episodes
       WHERE fact_version IS NULL OR fact_version <> @version
       ORDER BY ends_at DESC LIMIT @pool`,
    )
    .all({ version: FACT_VERSION, pool }) as { id: string; transcript: string }[];

  const mark = db.prepare(`UPDATE episodes SET fact_version = ? WHERE id = ?`);
  let marked = 0;

  const work = db.transaction(() => {
    for (const row of rows) {
      if (!looksLikeFact(row.transcript)) {
        mark.run(FACT_VERSION, row.id);
        marked += 1;
      }
    }
  });

  work();

  return marked;
}

export interface ProposeOptions {
  readonly principalId?: string;
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
}

export async function proposeFacts(db: DB, options: ProposeOptions = {}): Promise<FactReport> {
  const principalId = options.principalId ?? DEFAULT_PRINCIPAL;
  const budget = options.limit ?? 20;

  const skipped = markUninteresting(db, 2_000);

  if (skipped > 0) {
    options.onNote?.(`${String(skipped)} conversations had nothing fact-shaped in them`);
  }

  const candidates = factCandidates(db, budget);

  let read = 0;
  let proposed = 0;
  let cost = 0;
  let model: string | null = null;
  const rejected: string[] = [];

  for (const candidate of candidates) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const row = db.prepare(`SELECT transcript FROM episodes WHERE id = ?`).get(candidate.id) as
      | { transcript: string }
      | undefined;

    if (row === undefined) {
      continue;
    }

    let routed;

    try {
      routed = await route(
        db,
        "extract.structured",
        { system: SYSTEM, messages: [{ role: "user", content: row.transcript }] },
        { principalId, pipelineVersion: FACT_VERSION },
      );
    } catch (error) {
      options.onNote?.(`could not read ${candidate.id}: ${String(error)}`);
      continue;
    }

    read += 1;
    cost += routed.costMicros;
    model = routed.result.model;

    const text = routed.result.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();

    let parsed: { facts?: unknown };

    try {
      parsed = JSON.parse(text) as { facts?: unknown };
    } catch {
      rejected.push(`${candidate.id}: response was not JSON`);
      continue;
    }

    const haystack = loose(row.transcript);
    const list = Array.isArray(parsed.facts) ? parsed.facts : [];

    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const statement = typeof record["statement"] === "string" ? record["statement"].trim() : "";
      const quote = typeof record["quote"] === "string" ? record["quote"].trim() : "";

      if (statement.length < 4 || quote.length < 4) {
        continue;
      }

      if (!haystack.includes(loose(quote))) {
        rejected.push(`${statement}: quote not in the transcript`);
        continue;
      }

      if (NEVER_STORE.test(statement) || NEVER_STORE.test(quote)) {
        // Not recorded, not counted, not surfaced. There is no version of this
        // that is worth keeping in a file on somebody's laptop.
        rejected.push(`(withheld: sensitive category)`);
        continue;
      }

      const outcome = recordFact(db, {
        principalId,
        kind: toKind(record["kind"]),
        statement,
        // Proposed, never confirmed. Harbor noticing is not Harbor deciding.
        state: "proposed",
        confidence:
          typeof record["confidence"] === "number"
            ? Math.min(0.8, Math.max(0, record["confidence"]))
            : 0.5,
        origin: "conversation",
        sourceEpisode: candidate.id,
        quote,
      });

      if (outcome.created) {
        proposed += 1;
      }
    }

    db.prepare(`UPDATE episodes SET fact_version = ? WHERE id = ?`).run(FACT_VERSION, candidate.id);
  }

  const remaining = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM episodes WHERE fact_version IS NULL OR fact_version <> ?`)
      .get(FACT_VERSION) as { n: number }
  ).n;

  return { considered: candidates.length, read, proposed, rejected, costMicros: cost, model, remaining };
}
