/**
 * Retrieval.
 *
 * Three properties matter more than the implementation, and all three are
 * expensive to add later:
 *
 *   1. `principal` is a parameter, not a post-filter. Scoping happens inside
 *      the SQL. A query can never return an item the caller was not entitled
 *      to see, because it never selects one.
 *
 *   2. Every hit carries `reasons`. When Harbor answers from the wrong three
 *      messages, this is the only thing that will tell you why it chose them.
 *      With hybrid retrieval the reasons now say which retriever found an item,
 *      which is the difference between "the ranker is wrong" and "the embedding
 *      model is wrong".
 *
 *   3. Callers see one function. Lexical, semantic, and hybrid are a `mode`,
 *      not three APIs. Whatever replaces the current retrievers slots in here.
 *
 * Adding events changed the time filter and nothing else. A message happens at
 * an instant; an event occupies a span. "What is on my calendar Thursday" must
 * return a meeting that started Wednesday night and runs past midnight, so the
 * filter is an overlap test rather than a containment test. It degrades to the
 * old behaviour for items with no end.
 */
import { hydrateItem } from "../store/items.js";
import { openVectorIndex, setIndexPipelineVersion } from "./vector.js";
import type { DB } from "../kernel/db.js";
import type { Direction, ItemRow, StoredItem } from "../store/items.js";
import type { Embedder } from "../derive/embed/index.js";

export type SearchMode = "lexical" | "semantic" | "hybrid";

export interface SearchParams {
  /** Who is asking. Required. There is no unscoped search. */
  readonly principal: string;
  readonly query?: string | undefined;
  readonly direction?: Direction | undefined;
  /** Item kinds to include. Omit for everything. */
  readonly kinds?: readonly string[] | undefined;
  /** Epoch milliseconds, inclusive. */
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  readonly limit?: number | undefined;
  /** Entity id. Restricts to items that person authored or took part in. */
  readonly personId?: string | undefined;
  /** Chronological direction. Recency is right for mail, ascending for a schedule. */
  readonly order?: "newest" | "oldest" | undefined;
  /** Defaults to hybrid when an embedder is supplied, lexical otherwise. */
  readonly mode?: SearchMode | undefined;
}

export interface SearchHit {
  readonly item: StoredItem;
  readonly score: number;
  readonly reasons: readonly string[];
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** How deep each retriever goes before fusion. Wider than the final limit on purpose. */
const CANDIDATE_DEPTH = 60;
/** Reciprocal rank fusion constant. 60 is the value the original paper settled on. */
const RRF_K = 60;

/**
 * FTS5 treats a fair amount of punctuation as syntax. User text arrives from a
 * model here, so quote every term rather than trusting it to be well formed.
 */
function toMatchExpression(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_@.]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);

  if (terms.length === 0) {
    return null;
  }

  return terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
}

interface Filters {
  readonly where: readonly string[];
  readonly bind: Record<string, unknown>;
  readonly baseReasons: readonly string[];
}

function buildFilters(params: SearchParams, limit: number): Filters {
  const where: string[] = [
    "i.deleted_at IS NULL",
    // The scoping rule: your own accounts, plus anything explicitly shared with
    // the household. Default deny across principals.
    "(a.custodian_person_id = @principal OR i.visibility = 'household')",
  ];

  const bind: Record<string, unknown> = { principal: params.principal, limit };

  if (params.direction !== undefined) {
    where.push("i.direction = @direction");
    bind["direction"] = params.direction;
  }

  if (params.kinds !== undefined && params.kinds.length > 0) {
    const placeholders = params.kinds.map((_, index) => `@kind${String(index)}`);
    where.push(`i.kind IN (${placeholders.join(", ")})`);
    params.kinds.forEach((kind, index) => {
      bind[`kind${String(index)}`] = kind;
    });
  }

  if (params.personId !== undefined) {
    // EXISTS rather than a join: an item can link a person in more than one
    // role, and a join would return it once per role.
    where.push(
      "EXISTS (SELECT 1 FROM item_entities ie WHERE ie.item_id = i.id AND ie.entity_id = @personId)",
    );
    bind["personId"] = params.personId;
  }

  // Overlap, not containment: an item is in range if it starts before the
  // range ends and ends after the range starts. COALESCE makes a point-in-time
  // item its own endpoint.
  if (params.since !== undefined) {
    where.push("COALESCE(i.ends_at, i.occurred_at) >= @since");
    bind["since"] = params.since;
  }

  if (params.until !== undefined) {
    where.push("i.occurred_at <= @until");
    bind["until"] = params.until;
  }

  const baseReasons: string[] = [];

  if (params.direction === "inbound") {
    baseReasons.push("received");
  }
  if (params.direction === "outbound") {
    baseReasons.push("sent");
  }
  if (params.since !== undefined || params.until !== undefined) {
    baseReasons.push("within the requested time range");
  }
  if (params.personId !== undefined) {
    baseReasons.push("involves the requested person");
  }

  return { where, bind, baseReasons };
}

