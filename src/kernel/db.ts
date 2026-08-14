/**
 * Database access.
 *
 * SQLite in WAL mode, one writer, synchronous driver. That combination suits a
 * local daemon better than an async pool does: there is no network, the writes
 * are small, and reasoning about ordering is worth more than concurrency we do
 * not have.
 */
import Database from "better-sqlite3";
import { MIGRATIONS } from "../store/schema.js";
import { dbPath } from "./paths.js";
import { seedBuiltinRules } from "../policy/rules.js";
import { reapOrphans } from "../store/jobs.js";
import { purgeExpired } from "../store/pairing.js";
import { purgeExpiredFlows } from "../connectors/google/remote-auth.js";

export type DB = Database.Database;

function migrate(db: DB): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  let applied = 0;

  for (let index = current; index < MIGRATIONS.length; index += 1) {
    const sql = MIGRATIONS[index];
    if (sql === undefined) {
      continue;
    }

    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.pragma(`user_version = ${String(index + 1)}`);
      db.exec("COMMIT");
      applied += 1;
    } catch (error: unknown) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return applied;
}

export interface OpenResult {
  readonly db: DB;
  /** How many migrations this call ran. Zero on a healthy existing install. */
  readonly migrationsApplied: number;
  /** Built-in policy rules written. Non-zero means the gate was unconfigured. */
  readonly rulesSeeded: number;
  /** Jobs found mid-flight from a previous process. */
  readonly orphanedJobs: number;
}

export function openDatabase(): OpenResult {
  const db = new Database(dbPath());

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Thirty seconds, not five.
  //
  // Two processes on one database is normal here: a daemon serving requests
  // while a job derives. Five seconds is shorter than a legitimate write batch,
  // so a reader would give up on work that was about to finish anyway. Waiting
  // is almost always better than failing.
  db.pragma("busy_timeout = 30000");

  const migrationsApplied = migrate(db);

  // Seeded on every open, not only in `init`.
  //
  // A database that predates migration 007 has the policy table and no rules,
  // and zero rules means `evaluate` falls through to its implicit deny, which
  // withholds every item from every model call. The symptom is retrieval
  // returning nothing for no visible reason, which is the exact failure mode
  // the policy layer was supposed to prevent rather than cause. Seeding is
  // idempotent, so doing it here costs one no-op statement per open.
  const seeded = seedBuiltinRules(db);

  // Expired short-lived secrets, on every open.
  //
  // Pairing codes and half-finished OAuth flows both have a TTL and both were
  // being written and never swept. Neither is usable once expired, so keeping
  // them is pure accumulation, and the sweep is two indexed deletes.
  try {
    purgeExpired(db);
    purgeExpiredFlows(db);
  } catch {
    // A brand new database may not have these tables yet. Housekeeping must
    // never be the reason an open fails.
  }

  // Anything left `running` belonged to a process that died. The underlying
  // passes are resumable, so recording the interruption and letting them be
  // re-run beats leaving a task blocked forever behind a phantom job.
  const orphans = reapOrphans(db);

  return { db, migrationsApplied, rulesSeeded: seeded, orphanedJobs: orphans };
}
