#!/usr/bin/env node
/**
 * Find the foreign key violation that is failing derive.
 *
 *   node scripts/fk-check.mjs
 *
 * Read only. Writes nothing, sends nothing.
 *
 * `FOREIGN KEY constraint failed` is SQLite's entire vocabulary for this: no
 * table, no column, no row. So this asks two different questions, because they
 * have different answers.
 *
 * `PRAGMA foreign_key_check` finds violations that are *already stored*. It
 * will come back clean if the failing insert was rolled back, which it will
 * have been, so a clean result here does not mean nothing is wrong.
 *
 * The orphan queries below are the useful half. They look for rows whose parent
 * has gone missing, which is what an insert would collide with: a derived row
 * pointing at an item, episode, or person that no longer exists.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const root = join(process.cwd(), "dist");

const { openDatabase, primeStoreKeys } = await import(join(root, "kernel/db.js"));
const { storeKeyCandidates } = await import(join(root, "kernel/encryption.js"));

primeStoreKeys(await storeKeyCandidates());

const { db } = openDatabase();

try {
  console.log("=== stored violations (PRAGMA foreign_key_check) ===");

  const stored = db.prepare(`PRAGMA foreign_key_check`).all();

  if (stored.length === 0) {
    console.log("  none. The failing insert was rolled back, as expected.");
  } else {
    for (const row of stored.slice(0, 40)) {
      console.log(`  ${row.table} row ${String(row.rowid)} -> ${row.parent}`);
    }
    console.log(`  ${String(stored.length)} total`);
  }

  console.log("");
  console.log("=== orphans: derived rows whose parent is gone ===");

  // Every foreign key a derive pass writes across. A non-zero count here is the
  // violation, and the pair of tables tells you which insert is failing.
  const checks = [
    ["chunks -> items", `SELECT COUNT(*) AS n FROM chunks c LEFT JOIN items i ON i.id = c.item_id WHERE i.id IS NULL`],
    ["episode_items -> items", `SELECT COUNT(*) AS n FROM episode_items e LEFT JOIN items i ON i.id = e.item_id WHERE i.id IS NULL`],
    ["episode_items -> episodes", `SELECT COUNT(*) AS n FROM episode_items e LEFT JOIN episodes p ON p.id = e.episode_id WHERE p.id IS NULL`],
    ["episodes -> people", `SELECT COUNT(*) AS n FROM episodes e LEFT JOIN people p ON p.id = e.principal_id WHERE p.id IS NULL`],
    ["item_entities -> items", `SELECT COUNT(*) AS n FROM item_entities x LEFT JOIN items i ON i.id = x.item_id WHERE i.id IS NULL`],
    ["item_entities -> entities", `SELECT COUNT(*) AS n FROM item_entities x LEFT JOIN entities e ON e.id = x.entity_id WHERE e.id IS NULL`],
    ["thread_nodes -> threads", `SELECT COUNT(*) AS n FROM thread_nodes t LEFT JOIN threads h ON h.id = t.thread_id WHERE h.id IS NULL`],
    ["projections -> items", `SELECT COUNT(*) AS n FROM projections p LEFT JOIN items i ON i.id = p.item_id WHERE i.id IS NULL`],
  ];

  for (const [label, sql] of checks) {
    try {
      const n = db.prepare(sql).get().n;
      console.log(`  ${String(n).padStart(7)}  ${label}${n > 0 ? "   <-- violation" : ""}`);
    } catch (error) {
      console.log(`      err  ${label}: ${String(error).slice(0, 70)}`);
    }
  }

  // The other shape this takes: a stream or account row referenced by items
  // that no longer exists. The files connector was pulled out; if anything
  // cascaded, this is where it shows.
  console.log("");
  console.log("=== items by source, and whether their account still exists ===");

  try {
    const rows = db
      .prepare(
        `SELECT s.connector_id AS source, COUNT(*) AS n,
                SUM(CASE WHEN a.id IS NULL THEN 1 ELSE 0 END) AS orphaned
         FROM items i
         JOIN streams s ON s.id = i.stream_id
         LEFT JOIN accounts a ON a.id = s.account_id
         GROUP BY 1 ORDER BY n DESC`,
      )
      .all();

    for (const row of rows) {
      console.log(
        `  ${String(row.n).padStart(7)}  ${String(row.source).padEnd(18)}` +
          `${row.orphaned > 0 ? `  ${String(row.orphaned)} with no account   <-- violation` : ""}`,
      );
    }
  } catch (error) {
    console.log(`  unavailable: ${String(error).slice(0, 80)}`);
  }

  console.log("");
  console.log("=== what derive is about to touch ===");

  try {
    const pending = db
      .prepare(
        `SELECT i.kind, COUNT(*) AS n, MIN(i.occurred_at) AS oldest, MAX(i.occurred_at) AS newest
         FROM items i
         WHERE i.deleted_at IS NULL AND i.derived_version IS NULL
         GROUP BY 1 ORDER BY n DESC LIMIT 8`,
      )
      .all();

    if (pending.length === 0) {
      console.log("  nothing pending");
    }

    for (const row of pending) {
      console.log(
        `  ${String(row.n).padStart(7)}  ${String(row.kind).padEnd(14)}` +
          ` ${new Date(row.oldest).toISOString().slice(0, 10)} to ${new Date(row.newest).toISOString().slice(0, 10)}`,
      );
    }
  } catch {
    console.log("  (skipped)");
  }
} finally {
  db.close();
}

void require;
void homedir;
