/**
 * Re-segmenting an episode that something already cites.
 *
 * This one stopped a real store dead for four days. `derive` failed on every
 * run with `FOREIGN KEY constraint failed`, three hundred items sat unprocessed
 * behind it, and situations, commitments and observations were all frozen
 * against stale data. Nothing in the error named a table, a column, or a row.
 *
 * The cause: `pruneEpisodes` clears five dependent tables before deleting an
 * episode. `commitment_evidence.episode_id` and `facts.source_episode` were
 * added later and nothing came back to update it. So the moment any commitment
 * or fact cited an episode, that episode could never be re-segmented again, and
 * every derive pass touching it aborted.
 *
 * The shape is worth naming because it will recur: a delete that hand-clears
 * its dependents is correct exactly once, and silently wrong from the next
 * migration onward. The last test here is the guard against that.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pruneEpisodes, saveEpisode } from "./episodes.js";
import { openTestStore } from "../fixtures/harness.js";
import { seedFixture, PRINCIPAL } from "../fixtures/store.js";
import type { DB } from "../kernel/db.js";

function anEpisode(
  db: DB,
): { readonly id: string; readonly stream: string; readonly thread: string } {
  const item = db.prepare(`SELECT id, stream_id FROM items LIMIT 1`).get() as {
    id: string;
    stream_id: string;
  };

  // saveEpisode derives the id from the item ids and ignores any passed in, so
  // the caller has to use what it returns.
  const id = saveEpisode(
    db,
    {
      streamId: item.stream_id,
      threadId: "th_test",
      principalId: PRINCIPAL,
      title: "a conversation",
      transcript: "You: hello\nSomeone: hi",
      participants: ["+15550100001"],
      itemIds: [item.id],
      startsAt: 1,
      endsAt: 2,
    },
    1,
  );

  return { id, stream: item.stream_id, thread: "th_test" };
}

test("pruning an episode that is cited", async (t) => {
  await t.test("a commitment citing it does not block the prune", () => {
    const store = openTestStore();

    try {
      seedFixture(store.db);

      const where = anEpisode(store.db);

      store.db
        .prepare(
          `INSERT INTO commitments (id, principal_id, title, normalized, owner, state,
             confidence, origin, extract_version, first_seen_at, updated_at)
           VALUES ('c_1', ?, 'bring the tart', 'bring the tart', 'me', 'open',
                   0.8, 'derived', 1, 1, 1)`,
        )
        .run(PRINCIPAL);

      store.db
        .prepare(
          `INSERT INTO commitment_evidence (id, commitment_id, episode_id, role, note, occurred_at)
           VALUES ('ce_1', 'c_1', ?, 'stated', 'said so', 1)`,
        )
        .run(where.id);

      // Before the fix this threw FOREIGN KEY constraint failed and took the
      // whole derive pass down with it.
      assert.equal(pruneEpisodes(store.db, where.stream, where.thread, []), 1);

      const evidence = store.db
        .prepare(`SELECT episode_id, item_id FROM commitment_evidence WHERE id = 'ce_1'`)
        .get() as { episode_id: string | null; item_id: string | null };

      // Repointed rather than deleted. The commitment did not stop being true
      // because the conversation was re-segmented.
      assert.equal(evidence.episode_id, null);
      assert.notEqual(evidence.item_id, null, "evidence lost its source entirely");

      const stillReal = store.db
        .prepare(`SELECT COUNT(*) AS n FROM items WHERE id = ?`)
        .get(evidence.item_id) as { n: number };

      assert.equal(stillReal.n, 1, "evidence points at an item that does not exist");
    } finally {
      store.close();
    }
  });

  await t.test("a fact citing it keeps the fact", () => {
    const store = openTestStore();

    try {
      seedFixture(store.db);

      const where = anEpisode(store.db);

      store.db
        .prepare(
          `INSERT INTO facts (id, principal_id, kind, statement, normalized, state, confidence,
             origin, source_episode, first_seen_at, updated_at)
           VALUES ('f_1', ?, 'preference', 'allergic to shellfish', 'allergic to shellfish',
                   'proposed', 0.7, 'derived', ?, 1, 1)`,
        )
        .run(PRINCIPAL, where.id);

      assert.equal(pruneEpisodes(store.db, where.stream, where.thread, []), 1);

      const fact = store.db
        .prepare(`SELECT source_episode, source_item FROM facts WHERE id = 'f_1'`)
        .get() as { source_episode: string | null; source_item: string | null };

      assert.equal(fact.source_episode, null);
      assert.notEqual(fact.source_item, null, "the fact lost its provenance");
    } finally {
      store.close();
    }
  });

  await t.test("an episode nothing cites still prunes cleanly", () => {
    const store = openTestStore();

    try {
      seedFixture(store.db);

      const where = anEpisode(store.db);

      assert.equal(pruneEpisodes(store.db, where.stream, where.thread, []), 1);
      assert.equal(
        (
          store.db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE id = ?`).get(where.id) as {
            n: number;
          }
        ).n,
        0,
      );
    } finally {
      store.close();
    }
  });

  await t.test("every table referencing episodes is handled here", () => {
    // The guard against this recurring. A delete that hand-clears its
    // dependents is correct exactly once and silently wrong from the next
    // migration onward, which is precisely how this bug arrived: two tables
    // gained an episode reference and nobody came back to `pruneEpisodes`.
    //
    // If this fails, a new table references episodes and the prune does not
    // know about it. Add it there, then add it here.
    const store = openTestStore();

    try {
      const referencing = (
        store.db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND sql LIKE '%REFERENCES episodes%'
             ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map((row) => row.name);

      assert.deepEqual(referencing, [
        "commitment_evidence",
        "episode_chunks",
        "episode_items",
        "facts",
        "propositions",
      ]);
    } finally {
      store.close();
    }
  });
});
