/**
 * Storing stories.
 *
 * Identity works exactly as it does for situations, and for the same reason:
 * a person who renamed or dismissed something is holding a reference, and a
 * reference that expires the moment one more text arrives is not a reference.
 * The matcher itself is shared rather than reimplemented; see
 * `derive/situations.ts`, which is the file that got this right first.
 */
import { randomBytes, createHash } from "node:crypto";
import { nodeKey } from "./nodes.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "./nodes.js";

export type StoryState = "open" | "resolved" | "dismissed";
/**
 * Where a story's title came from.
 *
 * `model` is a display string and nothing else: no derivation reads it, no
 * anchor is built from it, no scoring sees it. See `derive/name-stories.ts` for
 * why the boundary is drawn exactly there.
 */
export type TitleSource = "derived" | "user" | "model";

export interface StoryMember {
  readonly ref: NodeRef;
  readonly role: string;
  readonly score: number;
  readonly evidence: readonly string[];
}

export interface Story {
  readonly id: string;
  readonly principalId: string;
  readonly kind: string;
  readonly title: string | null;
  readonly titleSource: TitleSource;
  readonly summary: string | null;
  readonly place: string | null;
  /** The occasion itself. */
  readonly spanStartsAt: number;
  readonly spanEndsAt: number;
  /** Everything gathered, which reaches back into planning. */
  readonly startsAt: number;
  readonly endsAt: number;
  readonly memberCount: number;
  readonly sourceCount: number;
  readonly salience: number;
  readonly state: StoryState;
  readonly firstSeenAt: number | null;
  readonly lastChangedAt: number | null;
  readonly nodeDigest: string | null;
}

export interface StoryInput extends Omit<Story, "memberCount" | "sourceCount"> {
  readonly members: readonly StoryMember[];
  readonly sourceCount: number;
}

interface StoryRow {
  readonly id: string;
  readonly principal_id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly title_source: string;
  readonly summary: string | null;
  readonly place: string | null;
  readonly span_starts_at: number;
  readonly span_ends_at: number;
  readonly starts_at: number;
  readonly ends_at: number;
  readonly member_count: number;
  readonly source_count: number;
  readonly salience: number;
  readonly state: string;
  readonly first_seen_at: number | null;
  readonly last_changed_at: number | null;
  readonly node_digest: string | null;
}

function toStory(row: StoryRow): Story {
  return {
    id: row.id,
    principalId: row.principal_id,
    kind: row.kind,
    title: row.title,
    titleSource: row.title_source as TitleSource,
    summary: row.summary,
    place: row.place,
    spanStartsAt: row.span_starts_at,
    spanEndsAt: row.span_ends_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    memberCount: row.member_count,
    sourceCount: row.source_count,
    salience: row.salience,
    state: row.state as StoryState,
    firstSeenAt: row.first_seen_at,
    lastChangedAt: row.last_changed_at,
    nodeDigest: row.node_digest,
  };
}

export function newStoryId(): string {
  return `sty_${randomBytes(8).toString("hex")}`;
}

export function digestOf(refs: readonly NodeRef[]): string {
  return createHash("sha256").update(refs.map(nodeKey).sort().join("|")).digest("hex").slice(0, 16);
}

export interface ExistingStory {
  readonly id: string;
  readonly title: string | null;
  readonly titleSource: TitleSource;
  readonly state: StoryState;
  readonly firstSeenAt: number | null;
  readonly lastChangedAt: number | null;
  readonly nodeDigest: string | null;
  readonly nodeKeys: ReadonlySet<string>;
}

export function existingStories(db: DB, principalId: string): readonly ExistingStory[] {
  const rows = db
    .prepare(`SELECT * FROM stories WHERE principal_id = ?`)
    .all(principalId) as StoryRow[];

  const members = db.prepare(
    `SELECT node_kind, node_id FROM story_nodes WHERE story_id = ?`,
  );

  return rows.map((row) => {
    const keys = new Set(
      (members.all(row.id) as { node_kind: string; node_id: string }[]).map(
        (member) => `${member.node_kind}:${member.node_id}`,
      ),
    );

    return {
      id: row.id,
      title: row.title,
      titleSource: row.title_source as TitleSource,
      state: row.state as StoryState,
      firstSeenAt: row.first_seen_at,
      lastChangedAt: row.last_changed_at,
      nodeDigest: row.node_digest,
      nodeKeys: keys,
    };
  });
}

export function saveStory(db: DB, input: StoryInput, now: number): void {
  db.prepare(
    `INSERT INTO stories
       (id, principal_id, kind, title, title_source, summary, place,
        span_starts_at, span_ends_at, starts_at, ends_at,
        member_count, source_count, salience, state, state_changed_at,
        node_digest, first_seen_at, last_changed_at, created_at, updated_at)
     VALUES
       (@id, @principalId, @kind, @title, @titleSource, @summary, @place,
        @spanStartsAt, @spanEndsAt, @startsAt, @endsAt,
        @memberCount, @sourceCount, @salience, @state,
        (SELECT state_changed_at FROM stories WHERE id = @id),
        @nodeDigest, @firstSeenAt, @lastChangedAt, @now, @now)
     ON CONFLICT (id) DO UPDATE SET
       kind = excluded.kind,
       title = excluded.title,
       title_source = excluded.title_source,
       summary = excluded.summary,
       place = excluded.place,
       span_starts_at = excluded.span_starts_at,
       span_ends_at = excluded.span_ends_at,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       member_count = excluded.member_count,
       source_count = excluded.source_count,
       salience = excluded.salience,
       node_digest = excluded.node_digest,
       last_changed_at = excluded.last_changed_at,
       updated_at = excluded.updated_at`,
  ).run({
    id: input.id,
    principalId: input.principalId,
    kind: input.kind,
    title: input.title,
    titleSource: input.titleSource,
    summary: input.summary,
    place: input.place,
    spanStartsAt: input.spanStartsAt,
    spanEndsAt: input.spanEndsAt,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    memberCount: input.members.length,
    sourceCount: input.sourceCount,
    salience: input.salience,
    state: input.state,
    nodeDigest: input.nodeDigest,
    firstSeenAt: input.firstSeenAt,
    lastChangedAt: input.lastChangedAt,
    now,
  });

  db.prepare(`DELETE FROM story_nodes WHERE story_id = ?`).run(input.id);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO story_nodes (story_id, node_kind, node_id, role, score, evidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const member of input.members) {
    insert.run(
      input.id,
      member.ref.kind,
      member.ref.id,
      member.role,
      member.score,
      JSON.stringify(member.evidence),
    );
  }
}