function browse(db: DB, params: SearchParams, filters: Filters, limit: number): readonly SearchHit[] {
  const order = params.order === "oldest" ? "ASC" : "DESC";

  const rows = db
    .prepare(
      `SELECT i.* FROM items i
       JOIN accounts a ON a.id = i.account_id
       WHERE ${filters.where.join(" AND ")}
       ORDER BY i.occurred_at ${order}
       LIMIT @limit`,
    )
    .all({ ...filters.bind, limit }) as ItemRow[];

  return rows.map((row, index) => ({
    item: hydrateItem(row),
    score: 1 / (index + 1),
    reasons: [
      ...filters.baseReasons,
      order === "ASC"
        ? `chronological (#${String(index + 1)})`
        : index === 0
          ? "most recent"
          : `recent (#${String(index + 1)})`,
    ],
  }));
}

interface Ranked {
  readonly itemId: string;
  readonly rank: number;
}

function lexicalCandidates(
  db: DB,
  filters: Filters,
  match: string,
  depth: number,
): readonly Ranked[] {
  const rows = db
    .prepare(
      `SELECT i.id AS id FROM items_fts
       JOIN items i ON i.id = items_fts.item_id
       JOIN accounts a ON a.id = i.account_id
       WHERE items_fts MATCH @match AND ${filters.where.join(" AND ")}
       ORDER BY bm25(items_fts)
       LIMIT @depth`,
    )
    .all({ ...filters.bind, match, depth }) as { id: string }[];

  // Deduplicate: several chunks of one item can match, but an item ranks once.
  const seen = new Set<string>();
  const ranked: Ranked[] = [];

  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    ranked.push({ itemId: row.id, rank: ranked.length + 1 });
  }

  return ranked;
}

function semanticCandidates(
  db: DB,
  filters: Filters,
  vector: Float32Array,
  embedder: Embedder,
  depth: number,
): readonly Ranked[] {
  const index = openVectorIndex(db, embedder.model, embedder.dims);
  // Over-fetch: the index knows nothing about principal, kind, or time, so
  // filtering happens after and would otherwise starve the result set.
  const hits = index.search(vector, depth * 4);

  if (hits.length === 0) {
    return [];
  }

  const ids = [...new Set(hits.map((hit) => hit.itemId))];
  const placeholders = ids.map((_, position) => `@id${String(position)}`);
  const idBind: Record<string, unknown> = {};

  ids.forEach((id, position) => {
    idBind[`id${String(position)}`] = id;
  });

  const allowed = new Set(
    (
      db
        .prepare(
          `SELECT i.id AS id FROM items i
           JOIN accounts a ON a.id = i.account_id
           WHERE i.id IN (${placeholders.join(", ")}) AND ${filters.where.join(" AND ")}`,
        )
        .all({ ...filters.bind, ...idBind }) as { id: string }[]
    ).map((row) => row.id),
  );

  const seen = new Set<string>();
  const ranked: Ranked[] = [];

  for (const hit of hits) {
    if (seen.has(hit.itemId) || !allowed.has(hit.itemId)) {
      continue;
    }
    seen.add(hit.itemId);
    ranked.push({ itemId: hit.itemId, rank: ranked.length + 1 });

    if (ranked.length >= depth) {
      break;
    }
  }

  return ranked;
}

