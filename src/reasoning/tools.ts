/**
 * The tool surface.
 *
 * This is Harbor's actual interface to a model, and the reason the design does
 * not depend on a context packer: the model asks for what it wants, in as many
 * turns as it needs, and every answer it gets is scoped to the principal and
 * carries the reasons it was returned.
 *
 * Three rules this file enforces on the model's behalf:
 *
 *   Timestamps are pre-formatted in the user's zone, with the offset attached.
 *   No model does timezone arithmetic here. One that was asked to reported the
 *   same message as 7:18 PM and as 2:18 AM in consecutive runs.
 *
 *   Every result carries coverage. The most dangerous answer Harbor can give
 *   is a confident one drawn from an incomplete window, and the model has no
 *   other way to know the window exists.
 *
 *   Search spans kinds by default. A single `search` rather than one tool per
 *   source is the whole point of the product: "prepare me for tomorrow" should
 *   reach mail and calendar in one call, without the model having to know which
 *   source holds which fact. The cost is that `direction` only applies to
 *   messages, which the schema documents.
 *
 *   Everything leaves through the gate. Search results, item bodies, and signal
 *   details all pass through policy on their way out, so an item classified
 *   restricted cannot reach a model no matter which tool asked for it. The gate
 *   is constructed per invocation and its summary is returned to the caller for
 *   the audit log.
 *
 *   Retrieval mode is not exposed. Keyword and semantic are fused underneath,
 *   and the `reasons` on each hit say which retriever found it. A model asked
 *   to pick a retrieval strategy will pick badly and inconsistently, and the
 *   choice is not one the user should have to think about either.
 *
 * Keep this surface small. Every tool added here is a thing every future model
 * has to understand, and a thing that can go wrong silently.
 */
import { humanWhen, localIso } from "../kernel/time.js";
import { lookupEntities, resolveEntity } from "../store/entities.js";
import { composeBrief } from "../derive/brief.js";
import {
  connectionsFor,
  getThread,
  threadNodes,
  topThreads,
} from "../store/relationships.js";
import { nodeKey, parseNodeRef, summarize } from "../store/nodes.js";
import type { NodeRef, NodeSummary } from "../store/nodes.js";
import { episodeForItem, episodeItems, getEpisode, recentCorrespondents } from "../store/episodes.js";
import { nameForHandle, nameHandles, nameTranscript } from "../store/entities.js";
import { searchEpisodes } from "../retrieval/episodes.js";
import { evidenceFor, listCommitments } from "../store/commitments.js";
import { dedupePurchases, linesFor, listProjections, spendByMerchant } from "../store/projections.js";
import { capabilities, connectedSources } from "./capabilities.js";
import { Gate, withholdingNotice } from "../policy/gate.js";
import type { Embedder } from "../derive/embed/index.js";
import { coverageByKind, coverageFor } from "../store/coverage.js";
import { search } from "../retrieval/search.js";
import { getItem } from "../store/items.js";
import type { DB } from "../kernel/db.js";
import type { Direction } from "../store/items.js";
import type { ToolSchema } from "./provider.js";

