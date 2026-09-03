/**
 * Rebuilding a table that other tables point at.
 *
 * This exists because I did it wrong, in a codebase that already had the
 * warning written down. The stories rebuild migration carries a long comment
 * explaining that `PRAGMA foreign_keys` is a no-op inside a transaction, that
 * every migration here runs in one, and that `defer_foreign_keys` does not help
 * either. I wrote `PRAGMA foreign_keys = OFF` at the top of the entities
 * rebuild anyway, and it failed on every store that had an entity in it.
 *
 * It passed the existing tests because a fresh store has no entities, no
 * identifiers and no item_entities, so nothing referenced the table being
 * dropped and nothing could violate a constraint. The gap is not that the case
 * was hard: it is that the only fixture was empty, and an empty fixture cannot
 * fail this class of bug. So this seeds the graph first and then migrates,
 * which is what an upgrade actually is.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import Database from "better-sqlite3-multiple-ciphers";
import { MIGRATIONS } from "./schema.js";

/** The migration that rebuilds entities, found by what it does. */
const REBUILD = MIGRATIONS.findIndex((migration) => migration.includes("entities_new"));

function upTo(index: number): Database.Database {
  const db = new Database(":memory:");

  db.pragma("foreign_keys = ON");

  for (let step = 0; step < index; step += 1) {
    const sql = MIGRATIONS[step];

    if (sql !== undefined) {
      db.exec(sql);
    }
  }

  return db;
}

/** An entity graph with one of every kind of child hanging off it. */
function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO entities (id, kind, display_name, pinned, merged_into, created_at, updated_at)
    VALUES ('e_1', 'person', 'Dave Mullen', 0, NULL, 0, 0),
           ('e_2', 'person', 'Dave M', 0, 'e_1', 0, 0),
           ('e_3', 'self', 'Thomas', 1, NULL, 0, 0);

    INSERT INTO identifiers (id, entity_id, kind, value, normalized, confidence, occurrences, first_seen, last_seen)
    VALUES ('i1', 'e_1', 'name', 'Dave Mullen', 'dave mullen', 0.9, 1, 0, 0),
           ('i2', 'e_1', 'email', 'd@x.com', 'd@x.com', 0.9, 1, 0, 0);

    INSERT INTO entity_aliases (entity_id, alias, normalized, origin, created_at)
    VALUES ('e_1', 'Davey', 'davey', 'test', 0);

    INSERT INTO accounts (id, source_type, label, custodian_person_id, credentials, created_at, weight)
    VALUES ('a1', 'imap', 'x', 'person:me', '{}', 0, 1);

    INSERT INTO streams (id, account_id, connector_id, created_at, recent_done, historical_done)
    VALUES ('s1', 'a1', 'imap', 0, 0, 0);

    INSERT INTO items (id, account_id, stream_id, external_id, kind, occurred_at, ingested_at,
                       content_hash, raw, visibility, raw_encoding)
    VALUES ('it1', 'a1', 's1', 'x1', 'message', 0, 0, 'h', '{}', 'private', 'json');

    INSERT INTO item_entities (item_id, entity_id, role) VALUES ('it1', 'e_1', 'author');
  `);
}

function applyRest(db: Database.Database): void {
  for (let step = REBUILD; step < MIGRATIONS.length; step += 1) {
    const sql = MIGRATIONS[step];

    if (sql === undefined) {
      continue;
    }

    db.exec("BEGIN");

    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");

      throw new Error(
        `migration ${String(step)} failed on a populated store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("migrating a store that already has people in it", () => {
  test("the rebuild runs with foreign keys on, as it does in production", () => {
    const db = upTo(REBUILD);

    try {
      seed(db);
      applyRest(db);
    } finally {
      db.close();
    }
  });

  test("every child row survives", () => {
    const db = upTo(REBUILD);

    try {
      seed(db);
      applyRest(db);

      assert.equal(count(db, "entities"), 3);
      assert.equal(count(db, "identifiers"), 2);
      assert.equal(count(db, "item_entities"), 1, "the child that broke it");
      assert.equal(count(db, "entity_aliases"), 1);
    } finally {
      db.close();
    }
  });

  test("a merge pointer still points at what it pointed at", () => {
    const db = upTo(REBUILD);

    try {
      seed(db);
      applyRest(db);

      const row = db.prepare(`SELECT merged_into FROM entities WHERE id = 'e_2'`).get() as {
        merged_into: string | null;
      };

      // The self-reference is the part most likely to break silently: it points
      // at a table that is dropped and recreated under a different name.
      assert.equal(row.merged_into, "e_1");
    } finally {
      db.close();
    }
  });

  test("nothing is left dangling", () => {
    const db = upTo(REBUILD);

    try {
      seed(db);
      applyRest(db);

      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }
  });

  test("and the constraints that were the point of the rebuild are in place", () => {
    const db = upTo(REBUILD);

    try {
      seed(db);
      applyRest(db);

      db.exec(
        `INSERT INTO entities (id, kind, display_name, pinned, merged_into, created_at, updated_at)
         VALUES ('e_4', 'place', 'Great American Pub', 0, NULL, 0, 0)`,
      );

      db.exec(
        `INSERT INTO identifiers (id, entity_id, kind, value, normalized, confidence, occurrences, first_seen, last_seen)
         VALUES ('i3', 'e_1', 'phone', '610-555-0182', '+16105550182', 0.9, 1, 0, 0)`,
      );

      assert.equal(count(db, "entities"), 4);
      assert.equal(count(db, "identifiers"), 3);
    } finally {
      db.close();
    }
  });
});
