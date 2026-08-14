/**
 * Encryption at rest.
 *
 * The gap `harbor doctor` has been restating every run since M4, deferred three
 * times, and the largest distance between what the mandate says and what the
 * code does. Credentials went to the keychain and backups were encrypted, and
 * the store itself, 264 MB holding a decade of message bodies, every contact,
 * and everything derived from them, sat in a plain file. A 0700 directory
 * defends against another user on the same machine and against nothing else:
 * not a stolen laptop, not a Time Machine volume, not a backup that syncs
 * somewhere.
 *
 * ## What this does and does not buy
 *
 * Encrypted at rest means the file is unreadable without the key. It does not
 * mean the data is unreadable while Harbor is running: the daemon holds the key
 * and anything that can read that process can read the store. This defends
 * against the file being taken, which is the realistic threat for a machine
 * sitting in a closet.
 *
 * The key lives in the operating system keychain, same as the credentials. That
 * has a consequence worth stating plainly rather than discovering later: **lose
 * the keychain entry and the store is gone.** There is no recovery, by design,
 * because a recoverable encryption key is a second copy of the key. `harbor
 * settings encryption` prints the key so it can be written down, and the
 * command exists precisely because the alternative is somebody finding out
 * during a disk failure.
 *
 * ## Why this driver
 *
 * `better-sqlite3-multiple-ciphers` is the same library with a cipher layer
 * compiled in, ships prebuilds for the platforms Harbor runs on, and keeps
 * FTS5, WAL, and loadable extensions working, which matters because retrieval
 * depends on all three. Verified end to end before this was written: rekey in
 * place, then full text search and the sqlite-vec index both still function and
 * the file returns SQLITE_NOTADB without the key.
 *
 * ## Why rekey rather than export
 *
 * Rekeying rewrites every page of the existing file. Exporting would mean a
 * second complete copy of the store on disk, in the clear, for the duration,
 * which is a strange way to improve the security of a file. The driver refuses
 * to rekey a database in WAL mode, so the migration drops to rollback
 * journalling, rekeys, and restores WAL afterwards.
 */
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dbPath, harborHome } from "./paths.js";
import { join } from "node:path";
import { detectKeychain, readSecret, storeSecret } from "./keychain.js";
import { ConfigurationError } from "./errors.js";

/** The keychain account the store key is filed under. */
export const KEY_ACCOUNT = "store-encryption-key";

/**
 * Whether a file on disk is an encrypted store.
 *
 * SQLite writes a fixed sixteen-byte header. An encrypted database does not
 * have it, because the header is encrypted too, which makes this the cheapest
 * and most reliable test there is.
 */
export async function isEncrypted(path: string = dbPath()): Promise<boolean> {
  if (!existsSync(path)) {
    return false;
  }

  const { open } = await import("node:fs/promises");

  const handle = await open(path, "r");

  try {
    const buffer = Buffer.alloc(16);
    await handle.read(buffer, 0, 16, 0);

    return buffer.toString("latin1") !== "SQLite format 3\u0000";
  } finally {
    await handle.close();
  }
}

/** A new key. 32 bytes of randomness, hex encoded so it can be written down. */
export function generateKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The key, if there is one.
 *
 * Read from the keychain, then from `HARBOR_STORE_KEY` for headless machines
 * with no keychain at all. The environment variable is second on purpose: a key
 * in a shell profile is a key in a file, and it should be the fallback rather
 * than the path of least resistance.
 */
export type KeySource = "keychain" | "environment" | "none";

export async function storeKeyWithSource(): Promise<{
  readonly key: string | null;
  readonly source: KeySource;
}> {
  const fromKeychain = await readSecret(KEY_ACCOUNT);

  if (fromKeychain !== null) {
    return { key: fromKeychain, source: "keychain" };
  }

  const fromEnv = process.env["HARBOR_STORE_KEY"];

  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { key: fromEnv, source: "environment" };
  }

  return { key: null, source: "none" };
}

export async function storeKey(): Promise<string | null> {
  return (await storeKeyWithSource()).key;
}

/**
 * Every key worth trying, best guess first.
 *
 * The environment goes first because it is what somebody reaches for when the
 * keychain is wrong, and a person setting `HARBOR_STORE_KEY` by hand is making
 * a deliberate statement that should not lose to a stale entry they cannot see.
 * Both are tried regardless; the store decides.
 */