export function deleteStory(db: DB, id: string): void {
  db.prepare(`DELETE FROM story_nodes WHERE story_id = ?`).run(id);
  db.prepare(`DELETE FROM stories WHERE id = ?`).run(id);
}

export function getStory(db: DB, id: string): Story | null {
  const row = db.prepare(`SELECT * FROM stories WHERE id = ?`).get(id) as StoryRow | undefined;

  return row === undefined ? null : toStory(row);
}

export function storyMembers(db: DB, id: string): readonly StoryMember[] {
  const rows = db
    .prepare(
      `SELECT sn.node_kind, sn.node_id, sn.role, sn.score, sn.evidence
       FROM story_nodes sn WHERE sn.story_id = ?`,
    )
    .all(id) as {
    node_kind: string;
    node_id: string;
    role: string;
    score: number;
    evidence: string;
  }[];

  return rows.map((row) => {
    let evidence: string[] = [];

    try {
      const parsed: unknown = JSON.parse(row.evidence);

      if (Array.isArray(parsed)) {
        evidence = parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      evidence = [];
    }

    return {
      ref: { kind: row.node_kind as NodeRef["kind"], id: row.node_id },
      role: row.role,
      score: row.score,
      evidence,
    };
  });
}

export interface StoryQuery {
  readonly limit?: number;
  readonly minSources?: number;
  readonly states?: readonly StoryState[];
  readonly kind?: string;
  /** Only stories whose occasion falls after this. */
  readonly since?: number;
  readonly until?: number;
  /**
   * Which side of now.
   *
   * "What happened" and "what is coming" are different questions, and a list
   * that answers both at once answers neither: a flight in November sat between
   * two weekends in August under a heading that said the past tense.
   */
  readonly tense?: "past" | "upcoming" | "all";
  readonly now?: number;
}

export function topStories(
  db: DB,
  principalId: string,
  query: StoryQuery = {},
): readonly Story[] {
  const states = query.states ?? (["open"] as const);
  const placeholders = states.map(() => "?").join(", ");

  const clauses = [`principal_id = ?`, `state IN (${placeholders})`, `source_count >= ?`];
  const bind: (string | number)[] = [principalId, ...states, query.minSources ?? 1];

  if (query.kind !== undefined) {
    clauses.push(`kind = ?`);
    bind.push(query.kind);
  }

  if (query.since !== undefined) {
    clauses.push(`span_ends_at >= ?`);
    bind.push(query.since);
  }

  if (query.until !== undefined) {
    clauses.push(`span_starts_at <= ?`);
    bind.push(query.until);
  }

  const now = query.now ?? Date.now();
  const tense = query.tense ?? "all";

  if (tense === "past") {
    clauses.push(`span_starts_at <= ?`);
    bind.push(now);
  } else if (tense === "upcoming") {
    clauses.push(`span_ends_at >= ?`);
    bind.push(now);
  }

  bind.push(query.limit ?? 20);

  // Ahead of you, the soonest thing matters most. Behind you, the most recent.
  const order = tense === "upcoming" ? "span_starts_at ASC" : "salience DESC, span_starts_at DESC";

  const rows = db
    .prepare(
      `SELECT * FROM stories WHERE ${clauses.join(" AND ")}
       ORDER BY ${order} LIMIT ?`,
    )
    .all(...bind) as StoryRow[];

  return rows.map(toStory);
}

export function storiesFor(db: DB, ref: NodeRef): readonly Story[] {
  const rows = db
    .prepare(
      `SELECT s.* FROM stories s
       JOIN story_nodes sn ON sn.story_id = s.id
       WHERE sn.node_kind = ? AND sn.node_id = ?`,
    )
    .all(ref.kind, ref.id) as StoryRow[];

  return rows.map(toStory);
}

export function setStoryState(db: DB, id: string, state: StoryState): boolean {
  const result = db
    .prepare(`UPDATE stories SET state = ?, state_changed_at = ? WHERE id = ?`)
    .run(state, Date.now(), id);

  return result.changes > 0;
}

export function renameStory(db: DB, id: string, title: string): boolean {
  const trimmed = title.trim();

  const result = db
    .prepare(`UPDATE stories SET title = ?, title_source = ?, updated_at = ? WHERE id = ?`)
    .run(
      trimmed.length === 0 ? null : trimmed,
      trimmed.length === 0 ? "derived" : "user",
      Date.now(),
      id,
    );

  return result.changes > 0;
}

export function countStories(db: DB, principalId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM stories WHERE principal_id = ?`).get(principalId) as {
      n: number;
    }
  ).n;
}

export function clearStories(db: DB): number {
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM stories`).get() as { n: number }).n;

  db.prepare(`DELETE FROM story_nodes`).run();
  db.prepare(`DELETE FROM stories`).run();

  return before;
}