/**
 * Reciprocal rank fusion.
 *
 * Chosen over a weighted score blend because BM25 scores and cosine
 * similarities are not on comparable scales and any weighting between them
 * would need recalibrating every time the embedding model changed. RRF only
 * uses positions, so it survives that.
 */
function fuse(
  lexical: readonly Ranked[],
  semantic: readonly Ranked[],
): readonly { itemId: string; score: number; sources: string[] }[] {
  const scores = new Map<string, { score: number; sources: string[] }>();

  const contribute = (ranked: readonly Ranked[], label: string): void => {
    for (const entry of ranked) {
      const existing = scores.get(entry.itemId) ?? { score: 0, sources: [] };
      existing.score += 1 / (RRF_K + entry.rank);
      existing.sources.push(label);
      scores.set(entry.itemId, existing);
    }
  };

  contribute(lexical, "keyword");
  contribute(semantic, "meaning");

  return [...scores.entries()]
    .map(([itemId, value]) => ({ itemId, score: value.score, sources: value.sources }))
    .sort((left, right) => right.score - left.score);
}

/**
 * `embedder` is optional. Without it, semantic modes degrade to lexical rather
 * than failing: a machine with no embedding server should still have working
 * search.
 */
export function search(
  db: DB,
  params: SearchParams,
  embedder?: Embedder,
  queryVector?: Float32Array,
): readonly SearchHit[] {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const filters = buildFilters(params, limit);

  if (params.query === undefined || params.query.trim().length === 0) {
    return browse(db, params, filters, limit);
  }

  const match = toMatchExpression(params.query);
  const canSemantic =
    embedder !== undefined && queryVector !== undefined && params.mode !== "lexical";

  const mode: SearchMode =
    params.mode ?? (canSemantic ? "hybrid" : "lexical");

  if (canSemantic) {
    setIndexPipelineVersion(1);
  }

  const lexical =
    mode === "semantic" || match === null
      ? []
      : lexicalCandidates(db, filters, match, CANDIDATE_DEPTH);

  const semantic =
    canSemantic && mode !== "lexical" && queryVector !== undefined && embedder !== undefined
      ? semanticCandidates(db, filters, queryVector, embedder, CANDIDATE_DEPTH)
      : [];

  if (lexical.length === 0 && semantic.length === 0) {
    return [];
  }

  const fused = fuse(lexical, semantic).slice(0, limit);

  if (fused.length === 0) {
    return [];
  }

  const placeholders = fused.map((_, position) => `@id${String(position)}`);
  const bind: Record<string, unknown> = {};

  fused.forEach((entry, position) => {
    bind[`id${String(position)}`] = entry.itemId;
  });

  const rows = db
    .prepare(`SELECT * FROM items WHERE id IN (${placeholders.join(", ")})`)
    .all(bind) as ItemRow[];

  const byId = new Map(rows.map((row) => [row.id, row]));

  const hits: SearchHit[] = [];

  for (const entry of fused) {
    const row = byId.get(entry.itemId);

    if (row === undefined) {
      continue;
    }

    const sources = [...new Set(entry.sources)];

    hits.push({
      item: hydrateItem(row),
      score: entry.score,
      reasons: [
        ...filters.baseReasons,
        sources.length === 2
          ? `matched on keyword and meaning`
          : sources[0] === "meaning"
            ? `similar in meaning to "${params.query}"`
            : `matches "${params.query}"`,
      ],
    });
  }

  return hits;
}

/** Convenience used by the CLI and by the tool layer for "the last N". */
export function mostRecent(
  db: DB,
  principal: string,
  direction: Direction,
  limit: number,
): readonly SearchHit[] {
  return search(db, { principal, direction, kinds: ["message"], limit });
}