export async function storeKeyCandidates(): Promise<readonly string[]> {
  const found: string[] = [];

  const fromEnv = process.env["HARBOR_STORE_KEY"];

  if (fromEnv !== undefined && fromEnv.length > 0) {
    found.push(fromEnv.trim());
  }

  const fromKeychain = await readSecret(KEY_ACCOUNT);

  if (fromKeychain !== null && !found.includes(fromKeychain)) {
    found.push(fromKeychain);
  }

  return found;
}

export async function saveKey(key: string): Promise<boolean> {
  return await storeSecret(KEY_ACCOUNT, key);
}

export interface EncryptReport {
  readonly key: string;
  readonly keychain: boolean;
  readonly bytes: number;
  readonly durationMs: number;
}

/**
 * Encrypts an existing plaintext store in place.
 *
 * A copy is taken first and removed only once the rekeyed file has been
 * reopened and read successfully. Rewriting every page of the one file holding
 * someone's entire correspondence is not an operation to attempt without a way
 * back.
 */
export async function encryptStore(
  options: { readonly onNote?: (message: string) => void } = {},
): Promise<EncryptReport> {
  const started = Date.now();
  const path = dbPath();

  if (!existsSync(path)) {
    throw new ConfigurationError(
      "There is no store to encrypt",
      "Run `harbor init` first.",
    );
  }

  if (await isEncrypted(path)) {
    throw new ConfigurationError(
      "The store is already encrypted",
      "`harbor settings encryption` shows its key.",
    );
  }

  const { default: Database } = await import("better-sqlite3-multiple-ciphers");
  const { statSync, copyFileSync } = await import("node:fs");

  const key = generateKey();
  const backup = join(harborHome(), "harbor.db.pre-encryption");

  options.onNote?.("copying the store before touching it");
  copyFileSync(path, backup);

  const bytes = statSync(path).size;

  try {
    const db = new Database(path);

    // The driver refuses to rekey in WAL mode. Dropping to rollback journalling
    // checkpoints and removes the -wal file, which also means the plaintext
    // pages sitting in that file go away rather than being left behind next to
    // an encrypted database.
    db.pragma("journal_mode = DELETE");

    options.onNote?.("rewriting every page, which takes a while on a large store");
    db.pragma(`rekey='${key}'`);
    db.close();

    // Reopen and read something before believing it worked.
    const check = new Database(path);
    check.pragma(`key='${key}'`);
    check.pragma("journal_mode = WAL");
    check.prepare("SELECT COUNT(*) AS n FROM items").get();
    check.close();
  } catch (error: unknown) {
    options.onNote?.("that failed; putting the original back");
    renameSync(backup, path);

    throw error;
  }

  // Store it, then read it back and compare.
  //
  // The first version reported "the key is in your keychain" on the strength of
  // the store command not throwing. It had not thrown and the key was not
  // there: an entry from an earlier attempt survived the delete, so lookups
  // returned the wrong value and the store could not be opened by the only
  // process that knew better. For the one secret in the system with no recovery
  // path, an assumed write is not a write.
  let keychain = false;

  if ((await detectKeychain()) !== "none") {
    keychain = (await saveKey(key)) && (await readSecret(KEY_ACCOUNT)) === key;

    if (!keychain) {
      options.onNote?.(
        "the keychain did not accept the key, so you must keep it yourself",
      );
    }
  }

  // The copy is plaintext, so it does not get to outlive the migration.
  rmSync(backup, { force: true });

  return { key, keychain, bytes, durationMs: Date.now() - started };
}

/**
 * Whether the keychain holds a key that actually opens the store.
 *
 * The question `install-service` needs answered, because a service manager gets
 * the keychain and nothing else. Telling somebody a service is installed when
 * it cannot possibly start is worse than not writing the file at all.
 */
export async function keychainKeyOpensStore(): Promise<boolean> {
  const { keyOpens } = await import("./db.js");
  const fromKeychain = await readSecret(KEY_ACCOUNT);

  return fromKeychain !== null && keyOpens(dbPath(), fromKeychain);
}
