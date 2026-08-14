/**
 * Database access.
 *
 * SQLite in WAL mode, one writer, synchronous driver. That combination suits a
 * local daemon better than an async pool does: there is no network, the writes
 * are small, and reasoning about ordering is worth more than concurrency we do
 * not have.
 */
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { ConfigurationError } from "./errors.js";
import Database from "better-sqlite3-multiple-ciphers";
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

/**
 * The store key, resolved once per process.
 *
 * Every reader in Harbor is synchronous and keychain access is not, so the key
 * is fetched at startup by the CLI and daemon and handed here. A process that
 * never called `primeStoreKey` and opens an encrypted store fails loudly on the
 * first read rather than quietly behaving as though the file were corrupt.
 */
let candidates: readonly string[] = [];

/**
 * Every key that might open the store, best guess first.
 *
 * Plural, and the reason is a day worth not repeating. This used to be one key
 * chosen by source, keychain preferred over the environment. A stale keychain
 * entry from an earlier attempt therefore beat the correct key in
 * `HARBOR_STORE_KEY`, and exporting the right value had no effect whatsoever:
 * Harbor confidently used a key it found rather than one that works.
 *
 * A key is not a setting with a precedence order. It either opens the file or
 * it does not, that is cheap to test, so every candidate is tried and the one
 * that works wins.
 */
export function primeStoreKeys(values: readonly string[]): void {
  candidates = values.filter((entry) => entry.length > 0);
}

export function primeStoreKey(value: string | null): void {
  primeStoreKeys(value === null ? [] : [value]);
}

/** Whether a key opens this file. The only test that means anything. */
export function keyOpens(path: string, candidate: string): boolean {
  let probe: ReturnType<typeof Database> | null = null;

  try {
    probe = new Database(path, { readonly: true });
    probe.pragma(`key='${candidate.replace(/'/g, "''")}'`);
    probe.prepare("SELECT count(*) FROM sqlite_schema").get();

    return true;
  } catch {
    return false;
  } finally {
    probe?.close();
  }
}

/**
 * Whether the file on disk is encrypted.
 *
 * SQLite writes a fixed sixteen-byte header and an encrypted database does not
 * have it, because the header is encrypted too. Cheap, synchronous, and it
 * cannot be wrong.
 *
 * This is checked on every open rather than trusting that a key exists only
 * when it should, because getting that backwards has one specific and very
 * confusing symptom: applying a key to a *plaintext* database makes it
 * unreadable, and the driver reports "file is not a database", which reads
 * exactly like corruption. A store that has never been encrypted must never
 * have a key applied to it, whatever some keychain entry happens to say.
 */
function fileIsEncrypted(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }

  const handle = openSync(path, "r");

  try {
    const header = Buffer.alloc(16);
    readSync(handle, header, 0, 16, 0);

    return header.toString("latin1") !== "SQLite format 3\u0000";
  } catch {
    return false;
  } finally {
    closeSync(handle);
  }
}

export function hasStoreKey(): boolean {
  return candidates.length > 0;
}

export function openDatabase(): OpenResult {
  const path = dbPath();
  const encrypted = fileIsEncrypted(path);
  const db = new Database(path);

  // Before any other statement. An encrypted database cannot answer even a
  // pragma until it has been unlocked, and an unencrypted one must not be given
  // a key at all.
  if (encrypted) {
    if (candidates.length === 0) {
      db.close();

      throw new ConfigurationError(
        "The store is encrypted and Harbor has no key for it",
        "Set HARBOR_STORE_KEY to the key you wrote down, or restore a backup. " +
          "There is no recovery without it.",
      );
    }

    const working = candidates.find((candidate) => keyOpens(path, candidate));

    if (working === undefined) {
      db.close();

      throw new ConfigurationError(
        `The store is encrypted and none of the ${String(candidates.length)} keys Harbor has open it`,
        "Set HARBOR_STORE_KEY to the key you wrote down. If a stale keychain entry is in the " +
          "way: security delete-generic-password -s harbor -a store-encryption-key",
      );
    }

    db.pragma(`key='${working.replace(/'/g, "''")}'`);
  }

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