export const TOOLS: readonly ToolSchema[] = [
  {
    name: "search",
    description:
      "Search everything Harbor has ingested: email messages and calendar events. Omit " +
      "`query` to browse by time, which is the right call for 'the last 6 emails I received' " +
      "or 'what is on my calendar Thursday'. Returns metadata and a short snippet, not full " +
      "bodies. Every response includes a `coverage` object describing what the store actually " +
      "holds; if the question reaches outside that window, say so instead of answering from " +
      "whatever happens to be present. A `query` matches on both wording and meaning, so " +
      "phrasing it the way the user did generally works better than guessing keywords.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional keywords. Omit entirely to browse by time.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["message", "event"] },
          description:
            "Which kinds to include. Omit for everything, which is usually right for " +
            "questions that span sources.",
        },
        direction: {
          type: "string",
          enum: ["inbound", "outbound"],
          description:
            "Messages only. inbound = received, outbound = sent. Has no effect on events.",
        },
        since: {
          type: "string",
          description:
            "ISO 8601. Include an offset (2026-08-01T00:00:00-04:00); a bare date is read " +
            "as UTC. An item counts as in range if any part of it overlaps, so a meeting " +
            "spanning midnight appears on both days.",
        },
        until: { type: "string", description: "ISO 8601. Upper bound of the range." },
        order: {
          type: "string",
          enum: ["newest", "oldest"],
          description:
            "Default newest-first, which suits mail. Use oldest for a forward-looking " +
            "schedule so the day reads in order.",
        },
        person: {
          type: "string",
          description:
            "An entity id from find_person. Restricts results to items that person authored " +
            "or took part in. More reliable than putting their name in `query`.",
        },
        limit: { type: "integer", description: "How many to return. Default 20, maximum 100." },
      },
    },
  },
  {
    name: "people",
    description:
      "Who the user has actually been in contact with, most recent first, with how many " +
      "messages and when. Use this for questions like 'who have I contacted recently' or " +
      "'who have I not spoken to in a while'. This reads the resolved identity links, so it " +
      "covers texts filed under a phone number as well as mail.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How far back to look. Defaults to 30." },
        limit: { type: "number", description: "How many people. Defaults to 20." },
      },
    },
  },
  {
    name: "find_person",
    description:
      "Resolve a name, partial name, or address to the people Harbor knows about. Returns " +
      "each match with its id, known addresses, and how much correspondence there is. Call " +
      "this FIRST for any question that names a person, then pass the id as `person` to " +
      "`conversations` for what was said and to `search` for everything else. This matters " +
      "more than it sounds: a text message never contains the sender's name, so searching " +
      "for someone by name finds nothing even when there are thousands of their messages " +
      "filed under a phone number. Never conclude that a person's messages are absent " +
      "without having tried their entity id. If several people match, ask which one.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A name, part of one, or an email address." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_item",
    description:
      "Fetch the full content of one item by its Harbor id, as returned by search. Use this " +
      "when a snippet is not enough to answer accurately.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Harbor item id." } },
      required: ["id"],
    },
  },
  {
    name: "pending_signals",
    description:
      "What Harbor has already noticed and queued as worth mentioning: dropped threads, " +
      "items matching what the user said they are working on. Call this for open questions " +
      "like 'anything I should deal with?' or 'what am I forgetting?'. Each entry carries the " +
      "items it was derived from; never restate one without the specifics underneath it.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many, at most. Default 5." },
      },
    },
  },
  {
    name: "situations",
    description:
      "Sets of items from different sources that appear to be about one real-world thing: an " +
      "email, a calendar entry, and a text about the same trip. Use this when the question is " +
      "about what is going on rather than about finding a particular item, and when a plain " +
      "search would return three unrelated fragments of one story. Each situation says which " +
      "sources contributed and why the items were connected.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "One situation, by the id from a previous result or from the person's message. " +
            "Use this whenever an id is available: it returns that situation whatever its " +
            "age, where a plain listing only covers recent ones.",
        },
        since: {
          type: "string",
          description: "Only situations active after this ISO 8601 time.",
        },
        limit: { type: "number", description: "How many, default 8." },
      },
    },
  },
  {
    name: "purchases",
    description:
      "Things that were bought, extracted from receipts and order confirmations, with " +
      "merchant, date, total, and line items. Use this for any question about spending, " +
      "what was bought, how much something cost, or where money went. It can be summed and " +
      "grouped, which search cannot do. Only receipts Harbor could read and verify are here, " +
      "so say so if a total might be incomplete.",
    input_schema: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Narrow to one merchant." },
        since: { type: "string", description: "ISO 8601." },
        until: { type: "string", description: "ISO 8601." },
        group_by_merchant: {
          type: "boolean",
          description: "Return totals per merchant instead of individual purchases.",
        },
        limit: { type: "integer", description: "How many, default 20." },
      },
    },
  },
  {
    name: "commitments",
    description:
      "Things that were said would happen and have not happened yet, assembled across " +
      "sources: an intention stated in a conversation, a reminder written down, a calendar " +
      "entry that formalizes it. Use this for \"what am I forgetting\", \"what do I owe " +
      "someone\", \"what did I say I would do\", or anything about outstanding obligations. " +
      "Each one carries the evidence it was built from; never state one without it.",
    input_schema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["open", "lapsed", "done", "all"],
          description: "Default open, which means stated or scheduled.",
        },
        due_before: { type: "string", description: "ISO 8601. Only ones due before this." },
        limit: { type: "integer", description: "How many, default 15." },
      },
    },
  },
  {
    name: "conversations",
    description:
      "Search conversations rather than individual messages. A text message on its own is " +
      "usually meaningless (\"yeah saturday works\"), so message-based sources are indexed as " +
      "episodes: one continuous stretch of a chat, with who was talking and what was said. " +
      "Use this for anything about what was discussed, planned, suggested, or agreed in " +
      "messages. Returns a transcript for each match. For anything about a named person, " +
      "call `find_person` first and pass the id as `person`, with or without a query: the " +
      "name will not be in the text, so a query alone will miss everything. " +
      "CRITICAL: a transcript is two or more people talking. Every line is labelled with " +
      "who said it, and `You:` is the user. Something the user said is NOT evidence about " +
      "the other person: if the user says \"can't wait for the hot tub\" to someone, that " +
      "tells you about the user's plans, not that person's. For any question about what " +
      "someone else likes, wants, said, or is doing, pass `said_by` with their entity id " +
      "and read the `quotes` array, which contains only their own words.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What the conversation was about. Omit for the most recent ones.",
        },
        person: {
          type: "string",
          description:
            "An entity id from find_person. Finds conversations they took part in. Taking " +
            "part is not the same as saying something: use said_by for that.",
        },
        said_by: {
          type: "string",
          description:
            "An entity id from find_person, or \"me\" for the user. Adds a `quotes` array " +
            "holding only the lines that person actually spoke. Use this whenever the " +
            "question is about one person rather than about the conversation.",
        },
        since: { type: "string", description: "ISO 8601. Only conversations active after this." },
        limit: { type: "integer", description: "How many, default 6." },
      },
    },
  },
  {
    name: "conversation",
    description:
      "The full transcript of one conversation episode, by id. Call this after conversations " +
      "or after a message search result that carries an episode id, when the excerpt is not " +
      "enough to answer accurately.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "An episode id." } },
      required: ["id"],
    },
  },
  {
    name: "related",
    description:
      "Everything connected to one item, with the reason for each connection. Use this after " +
      "finding something relevant to see what else belongs with it, which is often where the " +
      "answer actually is.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "An item id." } },
      required: ["id"],
    },
  },
  {
    name: "about_harbor",
    description:
      "What Harbor is, which sources are connected, what it can and cannot do, and the " +
      "commands that drive it. Call this for questions about Harbor itself rather than about " +
      "the user's data: what are you connected to, what can you do, how do I add a calendar, " +
      "why can you not send email.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "coverage",
    description:
      "Report what the store contains, broken down by kind: how many items, the oldest and " +
      "newest of each, and whether every source has finished a full ingest. Call this when " +
      "the user asks about a period you are not sure is covered, or when they ask what " +
      "Harbor knows.",
    input_schema: { type: "object", properties: {} },
  },
];

