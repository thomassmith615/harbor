/**
 * Accounts: one authenticated connector instance each.
 *
 * Credentials live in the database for the MVP. This is the one place where
 * that is true, so moving them to the OS keychain later is a change to this
 * file and nothing else.
 *
 * Sync cursors used to live here and no longer do. One Google grant feeds two
 * connectors with two independent resume points, so cursors belong to streams
 * (see store/streams.ts). Migration 003 drops the columns rather than leaving
 * them: two places holding a cursor is how sync silently diverges.
 */
import { DEFAULT_PRINCIPAL } from "./schema.js";
import {
  isReference,
  readSecret,
  referenceFor,
  resolveCredential,
  storeSecret,
} from "../kernel/keychain.js";
import type { DB } from "../kernel/db.js";

export interface OAuthCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds at which the access token stops being valid. */
  readonly expiresAt: number;
  readonly scope: string;
}

export interface Account {
  readonly id: string;
  readonly sourceType: string;
  readonly label: string;
  readonly custodianPersonId: string;
  readonly credentials: OAuthCredentials;
}

interface AccountRow {
  readonly id: string;
  readonly source_type: string;
  readonly label: string;
  readonly custodian_person_id: string;
  readonly credentials: string;
}

/**
 * Secrets read out of the keychain, held for the life of the process.
 *
 * Every account reader in Harbor is synchronous, and keychain access is not.
 * Rather than turn `listAccounts` async and ripple that through every connector
 * and every command, the references are resolved once at startup and cached
 * here. A process that never unlocks the keychain simply has no credentials,
 * which fails visibly at sync time rather than silently producing empty results.
 */
const resolved = new Map<string, string>();

/**
 * Loads every keychain-backed credential into memory.
 *
 * Called once, early. Returns how many it could not read, which is the number
 * `harbor doctor` reports: a credential that has moved to the keychain and
 * cannot be read back is the one failure mode of this design worth surfacing
 * loudly, because the account will look connected and fetch nothing.
 */
export async function warmCredentials(db: DB): Promise<{ loaded: number; missing: number }> {
  const rows = db.prepare(`SELECT id, credentials FROM accounts`).all() as {
    id: string;
    credentials: string;
  }[];

  let loaded = 0;
  let missing = 0;

  for (const row of rows) {
    if (!isReference(row.credentials)) {
      continue;
    }

    const secret = await resolveCredential(row.credentials, row.id);

    if (secret === null) {
      missing += 1;
      continue;
    }

    resolved.set(row.id, secret);
    loaded += 1;
  }

  return { loaded, missing };
}

/** True when this account's secret lives outside the database. */
export function isKeychainBacked(db: DB, id: string): boolean {
  const row = db.prepare(`SELECT credentials FROM accounts WHERE id = ?`).get(id) as
    | { credentials: string }
    | undefined;

  return row !== undefined && isReference(row.credentials);
}

function hydrate(row: AccountRow): Account {
  // A reference resolves from the cache. An unresolved one yields empty
  // credentials rather than throwing, so a locked keychain degrades to "this
  // account cannot sync" instead of taking down every command that happens to
  // list accounts.
  const raw = isReference(row.credentials)
    ? (resolved.get(row.id) ?? "{}")
    : row.credentials;

  return {
    id: row.id,
    sourceType: row.source_type,
    label: row.label,
    custodianPersonId: row.custodian_person_id,
    credentials: JSON.parse(raw) as OAuthCredentials,
  };
}

/**
 * Moves an account's secret into the keychain.
 *
 * Order matters and is deliberate: write to the keychain, read it back to prove
 * it is really there, and only then overwrite the database copy. A failure at
 * any point leaves the credential where it was and the account working.
 */
export async function moveCredentialsToKeychain(
  db: DB,
  id: string,
): Promise<{ moved: boolean; reason: string | null }> {
  const row = db.prepare(`SELECT credentials FROM accounts WHERE id = ?`).get(id) as
    | { credentials: string }
    | undefined;

  if (row === undefined) {
    return { moved: false, reason: "no such account" };
  }

  if (isReference(row.credentials)) {
    return { moved: false, reason: "already in the keychain" };
  }

  const stored = await storeSecret(id, row.credentials);

  if (!stored) {
    return { moved: false, reason: "the keychain would not accept it" };
  }

  const readBack = await readSecret(id);

  if (readBack !== row.credentials) {
    return { moved: false, reason: "wrote it but could not read it back, so nothing was changed" };
  }

  resolved.set(id, row.credentials);
  db.prepare(`UPDATE accounts SET credentials = ? WHERE id = ?`).run(referenceFor(id), id);

  return { moved: true, reason: null };
}

export function accountId(sourceType: string, label: string): string {
  return `${sourceType}:${label}`;
}

export function saveAccount(
  db: DB,
  input: {
    readonly sourceType: string;
    readonly label: string;
    readonly credentials: OAuthCredentials;
    readonly custodianPersonId?: string;
  },
): Account {
  const id = accountId(input.sourceType, input.label);
  const custodian = input.custodianPersonId ?? DEFAULT_PRINCIPAL;

  db.prepare(
    `INSERT INTO accounts (id, source_type, label, custodian_person_id, credentials, created_at)
     VALUES (@id, @sourceType, @label, @custodian, @credentials, @now)
     ON CONFLICT (id) DO UPDATE SET
       credentials = excluded.credentials,
       custodian_person_id = excluded.custodian_person_id`,
  ).run({
    id,
    sourceType: input.sourceType,
    label: input.label,
    custodian,
    credentials: JSON.stringify(input.credentials),
    now: Date.now(),
  });

  const account = getAccount(db, id);
  if (account === null) {
    throw new Error(`Account ${id} vanished immediately after being written`);
  }
  return account;
}

/**
 * Rewrites an account's credentials, keeping them wherever they already live.
 *
 * This is the path an OAuth refresh takes, so it runs often and unattended. An
 * account that has been moved to the keychain must not silently fall back to the
 * database on its first token refresh, which is exactly what a naive
 * implementation would do.
 */
export function updateCredentials(db: DB, id: string, credentials: OAuthCredentials): void {
  const serialized = JSON.stringify(credentials);

  if (isKeychainBacked(db, id)) {
    resolved.set(id, serialized);

    // Fire and forget: a refreshed token that fails to reach the keychain still
    // works for this process, and the next startup will report it missing.
    void storeSecret(id, serialized);
    return;
  }

  db.prepare(`UPDATE accounts SET credentials = ? WHERE id = ?`).run(serialized, id);
}

export function getAccount(db: DB, id: string): Account | null {
  const row = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
  return row === undefined ? null : hydrate(row);
}

export function listAccounts(db: DB, sourceType?: string): readonly Account[] {
  const rows =
    sourceType === undefined
      ? (db.prepare(`SELECT * FROM accounts ORDER BY id`).all() as AccountRow[])
      : (db
          .prepare(`SELECT * FROM accounts WHERE source_type = ? ORDER BY id`)
          .all(sourceType) as AccountRow[]);

  return rows.map(hydrate);
}
