/**
 * Segmenting conversations into episodes.
 *
 * The problem this solves: an email is a complete thought and a text message is
 * not. "yeah saturday works" is one item, one chunk, one vector, and it carries
 * no meaning alone. Harbor was embedding tens of thousands of those and then
 * failing to find the conversation where a plan was actually made, because no
 * single message in it ranked against a coherent email.
 *
 * An episode is the unit a person would name: "when we talked about the trip".
 * Segmentation is deterministic and boring on purpose, because the alternative
 * is a model deciding where conversations begin and end, at a cost proportional
 * to the whole message history and with no way to check the result.
 *
 * The rule is a gap in time, with two guards. A long silence ends an episode. A
 * conversation that never pauses is cut at a maximum size, because an episode
 * that spans three weeks is not a unit of meaning either. And a single message
 * with nothing around it is still an episode: a text saying "landed" matters,
 * and dropping it would silently lose exactly the kind of small fact this layer
 * exists to keep.
 */
import {
  markSegmented,
  pruneEpisodes,
  saveEpisode,
} from "../store/episodes.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";

/** Bump to re-segment. Episodes whose membership is unchanged keep their vectors. */
export const SEGMENT_VERSION = 1;

/**
 * Silence that ends an episode.
 *
 * Four hours: long enough that a slow back-and-forth over an evening stays one
 * conversation, short enough that this morning's messages are not welded to
 * last night's. The same constant the conversation layer uses for how long an
 * `ask` thread stays live, which is not a coincidence: both are answering "is
 * this still the same exchange".
 */
const GAP_MS = 4 * 3_600_000;

/** No episode spans longer than this, however continuous the chatter. */
const MAX_SPAN_MS = 36 * 3_600_000;

/** Nor holds more than this many messages. */
const MAX_MESSAGES = 80;

/**
 * How much of an episode is kept as embeddable text.
 *
 * Cut from 6,000 after a real corpus killed a ten thousand item derive pass.
 * The old number was sized against English prose at roughly four characters per
 * token, which is fine until a group chat named "FamilyTTGT👨‍👩‍👧‍👦" arrives:
 * an emoji can cost eight tokens on its own, and a transcript full of them
 * blows a 2,048 token embedding context at well under 6,000 characters.
 *
 * The transcript is still kept whole here. What changed is that the derive pass
 * splits it across several chunks rather than insisting on one, so the ceiling
 * on any single embedding input is this divided by the chunk count.
 */
const MAX_TRANSCRIPT_CHARS = 6_000;

/**
 * The largest text handed to an embedding model in one call.
 *
 * Conservative on purpose: it has to hold for the worst tokenizer ratio in the
 * corpus, not the average one. Two thousand characters of solid emoji still
 * fits a 2,048 token context.
 */
export const MAX_EMBED_CHARS = 2_000;

/**
 * Which streams are conversational.
 *
 * A property of the connector rather than of the item kind: an email is a
 * message and is not conversational in this sense, because it already carries
 * its own subject and context. Determined from the stream's connector id, so a
 * future chat source joins by being named here and nothing else changes.
 */
export const CONVERSATIONAL_CONNECTORS: readonly string[] = ["imessage"];

interface MessageRow {
  readonly id: string;
  readonly stream_id: string;
  readonly thread_id: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly snippet: string | null;
  readonly author: string | null;
  readonly direction: string | null;
  readonly occurred_at: number;
}

export interface SegmentReport {
  readonly threadsExamined: number;
  readonly episodesWritten: number;
  readonly episodesReplaced: number;
  readonly messagesCovered: number;
  readonly remaining: number;
}

function conversationalStreamIds(db: DB): readonly string[] {
  if (CONVERSATIONAL_CONNECTORS.length === 0) {
    return [];
  }

  const placeholders = CONVERSATIONAL_CONNECTORS.map(() => "?").join(", ");

  const rows = db
    .prepare(`SELECT id FROM streams WHERE connector_id IN (${placeholders})`)
    .all(...CONVERSATIONAL_CONNECTORS) as { id: string }[];

  return rows.map((row) => row.id);
}

/**
 * A name for the episode, taken rather than generated.
 *
 * No model is involved. A generated title would be the first place a plausible
 * sounding claim could outrun the evidence, and the value here is that an
 * episode is exactly the messages it contains. Who was talking and when is
 * enough to recognize one in a list; the transcript is what search matches
 * against.
 */
/**
 * Who was in it. Not how many messages.
 *
 * The count used to be baked into the title, which read as "+1610... (8
 * messages) (8 messages)" wherever a surface added its own, and worse, it
 * defeated the test that decides whether a title is a bare handle: a phone
 * number is recognisable and a phone number with a parenthetical on the end is
 * not, so raw handles won the naming contest against real subject lines.
 *
 * Size is a property of the episode and every surface already has it.
 */
function titleFor(participants: readonly string[], count: number): string {
  void count;

  return participants.length === 0 ? "Conversation" : participants.join(", ");
}

function speakerOf(row: MessageRow): string {
  if (row.direction === "outbound") {
    return "Me";
  }

  const author = row.author ?? "";
  const match = /^([^<]+?)\s*</.exec(author);
  const name = (match?.[1] ?? author).trim();

  return name.length === 0 ? "Them" : name;
}

