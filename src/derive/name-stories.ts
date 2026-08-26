/**
 * Saying what a story is called, and what it was.
 *
 * `name.ts` writes a sentence about a situation and deliberately refuses to
 * write a *title*, on the grounds that a model asked to name something produces
 * a plausible label that outruns the evidence. That reasoning is sound and it
 * is why titles have been taken from the first member's own text ever since.
 *
 * It also produces "Jeremy & Tatum's Welcome Party" as the name of a wedding
 * weekend, "Concur Travel Itinerary" as the name of a work trip, and "gute?" as
 * the name of a weekend at a lakehouse. Each is a real string somebody typed,
 * each is the wrong answer, and no amount of choosing a *different* existing
 * string fixes it, because on a weekend containing a welcome party, a ceremony
 * and a reception, none of the three strings is the name of the weekend.
 *
 * So the boundary moves, but only by one step, and the original concern is kept
 * intact: a generated title is a *display* string and nothing else. It is
 * written with `title_source = 'model'`, no derivation reads it, no anchor is
 * built from it, no scoring sees it, and the evidence sits underneath it ready
 * to contradict it. If this pass never ran, every story would contain exactly
 * the same things.
 *
 * A user title still wins, and once somebody has renamed a story no later pass
 * touches it.
 *
 * Local only, by task class, for the same reason `name.ts` is: the payload is
 * the most revealing thing Harbor assembles.
 */
import { getStream } from "../store/streams.js";
import { nameHandles, nameTranscript } from "../store/entities.js";
import { NodeResolver } from "../store/nodes.js";
import { storyMembers, topStories } from "../store/stories.js";
import { route } from "../reasoning/router.js";
import type { CompletionRequest } from "../reasoning/provider.js";
import { tidy } from "./name.js";
import type { DB } from "../kernel/db.js";
import type { Story } from "../store/stories.js";

/** How much of each member the model sees. */
const PER_MEMBER = 320;
const MAX_MEMBERS = 10;

/**
 * The instruction.
 *
 * Two outputs rather than one, because a title and a sentence fail in different
 * ways and asking for both in prose gets a title that is a truncated sentence.
 *
 * The prohibitions are inherited wholesale from `name.ts`, which learned them
 * the hard way: naming categories makes a small model pick one, and a model
 * given fragments invents the connective tissue unless told not to. The one
 * addition is the instruction to prefer the words already present, because a
 * title that renames things somebody already has a word for -- "the lakehouse
 * weekend" when they call it "gute" -- is worse than the string it replaced.
 */
const SYSTEM = [
  "You are given several things from one person's own messages, mail, calendar",
  "and reminders. Something already decided they belong together.",
  "",
  "Reply with exactly two lines:",
  "TITLE: a short label, at most 6 words, no trailing punctuation",
  "SUMMARY: one sentence of at most 25 words",
  "",
  "Rules:",
  "- Use only names, places, dates and facts that appear in the text below.",
  "  Never introduce one that does not. If you are not certain where something",
  "  happened, do not say where it happened.",
  "- Prefer words the person already uses. If they call something 'gute',",
  "  the title may say so. Do not rename things they have a name for.",
  "- The title says what the whole thing is, not what the first part of it is.",
  "  If there is a party on Friday and a ceremony on Saturday, it is a wedding",
  "  weekend, not a party.",
  "- Write to the person whose things these are: 'you', not 'the user'.",
  "- Be specific and dull rather than general and interesting.",
  "- If the things do not obviously belong together, say what they are rather",
  "  than inventing a reason.",
  "",
  "No preamble, no quotes, no commentary.",
].join("\n");

export interface NameStoriesOptions {
  readonly principalId: string;
  readonly timezone: string;
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
}

export interface NameStoriesReport {
  readonly considered: number;
  readonly written: number;
  readonly failed: number;
  readonly durationMs: number;
}

function describe(db: DB, story: Story, timezone: string): string | null {
  const resolver = new NodeResolver(db);
  const lines: string[] = [];

  const members = [...storyMembers(db, story.id)].slice(0, MAX_MEMBERS);

  for (const member of members) {
    const node = resolver.node(member.ref);

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

    // Handles become names before the model sees them. A prompt full of phone
    // numbers produces a sentence full of phone numbers.
    const title = nameHandles(db, node.title ?? "");
    const text = nameTranscript(db, node.text).slice(0, PER_MEMBER);

    lines.push(`[${stream?.connectorId ?? "unknown"}, ${when}] ${title}\n${text}`.trim());
  }

  return lines.length === 0 ? null : lines.join("\n\n");
}