/** Snippet length in listings. Long enough to summarize from, short enough to list 20. */
const LIST_SNIPPET_CHARS = 300;
const FULL_BODY_CHARS = 12_000;

function asDirection(value: unknown): Direction | undefined {
  return value === "inbound" || value === "outbound" || value === "internal" ? value : undefined;
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function asKinds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const kinds = value.filter((entry): entry is string => typeof entry === "string");
  return kinds.length === 0 ? undefined : kinds;
}

export interface ToolInvocation {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ToolOutcome {
  readonly content: string;
  readonly isError: boolean;
  /** Item ids this call exposed. The evidence trail for whatever gets said. */
  readonly itemIds: readonly string[];
  /** What policy did to this call. Folded into the audit row by the ask loop. */
  readonly gate?: import("../policy/gate.js").GateSummary;
}

export interface ToolContext {
  readonly principal: string;
  readonly timezone: string;
  /** Absent when no embedding backend is reachable; search degrades to keyword. */
  readonly embedder?: Embedder | undefined;
}

type Sensitivity = "normal" | "sensitive" | "restricted";

/** The conversation an item belongs to, if it is part of one. */
function episodeHandle(
  db: DB,
  item: { readonly id: string },
): { readonly episode: string; readonly episode_with: readonly string[] } | null {
  const episode = episodeForItem(db, item.id);

  if (episode === null) {
    return null;
  }

  return { episode: episode.id, episode_with: episode.participants };
}

interface GateFacts {
  readonly sensitivity: Sensitivity;
  readonly entityIds: readonly string[];
}

/**
 * Facts policy needs that are not on the item row.
 *
 * Unclassified items are treated as sensitive rather than normal. An item that
 * has never been through `harbor dev classify` is unknown, and unknown is not the
 * same as safe.
 */
function gateFacts(db: DB, itemId: string): GateFacts {
  const row = db.prepare(`SELECT sensitivity FROM items WHERE id = ?`).get(itemId) as
    | { sensitivity: Sensitivity | null }
    | undefined;

  const entities = db
    .prepare(`SELECT entity_id AS id FROM item_entities WHERE item_id = ?`)
    .all(itemId) as { id: string }[];

  return {
    sensitivity: row?.sensitivity ?? "sensitive",
    entityIds: entities.map((entry) => entry.id),
  };
}

/**
 * Runs a node through the gate and renders what may leave.
 *
 * A node may be a conversation covering forty messages, and policy is defined
 * over items. The conservative reading is the correct one here: if any message
 * in a conversation may not leave, the conversation does not leave either.
 * Admitting the rest would mean handing a model a transcript with a hole in it
 * and no way to know there was one.
 */
function admitNode(
  db: DB,
  gate: Gate,
  ref: NodeRef,
  timezone: string,
): { readonly summary: NodeSummary; readonly title: string; readonly from?: string } | null {
  const summary = summarize(db, ref);

  if (summary === null) {
    return null;
  }

  let title = summary.title ?? "";
  let author = summary.author ?? "";

  for (const itemId of summary.itemIds) {
    const facts = gateFacts(db, itemId);
    const row = db.prepare(`SELECT kind, title, author FROM items WHERE id = ?`).get(itemId) as
      | { kind: string; title: string | null; author: string | null }
      | undefined;

    if (row === undefined) {
      continue;
    }

    const outcome = gate.admit(
      {
        id: itemId,
        kind: row.kind,
        sensitivity: facts.sensitivity,
        entityIds: facts.entityIds,
        text: `${row.title ?? ""}\n${row.author ?? ""}`,
      },
      (text) => text,
    );

    if (outcome.value === null) {
      return null;
    }

    // For an item the redacted rendering is what gets shown. For an episode the
    // members only decide admission; the conversation's own title is what a
    // person reads.
    if (ref.kind === "item") {
      const [redactedTitle, redactedAuthor] = outcome.value.split("\n");
      title = redactedTitle ?? "";
      author = redactedAuthor ?? "";
    }
  }

  void timezone;

  // Resolved once, here, so situations and `related` both get names rather
  // than each remembering to ask.
  return {
    summary,
    title: nameHandles(db, title),
    ...(author.length === 0 ? {} : { from: nameForHandle(db, author) ?? author }),
  };
}

function describeCoverage(db: DB, context: ToolContext): Record<string, unknown> {
  const overall = coverageFor(db, context.principal);
  const byKind = coverageByKind(db, context.principal);

  return {
    total_items: overall.items,
    // "What do you have" almost always means "from where" too.
    sources: connectedSources(db).map(
      (source) => `${source.connector} (${source.account})`,
    ),
    by_kind: byKind.map((entry) => ({
      kind: entry.kind,
      count: entry.count,
      oldest: entry.oldest === null ? null : humanWhen(entry.oldest, context.timezone),
      newest: entry.newest === null ? null : humanWhen(entry.newest, context.timezone),
    })),
    messages_received: overall.inbound,
    messages_sent: overall.outbound,
    full_history_ingested: overall.complete,
    note: overall.complete
      ? "Every connected source has finished a full ingest, so the absence of an item is " +
        "meaningful within the ranges above."
      : "At least one source is only partly ingested. Anything outside the ranges above is " +
        "unknown, not absent. Do not treat a gap as evidence that nothing happened.",
  };
}

/**
 * Async because a semantic query has to be embedded first. Everything else here
 * is a synchronous SQLite read.
 */
/**
 * How the user's own lines are labelled in a payload a model reads.
 *
 * Stored transcripts say "Me:", which is unambiguous in a file and not in a
 * tool result: "me" is whoever happens to be speaking. A model reading a
 * conversation whose `with` field says "Esperanza Duprée" reasonably reads the
 * whole thing as hers, which is how Harbor came to believe the user was going
 * on a beach weekend with someone he had merely told about a hot tub.
 */
export const SELF_SPEAKER = "You";

export function asYou(transcript: string): string {
  return transcript.replace(/^Me:/gm, `${SELF_SPEAKER}:`);
}

/**
 * Only the lines one person actually spoke.
 *
 * The transcript keeps its labels either way; this is an additional, explicit
 * answer to "what did *they* say", so a model asked what someone likes reads
 * that person's own words rather than inferring from a conversation they were
 * merely present for.
 *
 * Speaker matching is by prefix on the label rather than equality, because a
 * group chat labels people by whatever name resolution produced and a display
 * name may carry a surname the query does not.
 */
/**
 * The `said_by` half of a conversation payload.
 *
 * Separate from `quotesBy` so a speaker who matched nothing is distinguishable
 * from a speaker who said nothing. An empty array alone cannot tell those
 * apart, and a model reading one will report the second.
 */
export function quotesFor(transcript: string, speaker: string): Record<string, unknown> {
  const quotes = quotesBy(transcript, speaker);

  if (quotes.length > 0) {
    return { said_by: speaker, quotes };
  }

  return {
    said_by: speaker,
    quotes: [],
    said_by_note:
      `No lines in this transcript are labelled "${speaker}". Do not conclude they said ` +
      `nothing: the label may differ from the name you used. The speakers here are ` +
      `${speakersIn(transcript).join(", ") || "none"}. Retry with one of those.`,
  };
}

/** Every distinct speaker label in a transcript, for reporting a miss usefully. */
export function speakersIn(transcript: string): readonly string[] {
  const seen = new Set<string>();

  for (const line of transcript.split("\n")) {
    const split = line.indexOf(": ");

    if (split > 0 && split < 60) {
      seen.add(line.slice(0, split).trim());
    }
  }

  return [...seen];
}

export function quotesBy(transcript: string, speaker: string): readonly string[] {
  const wanted = speaker.trim().toLowerCase();
  const found: string[] = [];

  for (const line of transcript.split("\n")) {
    const split = line.indexOf(": ");

    if (split <= 0) {
      continue;
    }

    const label = line.slice(0, split).trim().toLowerCase();

    if (label === wanted || label.startsWith(`${wanted} `) || wanted.startsWith(`${label} `)) {
      found.push(line.slice(split + 2).trim());
    }
  }

  return found.slice(0, 40);
}

/**
 * Why a conversation search came back empty, in facts.
 *
 * Every number here is measured, so the model can tell the three cases apart:
 * no episodes at all, a person who appears in none, and a query that simply
 * missed. Those need completely different answers and used to be reported
 * identically.
 */
function emptyConversationDiagnosis(
  db: DB,
  params: { readonly personId?: string; readonly query?: string },
): Record<string, unknown> {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number }).n;

  if (total === 0) {
    return {
      note:
        "This store holds no conversations at all. Message sources are grouped into " +
        "episodes by `harbor dev derive`, which has not produced any. Say that, and do " +
        "not claim the person said nothing.",
    };
  }

  const facts: Record<string, unknown> = { episodes_in_store: total };

  if (params.personId !== undefined) {
    const reachable = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT ei.episode_id) AS n
           FROM episode_items ei
           JOIN item_entities ie ON ie.item_id = ei.item_id
           WHERE ie.entity_id = ?`,
        )
        .get(params.personId) as { n: number }
    ).n;

    const linkedItems = (
      db.prepare(`SELECT COUNT(*) AS n FROM item_entities WHERE entity_id = ?`).get(
        params.personId,
      ) as { n: number }
    ).n;

    facts["person_linked_items"] = linkedItems;
    facts["person_appears_in_episodes"] = reachable;

    if (reachable === 0 && linkedItems > 0) {
      // The one case worth naming outright, because it is a real gap in the
      // store rather than a miss: their items exist and none of them landed in
      // a conversation, so no query will ever reach them by person.
      facts["note"] =
        `This person is linked to ${String(linkedItems)} items, but none of those items ` +
        `belong to a conversation, so filtering conversations by them can never match. ` +
        `Their messages may not have been grouped into episodes. Search without the ` +
        `person filter, or use search with person set instead. Do not say the indexing ` +
        `is incomplete and do not say they have not asked anything.`;

      return facts;
    }

    if (reachable > 0) {
      facts["note"] =
        `This person does appear in ${String(reachable)} conversations, so the query is ` +
        `what missed, not the person. Retry with different wording or with no query at ` +
        `all to get their most recent conversations. Do not say the indexing is incomplete.`;

      return facts;
    }
  }

  facts["note"] =
    params.query === undefined
      ? "Nothing matched, and no query was given. Do not claim indexing is incomplete."
      : `Nothing matched "${params.query}". The store has conversations; this query missed. ` +
        `Retry with different wording, or with no query to get the most recent ones. Do ` +
        `not claim indexing is incomplete.`;

  return facts;
}

export async function runTool(
  db: DB,
  context: ToolContext,
  call: ToolInvocation,
): Promise<ToolOutcome> {
  if (call.name === "situations") {
    const since =
      typeof call.input["since"] === "string" ? Date.parse(call.input["since"]) : undefined;

    // A named situation is fetched directly rather than hoped for in a listing.
    //
    // The interface offers "Ask about this" on a situation, and without this
    // branch that button sent a title and nothing else. A title like "Test
    // rename" or "issy?" matches nothing, the listing only covers recent ones,
    // and the honest answer the model gave was that it had never heard of it.
    const wanted = typeof call.input["id"] === "string" ? call.input["id"] : null;

    const one = wanted === null ? null : getThread(db, wanted);

    if (wanted !== null && (one === null || one.principalId !== context.principal)) {
      return {
        content: JSON.stringify({ situations: [], note: `No situation with id ${wanted}.` }),
        isError: false,
        itemIds: [],
      };
    }

    const found =
      one !== null
        ? [one]
        : topThreads(db, context.principal, {
            limit: typeof call.input["limit"] === "number" ? call.input["limit"] : 8,
            ...(since === undefined || Number.isNaN(since) ? {} : { since }),
            // One source is a conversation the source application already
            // shows. Two is the thing Harbor can see and nothing else can.
            minSources: 2,
          });

    const gate = Gate.open(db);
    const described = [];

    for (const thread of found) {
      // Through the gate like everything else. A situation is a view over
      // nodes, and a view does not get to bypass policy.
      const admitted = [];
      let withheld = 0;

      for (const ref of threadNodes(db, thread.id)) {
        const shown = admitNode(db, gate, ref, context.timezone);

        if (shown === null) {
          withheld += 1;
          continue;
        }

        admitted.push({
          id: nodeKey(ref),
          kind: shown.summary.kind,
          title: shown.title,
          ...(shown.from === undefined ? {} : { from: shown.from }),
          when: humanWhen(shown.summary.occurredAt, context.timezone),
          ...(ref.kind === "episode"
            ? { messages: shown.summary.itemIds.length }
            : {}),
        });
      }

      described.push({
        id: thread.id,
        title: thread.title ?? "(unnamed)",
        ...(thread.summary === null ? {} : { summary: thread.summary }),
        spans: `${humanWhen(thread.startsAt ?? 0, context.timezone)} to ${humanWhen(thread.endsAt ?? 0, context.timezone)}`,
        sources: thread.sourceCount,
        kinds: thread.kind,
        items: admitted,
        ...(withheld > 0 ? { withheld } : {}),
      });
    }

    return {
      content: JSON.stringify(
        described.length === 0
          ? {
              situations: [],
              note:
                "Nothing spanning more than one source yet. This needs `harbor dev relate` to " +
                "have run, and it needs more than one source connected.",
            }
          : { situations: described },
        null,
        1,
      ),
      isError: false,
      itemIds: [],
    };
  }

  if (call.name === "purchases") {
    const since =
      typeof call.input["since"] === "string" ? Date.parse(call.input["since"]) : undefined;
    const until =
      typeof call.input["until"] === "string" ? Date.parse(call.input["until"]) : undefined;

    if (call.input["group_by_merchant"] === true) {
      const rows = spendByMerchant(
        db,
        context.principal,
        since === undefined || Number.isNaN(since) ? Date.now() - 90 * 86_400_000 : since,
        until === undefined || Number.isNaN(until) ? Date.now() : until,
      );

      return {
        content: JSON.stringify(
          {
            by_merchant: rows.map((row) => ({
              merchant: row.merchant,
              total: row.totalCents / 100,
              currency: row.currency,
              purchases: row.count,
            })),
            caveat: "Only receipts Harbor could read and verify are counted.",
          },
          null,
          1,
        ),
        isError: false,
        itemIds: [],
      };
    }

    const found = listProjections(db, {
      principalId: context.principal,
      type: "purchase",
      ...(since === undefined || Number.isNaN(since) ? {} : { since }),
      ...(until === undefined || Number.isNaN(until) ? {} : { until }),
      ...(typeof call.input["merchant"] === "string" ? { merchant: call.input["merchant"] } : {}),
      limit: typeof call.input["limit"] === "number" ? call.input["limit"] : 20,
    });

    // The same deduplication the CLI applies. A model asked "what did I spend
    // at the golf store" should not be handed one launch monitor twice and left
    // to work out that the order confirmation and the receipt are one purchase.
    const described = dedupePurchases(found)
      .map((index) => found[index])
      .filter((purchase): purchase is (typeof found)[number] => purchase !== undefined)
      .map((purchase) => ({
      merchant: purchase.merchant,
      total: purchase.totalCents === null ? null : purchase.totalCents / 100,
      currency: purchase.currency,
      when: humanWhen(purchase.occurredAt, context.timezone),
      reference: purchase.reference ?? undefined,
      confidence: purchase.confidence,
      items: linesFor(db, purchase.id).map((line) => ({
        what: line.description,
        quantity: line.quantity ?? undefined,
        amount: line.amountCents === null ? undefined : line.amountCents / 100,
      })),
      // The receipt it came from, so any figure can be checked against the
      // original rather than taken on faith.
      from_item: purchase.itemId,
    }));

    return {
      content: JSON.stringify(
        described.length === 0
          ? {
              purchases: [],
              note: "Nothing extracted yet. This needs `harbor dev extract` to have run.",
            }
          : { purchases: described },
        null,
        1,
      ),
      isError: false,
      itemIds: found.map((purchase) => purchase.itemId),
    };
  }

  if (call.name === "commitments") {
    const requested = String(call.input["state"] ?? "open");

    const states =
      requested === "all"
        ? (["stated", "scheduled", "done", "lapsed", "cancelled"] as const)
        : requested === "lapsed"
          ? (["lapsed"] as const)
          : requested === "done"
            ? (["done"] as const)
            : (["stated", "scheduled"] as const);

    const dueBefore =
      typeof call.input["due_before"] === "string" ? Date.parse(call.input["due_before"]) : undefined;

    const found = listCommitments(db, {
      principalId: context.principal,
      states: [...states],
      limit: typeof call.input["limit"] === "number" ? call.input["limit"] : 15,
      ...(dueBefore === undefined || Number.isNaN(dueBefore) ? {} : { dueBefore }),
    });

    const described = found.map((commitment) => ({
      id: commitment.id,
      what: commitment.title,
      state: commitment.state,
      owner: commitment.owner,
      due: commitment.dueAt === null ? undefined : humanWhen(commitment.dueAt, context.timezone),
      due_iso: commitment.dueAt === null ? undefined : localIso(commitment.dueAt, context.timezone),
      scheduled_for:
        commitment.occursAt === null ? undefined : humanWhen(commitment.occursAt, context.timezone),
      confidence: commitment.confidence,
      // The evidence is not optional context. A commitment is Harbor's own
      // claim rather than something a source said, so an answer that repeats
      // one without saying where it came from is unverifiable by the reader.
      because: evidenceFor(db, commitment.id).map((record) => ({
        role: record.role,
        detail: record.note,
        when: humanWhen(record.occurredAt, context.timezone),
        item: record.itemId ?? undefined,
        conversation: record.episodeId ?? undefined,
      })),
    }));

    return {
      content: JSON.stringify(
        described.length === 0
          ? {
              commitments: [],
              note:
                "Nothing on the books. This needs `harbor dev commit` to have run, and it needs " +
                "reminders or conversations to have been ingested.",
            }
          : { commitments: described },
        null,
        1,
      ),
      isError: false,
      itemIds: described.flatMap((entry) =>
        entry.because.map((record) => record.item).filter((id): id is string => id !== undefined),
      ),
    };
  }

  if (call.name === "conversations" || call.name === "conversation") {
    const gate = Gate.open(db);

    // Who the caller is asking about, as that person appears in a transcript.
    //
    // The label for the user's own lines is "Me:" in storage, which is fine in
    // a file and ambiguous in a payload a model is reading: "me" is whoever is
    // talking. Rendered as "You:" here so there is exactly one reading.
    const saidByInput = String(call.input["said_by"] ?? "").trim();

    // An entity id is what the schema asks for, and a name or a raw handle is
    // what actually turns up, because the model has the name in front of it and
    // the id is one tool call away. Falling back to the literal string means
    // both work.
    //
    // The important part is what happens when neither matches. Returning an
    // empty `quotes` array reads as "that person said nothing", which is a
    // confident wrong answer of exactly the kind this whole change exists to
    // stop. So a miss is reported as a miss.
    const saidBy =
      saidByInput.length === 0
        ? null
        : saidByInput.toLowerCase() === "me" || saidByInput.toLowerCase() === "you"
          ? SELF_SPEAKER
          : (resolveEntity(db, saidByInput)?.displayName ?? saidByInput);

    // A conversation is a view over messages, so it goes through the gate like
    // anything else. Withholding here is coarse by design: a redacted line in
    // the middle of a transcript would read as though the person never said it.
    const admit = (episode: {
      id: string;
      title: string | null;
      transcript: string;
      participants: readonly string[];
      messageCount: number;
      startsAt: number;
      endsAt: number;
    }): Record<string, unknown> | null => {
      const items = episodeItems(db, episode.id);
      const entityIds = new Set<string>();
      let worst: Sensitivity = "normal";

      for (const itemId of items) {
        const facts = gateFacts(db, itemId);

        for (const entity of facts.entityIds) {
          entityIds.add(entity);
        }

        if (facts.sensitivity === "restricted") {
          worst = "restricted";
        } else if (facts.sensitivity === "sensitive" && worst === "normal") {
          worst = "sensitive";
        }
      }

      const outcome = gate.admit(
        {
          id: episode.id,
          kind: "conversation",
          sensitivity: worst,
          entityIds: [...entityIds],
          text: episode.transcript,
        },
        (text) => text,
      );

      if (outcome.value === null) {
        return null;
      }

      // Names, not handles.
      //
      // This payload is what a model reads when somebody asks who they have
      // been texting, and it used to be phone numbers: `with` was the raw
      // participant list and the transcript's speaker labels were whatever the
      // source called them. Harbor had 1,403 resolved people and 2,700
      // identifiers and answered with a table of digits.
      const named = asYou(nameTranscript(db, outcome.value));

      return {
        id: episode.id,
        with: episode.participants.map((handle) => nameForHandle(db, handle) ?? handle),
        title: episode.title === null ? undefined : nameHandles(db, episode.title),
        messages: episode.messageCount,
        when: humanWhen(episode.endsAt, context.timezone),
        started: humanWhen(episode.startsAt, context.timezone),
        transcript: named,
        ...(saidBy === null ? {} : quotesFor(named, saidBy)),
        item_ids: items,
      };
    };

    if (call.name === "conversation") {
      const id = String(call.input["id"] ?? "");
      const episode = getEpisode(db, id);

      if (episode === null) {
        return { content: JSON.stringify({ error: "no such conversation" }), isError: true, itemIds: [] };
      }

      const described = admit(episode);

      return {
        content: JSON.stringify(described ?? { withheld: "policy" }, null, 1),
        isError: false,
        itemIds: described === null ? [] : episodeItems(db, id),
      };
    }

    const since =
      typeof call.input["since"] === "string" ? Date.parse(call.input["since"]) : undefined;

    const hits = await searchEpisodes(db, {
      principal: context.principal,
      ...(typeof call.input["query"] === "string" ? { query: call.input["query"] } : {}),
      ...(typeof call.input["person"] === "string" ? { personId: call.input["person"] } : {}),
      ...(since === undefined || Number.isNaN(since) ? {} : { since }),
      limit: typeof call.input["limit"] === "number" ? call.input["limit"] : 6,
      ...(context.embedder === undefined ? {} : { embedder: context.embedder }),
    });

    const described = [];
    const ids: string[] = [];

    for (const hit of hits) {
      const entry = admit(hit.episode);

      if (entry === null) {
        continue;
      }

      described.push({ ...entry, matched: hit.reasons });
      ids.push(...episodeItems(db, hit.episode.id));
    }

    return {
      content: JSON.stringify(
        described.length === 0
          ? {
              conversations: [],
              // Facts, not a diagnosis.
              //
              // This used to assert a cause: that episodes had not been built
              // yet. On a store with thousands of them that is simply false,
              // and a model has no way to know it is false, so it reported
              // "the conversation indexing hasn't completed yet" to somebody
              // whose indexing had completed months earlier. A confidently
              // wrong explanation is worse than no explanation, because it
              // sends the person to fix something that is not broken.
              //
              // So this reports what is actually true of the store and lets
              // the model draw the conclusion, which is the same discipline
              // the coverage object already follows.
              ...emptyConversationDiagnosis(db, {
                ...(typeof call.input["person"] === "string"
                  ? { personId: call.input["person"] }
                  : {}),
                ...(typeof call.input["query"] === "string"
                  ? { query: call.input["query"] }
                  : {}),
              }),
            }
          : { conversations: described },
        null,
        1,
      ),
      isError: false,
      itemIds: ids,
    };
  }

  if (call.name === "related") {
    const id = String(call.input["id"] ?? "");
    const ref = parseNodeRef(id);
    const edges = connectionsFor(db, ref);
    const gate = Gate.open(db);

    const described = [];
    const evidence: string[] = [];

    for (const edge of edges) {
      const shown = admitNode(db, gate, edge.to, context.timezone);

      if (shown === null) {
        continue;
      }

      described.push({
        id: nodeKey(shown.summary.ref),
        kind: shown.summary.kind,
        title: shown.title,
        ...(shown.from === undefined ? {} : { from: shown.from }),
        when: humanWhen(shown.summary.occurredAt, context.timezone),
        because: edge.evidence,
        ...(edge.also.length === 0 ? {} : { and: edge.also }),
      });

      evidence.push(...shown.summary.itemIds);
    }

    return {
      content: JSON.stringify({ id: nodeKey(ref), related: described }, null, 1),
      isError: false,
      itemIds: evidence,
    };
  }

  if (call.name === "about_harbor") {
    const about = capabilities(db);

    return {
      content: JSON.stringify(
        {
          ...about,
          sources: about.sources.map((source) => ({
            ...source,
            lastSync:
              source.lastSync === null ? "never" : humanWhen(source.lastSync, context.timezone),
          })),
        },
        null,
        1,
      ),
      isError: false,
      itemIds: [],
    };
  }

  if (call.name === "coverage") {
    return {
      content: JSON.stringify(describeCoverage(db, context), null, 1),
      isError: false,
      itemIds: [],
    };
  }

  if (call.name === "pending_signals") {
    const limit = typeof call.input["limit"] === "number" ? Math.trunc(call.input["limit"]) : 5;

    // preview: a model looking at the queue must not consume the suppression
    // that stops the user being told the same thing twice.
    const brief = composeBrief(db, {
      principalId: context.principal,
      timezone: context.timezone,
      budget: Math.max(1, Math.min(limit, 20)),
      preview: true,
    });

    const itemIds = brief.entries.flatMap((entry) => entry.evidence.map((item) => item.id));

    return {
      content: JSON.stringify(
        {
          count: brief.entries.length,
          held_back: brief.withheld,
          signals: brief.entries.map((entry) => ({
            id: entry.observation.id,
            detector: entry.observation.detectorId,
            summary: entry.observation.title,
            detail: entry.observation.detail,
            salience: Number(entry.observation.salience.toFixed(2)),
            evidence: entry.evidence,
          })),
          note:
            brief.entries.length === 0
              ? "Nothing queued. Say so plainly rather than going looking for something."
              : undefined,
        },
        null,
        1,
      ),
      isError: false,
      itemIds,
    };
  }

  if (call.name === "people") {
    const days = typeof call.input["days"] === "number" ? call.input["days"] : 30;
    const limit = typeof call.input["limit"] === "number" ? call.input["limit"] : 20;

    const found = recentCorrespondents(db, context.principal, {
      since: Date.now() - Math.max(1, days) * 86_400_000,
      limit: Math.min(Math.max(1, limit), 50),
    });

    if (found.length === 0) {
      return {
        content: JSON.stringify({ count: 0, note: `Nobody in the last ${String(days)} days.` }),
        isError: false,
        itemIds: [],
      };
    }

    return {
      content: JSON.stringify(
        {
          count: found.length,
          days,
          people: found.map((person) => ({
            id: person.entityId,
            name: person.name,
            messages: person.messages,
            you_sent: person.sent,
            last: humanWhen(person.lastAt, context.timezone),
          })),
        },
        null,
        1,
      ),
      isError: false,
      itemIds: [],
    };
  }

  if (call.name === "find_person") {
    const name = call.input["name"];

    if (typeof name !== "string" || name.trim().length === 0) {
      return { content: "find_person requires a `name`.", isError: true, itemIds: [] };
    }

    const matches = lookupEntities(db, name, 8);

    if (matches.length === 0) {
      return {
        content: JSON.stringify(
          { count: 0, note: `Nobody matching "${name}" appears in the store.` },
          null,
          1,
        ),
        isError: false,
        itemIds: [],
      };
    }

    return {
      content: JSON.stringify(
        {
          count: matches.length,
          people: matches.map((match) => ({
            id: match.entity.id,
            name: match.entity.displayName,
            kind: match.entity.kind,
            addresses: match.addresses,
            items: match.items,
            received_from: match.received,
            sent_to: match.sent,
            last_contact:
              match.lastSeen === null ? null : humanWhen(match.lastSeen, context.timezone),
          })),
          note:
            matches.length > 1
              ? "Several people match. Ask which one rather than assuming."
              : undefined,
        },
        null,
        1,
      ),
      isError: false,
      itemIds: [],
    };
  }

  if (call.name === "search") {
    const query = typeof call.input["query"] === "string" ? call.input["query"] : undefined;

    let queryVector: Float32Array | undefined;

    if (query !== undefined && query.trim().length > 0 && context.embedder !== undefined) {
      try {
        queryVector = (await context.embedder.embed([query]))[0];
      } catch {
        // An embedding backend that has gone away should degrade search, not
        // break it. The reasons on each hit will show keyword-only matching.
        queryVector = undefined;
      }
    }

    const hits = search(
      db,
      {
        principal: context.principal,
        query,
        kinds: asKinds(call.input["kinds"]),
        direction: asDirection(call.input["direction"]),
        since: asTimestamp(call.input["since"]),
        until: asTimestamp(call.input["until"]),
        personId: typeof call.input["person"] === "string" ? call.input["person"] : undefined,
        order: call.input["order"] === "oldest" ? "oldest" : undefined,
        limit:
          typeof call.input["limit"] === "number" ? Math.trunc(call.input["limit"]) : undefined,
      },
      context.embedder,
      queryVector,
    );

    const gate = Gate.open(db);

    const rows = hits.flatMap((hit) => {
      const facts = gateFacts(db, hit.item.id);
      const snippet = (hit.item.snippet ?? hit.item.body ?? "").slice(0, LIST_SNIPPET_CHARS);

      const admitted = gate.admit(
        {
          id: hit.item.id,
          kind: hit.item.kind,
          sensitivity: facts.sensitivity,
          entityIds: facts.entityIds,
          text: `${hit.item.title ?? ""}\n${hit.item.author ?? ""}\n${snippet}`,
        },
        (text) => text,
      );

      if (admitted.value === null) {
        return [];
      }

      const [safeTitle, safeAuthor, ...rest] = admitted.value.split("\n");

      return [{
      id: hit.item.id,
      kind: hit.item.kind,
      ...(hit.item.direction === null ? {} : { direction: hit.item.direction }),
      from: safeAuthor ?? hit.item.author,
      with: hit.item.participants,
      title: safeTitle ?? hit.item.title,
      // Both forms deliberately: the ISO string for any arithmetic, the human
      // string so the model never has to produce one itself.
      when: humanWhen(hit.item.occurredAt, context.timezone),
      when_iso: localIso(hit.item.occurredAt, context.timezone),
      ...(hit.item.endsAt === null
        ? {}
        : {
            until: humanWhen(hit.item.endsAt, context.timezone),
            until_iso: localIso(hit.item.endsAt, context.timezone),
          }),
      snippet: rest.join("\n"),
      // A message from a conversational source carries a handle to the
      // conversation it sits in. On its own it is usually a fragment; this is
      // how the model gets from "one text matched" to "here is what was said".
      ...(episodeHandle(db, hit.item) ?? {}),
      // The state a reminder is in, which is the only thing about a reminder
      // that matters and used to be invisible.
      ...(hit.item.state === null ? {} : { state: hit.item.state }),
      ...(hit.item.dueAt === null
        ? {}
        : { due: humanWhen(hit.item.dueAt, context.timezone) }),
      link: hit.item.uri,
      reasons:
        admitted.redactions > 0
          ? [...hit.reasons, `${String(admitted.redactions)} value(s) redacted by policy`]
          : hit.reasons,
      }];
    });

    const summary = gate.summary();
    const notice = withholdingNotice(summary);

    return {
      content: JSON.stringify(
        {
          count: rows.length,
          coverage: describeCoverage(db, context),
          ...(notice === null ? {} : { policy: notice }),
          results: rows,
        },
        null,
        1,
      ),
      isError: false,
      itemIds: rows.map((row) => row.id),
      gate: summary,
    };
  }

  if (call.name === "get_item") {
    const id = call.input["id"];

    if (typeof id !== "string") {
      return { content: "get_item requires a string `id`.", isError: true, itemIds: [] };
    }

    const item = getItem(db, id);

    if (item === null) {
      return { content: `No item with id ${id}.`, isError: true, itemIds: [] };
    }

    const gate = Gate.open(db);
    const facts = gateFacts(db, item.id);

    const admitted = gate.admit(
      {
        id: item.id,
        kind: item.kind,
        sensitivity: facts.sensitivity,
        entityIds: facts.entityIds,
        text: item.body ?? item.snippet ?? "",
      },
      (text) => text.slice(0, FULL_BODY_CHARS),
    );

    if (admitted.value === null) {
      return {
        content: JSON.stringify(
          {
            id: item.id,
            title: item.title,
            when: humanWhen(item.occurredAt, context.timezone),
            withheld: true,
            note:
              "Policy withholds this item's content. Tell the user it exists and that Harbor " +
              "is not sending it out; do not guess at what it says.",
          },
          null,
          1,
        ),
        isError: false,
        itemIds: [item.id],
        gate: gate.summary(),
      };
    }

    return {
      content: JSON.stringify(
        {
          id: item.id,
          kind: item.kind,
          direction: item.direction,
          from: item.author,
          with: item.participants,
          title: item.title,
          when: humanWhen(item.occurredAt, context.timezone),
          when_iso: localIso(item.occurredAt, context.timezone),
          until: item.endsAt === null ? null : humanWhen(item.endsAt, context.timezone),
          link: item.uri,
          content: admitted.value,
          ...(admitted.redactions === 0
            ? {}
            : { redacted: `${String(admitted.redactions)} value(s) removed by policy` }),
        },
        null,
        1,
      ),
      isError: false,
      itemIds: [item.id],
      gate: gate.summary(),
    };
  }

  return { content: `Unknown tool: ${call.name}`, isError: true, itemIds: [] };
}
