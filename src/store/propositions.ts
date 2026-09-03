/**
 * Standalone rewrites, stored beside the words they came from.
 *
 * A proposition is a retrieval key and nothing else. It is folded into the
 * conversation window that gets embedded, so a search for "who agreed to come
 * to the pub" can reach a message that says "yeah I'm going", and it is never
 * shown to anybody: `sourceLine` is here so every surface has the original to
 * display instead.
 *
 * Versioned, because a better prompt makes every previous rewrite obsolete
 * rather than merely older, and a store holding two vintages would embed both
 * into the same window.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "../kernel/db.js";

export interface StoredProposition {
  readonly ordinal: number;
  readonly sourceLine: string;
  readonly text: string;
}

export function savePropositions(
  db: DB,
  episodeId: string,
  propositions: readonly StoredProposition[],
  version: number,
): void {
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM propositions WHERE episode_id = ?`).run(episodeId);

    const insert = db.prepare(
      `INSERT INTO propositions (id, episode_id, ordinal, source_line, text, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const proposition of propositions) {
      insert.run(
        randomUUID(),
        episodeId,
        proposition.ordinal,
        proposition.sourceLine,
        proposition.text,
        version,
        Date.now(),
      );
    }
  });

  write();
}

export function propositionsFor(
  db: DB,
  episodeId: string,
  version: number,
): readonly StoredProposition[] {
  const rows = db
    .prepare(
      `SELECT ordinal, source_line, text FROM propositions
       WHERE episode_id = ? AND version = ? ORDER BY ordinal`,
    )
    .all(episodeId, version) as { ordinal: number; source_line: string; text: string }[];

  return rows.map((row) => ({
    ordinal: row.ordinal,
    sourceLine: row.source_line,
    text: row.text,
  }));
}

/** Episodes a model has not read yet, newest first. */
export function pendingPropositions(
  db: DB,
  version: number,
  limit: number,
): readonly { readonly id: string; readonly transcript: string }[] {
  return db
    .prepare(
      `SELECT e.id AS id, e.transcript AS transcript
       FROM episodes e
       WHERE NOT EXISTS (
         SELECT 1 FROM propositions p
         WHERE p.episode_id = e.id AND p.version = @version
       )
       ORDER BY e.ends_at DESC
       LIMIT @limit`,
    )
    .all({ version, limit }) as { id: string; transcript: string }[];
}

export function countPropositions(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM propositions`).get() as { n: number }).n;
}