function transcriptFor(rows: readonly MessageRow[]): string {
  const lines: string[] = [];
  let used = 0;

  for (const row of rows) {
    const text = (row.body ?? row.snippet ?? "").replace(/\s+/g, " ").trim();

    if (text.length === 0) {
      continue;
    }

    const line = `${speakerOf(row)}: ${text.slice(0, 600)}`;

    // Truncate from the end rather than the start. The opening of a
    // conversation is where the subject is established; the tail is usually
    // logistics, and losing it costs less.
    if (used + line.length > MAX_TRANSCRIPT_CHARS) {
      lines.push("...");
      break;
    }

    lines.push(line);
    used += line.length + 1;
  }

  return lines.join("\n");
}

/**
 * Segments one conversation.
 *
 * Whole threads at a time, not batches of pending messages. A message arriving
 * now belongs to an episode that may already exist and may need to grow, and
 * segmenting a slice of a conversation would produce episodes whose boundaries
 * depend on when Harbor happened to look.
 */
function segmentThread(
  db: DB,
  streamId: string,
  threadId: string,
  principalId: string,
): { episodes: number; messages: number; itemIds: string[]; pruned: number } {
  const rows = db
    .prepare(
      `SELECT id, stream_id, thread_id, title, SUBSTR(body, 1, 1000) AS body, snippet,
              author, direction, occurred_at
       FROM items
       WHERE stream_id = @stream AND thread_id = @thread AND deleted_at IS NULL
       ORDER BY occurred_at ASC`,
    )
    .all({ stream: streamId, thread: threadId }) as MessageRow[];

  if (rows.length === 0) {
    return { episodes: 0, messages: 0, itemIds: [], pruned: 0 };
  }

  const groups: MessageRow[][] = [];
  let current: MessageRow[] = [];

  for (const row of rows) {
    const previous = current[current.length - 1];

    const breaks =
      previous !== undefined &&
      (row.occurred_at - previous.occurred_at > GAP_MS ||
        current.length >= MAX_MESSAGES ||
        row.occurred_at - (current[0]?.occurred_at ?? row.occurred_at) > MAX_SPAN_MS);

    if (breaks) {
      groups.push(current);
      current = [];
    }

    current.push(row);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  const itemIds: string[] = [];
  const produced: string[] = [];
  let written = 0;

  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];

    if (first === undefined || last === undefined) {
      continue;
    }

    const transcript = transcriptFor(group);

    if (transcript.trim().length === 0) {
      // Nothing but attachments or reactions. Still marked, so the pass does
      // not reconsider it every run.
      for (const row of group) {
        itemIds.push(row.id);
      }
      continue;
    }

    const participants = [...new Set(group.map(speakerOf))].filter((name) => name !== "Me");

    const id = saveEpisode(
      db,
      {
        streamId,
        threadId,
        principalId,
        title: titleFor(participants, group.length),
        transcript,
        participants,
        itemIds: group.map((row) => row.id),
        startsAt: first.occurred_at,
        endsAt: last.occurred_at,
      },
      SEGMENT_VERSION,
    );

    produced.push(id);
    written += 1;

    for (const row of group) {
      itemIds.push(row.id);
    }
  }

  // A conversation that grew by one message produced a new episode id. The old
  // one has to go, or the same message belongs to two episodes.
  const pruned = pruneEpisodes(db, streamId, threadId, produced);

  return { episodes: written, messages: rows.length, itemIds, pruned };
}

export interface SegmentOptions {
  readonly principalId?: string;
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
}

export function segmentEpisodes(db: DB, options: SegmentOptions = {}): SegmentReport {
  const principalId = options.principalId ?? DEFAULT_PRINCIPAL;
  const streams = conversationalStreamIds(db);

  if (streams.length === 0) {
    return {
      threadsExamined: 0,
      episodesWritten: 0,
      episodesReplaced: 0,
      messagesCovered: 0,
      remaining: 0,
    };
  }

  const placeholders = streams.map(() => "?").join(", ");

  // Threads containing anything unsegmented, rather than unsegmented messages.
  // The unit of work is a conversation, because that is the unit whose
  // boundaries have to be recomputed when one message arrives.
  const threads = db
    .prepare(
      `SELECT DISTINCT stream_id, thread_id FROM items
       WHERE stream_id IN (${placeholders})
         AND thread_id IS NOT NULL
         AND deleted_at IS NULL
         AND (episode_version IS NULL OR episode_version <> ${String(SEGMENT_VERSION)})
       ORDER BY thread_id`,
    )
    .all(...streams) as { stream_id: string; thread_id: string }[];

  const budget = options.limit ?? threads.length;
  const total = Math.min(threads.length, budget);

  let examined = 0;
  let episodes = 0;
  let replaced = 0;
  let messages = 0;

  for (const thread of threads.slice(0, total)) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const result = segmentThread(db, thread.stream_id, thread.thread_id, principalId);

    episodes += result.episodes;
    replaced += result.pruned;
    messages += result.messages;

    markSegmented(db, result.itemIds, SEGMENT_VERSION);

    examined += 1;
    options.onProgress?.(examined, total);
  }

  const remaining = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT thread_id) AS n FROM items
         WHERE stream_id IN (${placeholders})
           AND thread_id IS NOT NULL
           AND deleted_at IS NULL
           AND (episode_version IS NULL OR episode_version <> ${String(SEGMENT_VERSION)})`,
      )
      .get(...streams) as { n: number }
  ).n;

  return {
    threadsExamined: examined,
    episodesWritten: episodes,
    episodesReplaced: replaced,
    messagesCovered: messages,
    remaining,
  };
}

/** Whether an item lives in a conversational stream, for the derivation pass. */
export function conversationalStreamSet(db: DB): ReadonlySet<string> {
  return new Set(conversationalStreamIds(db));
}
