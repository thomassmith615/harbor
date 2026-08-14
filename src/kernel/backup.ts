/**
 * Backup.
 *
 * `VACUUM INTO` rather than copying the file: it takes a consistent snapshot
 * while the database is open and in WAL mode, which a `cp` does not. Copying
 * `harbor.db` without its `-wal` sidecar produces a file that opens fine and is
 * quietly missing the most recent writes, which is the worst possible failure
 * mode for a backup.
 *
 * The output is a plain SQLite file. Restoring is copying it back over
 * `harbor.db` with Harbor not running.
 *
 * Or it is an encrypted one. A backup is the copy of Harbor most likely to end
 * up somewhere Harbor does not control: another disk, a cloud folder, a Time
 * Machine volume. An unencrypted snapshot of a store holding a decade of
 * messages, most of them written by people who never agreed to any of this, is
 * the single easiest way for this project to hurt somebody. So encryption is
 * available, it is one flag, and the plain form now says out loud what it is.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { harborHome } from "./paths.js";
import type { DB } from "./db.js";

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly durationMs: number;
}

function timestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function defaultBackupPath(now: number = Date.now()): string {
  return join(harborHome(), "backups", `harbor-${timestamp(now)}.db`);
}

export function backup(db: DB, target?: string): BackupResult {
  const path = target ?? defaultBackupPath();
  const started = Date.now();

  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  if (existsSync(path)) {
    throw new Error(`${path} already exists. VACUUM INTO will not overwrite.`);
  }

  // Escaped for the SQL string literal; the path comes from the CLI, not a model.
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

  return {
    path,
    bytes: statSync(path).size,
    durationMs: Date.now() - started,
  };
}


// ---- encryption ----

/**
 * The format, written down because a backup nobody can open is not a backup.
 *
 *   magic    8 bytes   "HARBOR01"
 *   salt     16 bytes  for the key derivation
 *   iv       12 bytes  for AES-GCM
 *   tag      16 bytes  the authentication tag
 *   body     the rest  AES-256-GCM ciphertext of the SQLite file
 *
 * AES-256-GCM with a scrypt-derived key. Authenticated, so a corrupted or
 * tampered backup fails to decrypt rather than restoring quietly wrong data,
 * which for a file that only gets opened on the worst day of somebody's year is
 * the property that matters most.
 */
const MAGIC = Buffer.from("HARBOR01", "utf8");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * scrypt parameters.
 *
 * N=2^15 costs roughly a tenth of a second and 32 MB. Deliberately slow: the
 * passphrase is the only thing between a stolen backup file and its contents,
 * and people choose passphrases that a fast hash makes guessable.
 */
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 };

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

export interface EncryptedBackupResult extends BackupResult {
  readonly encrypted: true;
}

/**
 * Takes a snapshot and encrypts it, leaving no plaintext behind.
 *
 * The intermediate plain file is unavoidable: `VACUUM INTO` writes to a path.
 * It is written inside the Harbor home, which is 0700, and removed as soon as
 * the ciphertext is durable. If encryption throws, the plaintext is still
 * removed, because a failed encrypted backup must not silently become an
 * unencrypted one sitting on disk.
 */
export function encryptedBackup(db: DB, passphrase: string, target?: string): EncryptedBackupResult {
  if (passphrase.length < 8) {
    throw new Error("A backup passphrase needs to be at least 8 characters.");
  }

  const finalPath = target ?? `${defaultBackupPath()}.enc`;
  const scratch = `${finalPath}.plain`;
  const started = Date.now();

  const directory = dirname(finalPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  if (existsSync(finalPath)) {
    throw new Error(`${finalPath} already exists.`);
  }

  try {
    db.exec(`VACUUM INTO '${scratch.replace(/'/g, "''")}'`);

    const plain = readFileSync(scratch);
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);

    writeFileSync(finalPath, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]), {
      mode: 0o600,
    });
  } finally {
    if (existsSync(scratch)) {
      rmSync(scratch, { force: true });
    }
  }

  return {
    path: finalPath,
    bytes: statSync(finalPath).size,
    durationMs: Date.now() - started,
    encrypted: true,
  };
}

export function restoreBackup(source: string, passphrase: string, target: string): number {
  const raw = readFileSync(source);

  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`${source} is not an encrypted Harbor backup.`);
  }

  let offset = MAGIC.length;
  const salt = raw.subarray(offset, (offset += SALT_BYTES));
  const iv = raw.subarray(offset, (offset += IV_BYTES));
  const tag = raw.subarray(offset, (offset += TAG_BYTES));
  const body = raw.subarray(offset);

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  let plain: Buffer;

  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Authentication failure. Either the passphrase is wrong or the file was
    // altered, and there is no way to tell which, which is the point.
    throw new Error("Could not decrypt. Wrong passphrase, or the file has been altered.");
  }

  if (existsSync(target)) {
    throw new Error(`${target} already exists. Move it aside first.`);
  }

  writeFileSync(target, plain, { mode: 0o600 });

  return plain.length;
}
