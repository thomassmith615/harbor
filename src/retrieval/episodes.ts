/**
 * Retrieval over conversations.
 *
 * The same shape as item retrieval, deliberately: keyword and semantic fused by
 * reciprocal rank, every hit carrying the reason it matched. The difference is
 * the unit. Asking the item index about "the trip we planned" returns three
 * fragments of a conversation and leaves the reader to reassemble it; asking
 * this returns the conversation.
 *
 * Scoping is by principal through the stream's account, in the SQL, for the
 * same reason it is there for items: a filter applied afterwards is a filter
 * somebody eventually forgets to apply.
 */
import { hydrateEpisode } from "../store/episodes.js";
import { openVectorIndex } from "./vector.js";
import type { DB } from "../kernel/db.js";
import type { Episode } from "../store/episodes.js";
import type { Embedder } from "../derive/embed/index.js";

export interface EpisodeHit {
  readonly episode: Episode;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface EpisodeSearchParams {
  readonly principal: string;
  readonly query?: string | undefined;
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  readonly limit?: number | undefined;
  /** Entity id. Restricts to conversations that person took part in. */
  readonly personId?: string | undefined;
  readonly embedder?: Embedder | undefined;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const CANDIDATE_DEPTH = 40;
const RRF_K = 60;

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

interface Scope {
  readonly where: readonly string[];
  readonly bind: Record<string, unknown>;
}

function scopeFor(params: EpisodeSearchParams): Scope {
  const where: string[] = [
    // An episode belongs to a stream, a stream to an account, and an account to
    // a custodian. The join is what keeps a household member's conversations
    // out of somebody else's search.
    "EXISTS (SELECT 1 FROM streams s JOIN accounts a ON a.id = s.account_id " +
      "WHERE s.id = e.stream_id AND a.custodian_person_id = @principal)",
  ];

  const bind: Record<string, unknown> = { principal: params.principal };

  if (params.since !== undefined) {
    where.push("e.ends_at >= @since");
    bind["since"] = params.since;
  }

  if (params.until !== undefined) {
    where.push("e.starts_at <= @until");
    bind["until"] = params.until;
  }

  if (params.personId !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM episode_items ei
               JOIN item_entities ie ON ie.item_id = ei.item_id
               WHERE ei.episode_id = e.id AND ie.entity_id = @personId)`,
    );
    bind["personId"] = params.personId;
  }

  return { where, bind };
}

function lexical(db: DB, scope: Scope, query: string, depth: number): readonly string[] {
  const match = toMatchExpression(query);

  if (match === null) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT e.id AS id FROM episodes_fts f
       JOIN episodes e ON e.id = f.episode_id
       WHERE episodes_fts MATCH @match AND ${scope.where.join(" AND ")}
       ORDER BY bm25(episodes_fts) ASC
       LIMIT @depth`,
    )
    .all({ ...scope.bind, match, depth }) as { id: string }[];

  return rows.map((row) => row.id);
}

function semantic(
  db: DB,
  scope: Scope,
  vector: Float32Array,
  embedder: Embedder,
  depth: number,
): readonly string[] {
  const index = openVectorIndex(db, embedder.model, embedder.dims);
  const hits = index.searchEpisodes(vector, depth * 4);

  if (hits.length === 0) {
    return [];
  }

  const ids = [...new Set(hits.map((hit) => hit.episodeId))];
  const placeholders = ids.map((_, position) => `@id${String(position)}`);
  const idBind: Record<string, unknown> = {};

  ids.forEach((id, position) => {
    idBind[`id${String(position)}`] = id;
  });

  const allowed = new Set(
    (
      db
        .prepare(
          `SELECT e.id AS id FROM episodes e
           WHERE e.id IN (${placeholders.join(", ")}) AND ${scope.where.join(" AND ")}`,
        )
        .all({ ...scope.bind, ...idBind }) as { id: string }[]
    ).map((row) => row.id),
  );

  const ordered: string[] = [];

  for (const hit of hits) {
    if (!allowed.has(hit.episodeId) || ordered.includes(hit.episodeId)) {
      continue;
    }

    ordered.push(hit.episodeId);

    if (ordered.length >= depth) {
      break;
    }
  }

  return ordered;
}

export async function searchEpisodes(
  db: DB,
  params: EpisodeSearchParams,
): Promise<readonly EpisodeHit[]> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const scope = scopeFor(params);

  // No query means "the most recent conversations", which is a legitimate ask
  // and needs no retrieval at all.
  if (params.query === undefined || params.query.trim().length === 0) {
    const rows = db
      .prepare(
        `SELECT e.* FROM episodes e
         WHERE ${scope.where.join(" AND ")}
         ORDER BY e.ends_at DESC
         LIMIT @limit`,
      )
      .all({ ...scope.bind, limit }) as Parameters<typeof hydrateEpisode>[0][];

    return rows.map((row) => ({
      episode: hydrateEpisode(row),
      score: 0,
      reasons: ["most recent"],
    }));
  }

  const keyword = lexical(db, scope, params.query, CANDIDATE_DEPTH);

  let vectors: readonly string[] = [];

  if (params.embedder !== undefined) {
    const embedded = (await params.embedder.embedQuery([params.query]))[0];

    if (embedded !== undefined) {
      vectors = semantic(db, scope, embedded, params.embedder, CANDIDATE_DEPTH);
    }
  }

  const scores = new Map<string, { score: number; reasons: string[] }>();

  const contribute = (ids: readonly string[], label: string): void => {
    ids.forEach((id, position) => {
      const existing = scores.get(id) ?? { score: 0, reasons: [] };
      existing.score += 1 / (RRF_K + position + 1);
      existing.reasons.push(label);
      scores.set(id, existing);
    });
  };

  contribute(keyword, "keyword");
  contribute(vectors, "semantic");

  const ranked = [...scores.entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .slice(0, limit);

  const hits: EpisodeHit[] = [];

  for (const [id, scored] of ranked) {
    const row = db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(id) as
      | Parameters<typeof hydrateEpisode>[0]
      | undefined;

    if (row === undefined) {
      continue;
    }

    hits.push({
      episode: hydrateEpisode(row),
      score: Number(scored.score.toFixed(6)),
      reasons: [...new Set(scored.reasons)],
    });
  }

  return hits;
}