/** Splits the two-line reply, tolerantly. */
export function parseNaming(reply: string): { title: string | null; summary: string | null } {
  let title: string | null = null;
  let summary: string | null = null;

  for (const raw of reply.split("\n")) {
    const line = raw.trim();

    const titleMatch = /^title\s*:\s*(.+)$/i.exec(line);

    if (titleMatch !== null) {
      title = tidy(titleMatch[1] ?? "");
      continue;
    }

    const summaryMatch = /^summary\s*:\s*(.+)$/i.exec(line);

    if (summaryMatch !== null) {
      summary = tidy(summaryMatch[1] ?? "");
    }
  }

  // A title is a label, not a sentence. A model that ignores the word limit
  // produces something that is really a summary, and using it as a heading
  // makes the surface unreadable.
  if (title !== null) {
    const trimmed = title.replace(/[.:;,]+$/, "").trim();

    title = trimmed.length === 0 || trimmed.split(/\s+/).length > 8 ? null : trimmed;
  }

  return { title, summary };
}

/**
 * Which stories are worth spending a model call on.
 *
 * Not every story, and not the ones with the most evidence. The ones a person is
 * about to look at: what is coming, and what happened recently. A trip from
 * March is named perfectly well by the flight on it, and nobody is scrolling to
 * it.
 */
function pending(db: DB, principalId: string, limit: number): readonly Story[] {
  const now = Date.now();

  const ahead = topStories(db, principalId, { limit: 40, minSources: 1, tense: "upcoming", now });
  const behind = topStories(db, principalId, { limit: 40, minSources: 1, tense: "past", now });

  const seen = new Set<string>();
  const chosen: Story[] = [];

  for (const story of [...ahead, ...behind]) {
    if (seen.has(story.id) || chosen.length >= limit) {
      continue;
    }

    seen.add(story.id);

    // Somebody's own title is theirs. And a story already named by this pass is
    // left alone unless its contents changed, which `last_changed_at` records.
    if (story.titleSource === "user") {
      continue;
    }

    if (story.summary !== null && story.titleSource === "model") {
      continue;
    }

    chosen.push(story);
  }

  return chosen;
}

export async function nameStories(
  db: DB,
  options: NameStoriesOptions,
): Promise<NameStoriesReport> {
  const started = Date.now();
  const chosen = pending(db, options.principalId, options.limit ?? 20);

  let written = 0;
  let failed = 0;
  let consecutive = 0;

  for (const story of chosen) {
    if (options.shouldStop?.() === true) {
      break;
    }

    // Three failures in a row is a model that is not working, not three
    // difficult stories. Carrying on burns minutes to produce nothing.
    if (consecutive >= 3) {
      options.onNote?.("naming keeps failing, so the rest are left as they are");
      break;
    }

    const payload = describe(db, story, options.timezone);

    if (payload === null) {
      continue;
    }

    const request: CompletionRequest = {
      system: SYSTEM,
      messages: [{ role: "user", content: payload }],
      maxTokens: 160,
    };

    try {
      // The same task class situation naming uses, so it inherits the same
      // routing policy: local models only. The payload is a person's messages,
      // mail and calendar for one episode of their life, in one prompt.
      const routed = await route(db, "situation.summarize", request, {
        principalId: options.principalId,
      });

      const text = routed.result.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      const { title, summary } = parseNaming(text);

      if (summary === null && title === null) {
        failed += 1;
        consecutive += 1;
        continue;
      }

      db.prepare(
        `UPDATE stories
         SET summary = COALESCE(?, summary),
             title = COALESCE(?, title),
             title_source = CASE WHEN ? IS NULL THEN title_source ELSE 'model' END,
             updated_at = ?
         WHERE id = ? AND title_source != 'user'`,
      ).run(summary, title, title, Date.now(), story.id);

      written += 1;
      consecutive = 0;
    } catch {
      failed += 1;
      consecutive += 1;
    }
  }

  return {
    considered: chosen.length,
    written,
    failed,
    durationMs: Date.now() - started,
  };
}
