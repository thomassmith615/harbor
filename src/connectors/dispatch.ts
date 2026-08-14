/**
 * Source dispatch.
 *
 * Given an account, work out how to authenticate it and run every connector
 * registered for its source type. The two auth strategies live here so that
 * neither the engine nor the connectors have to know there is more than one.
 *
 * Adding a source type is a case in `credentialFor` and a line in the registry.
 */
import { accessToken } from "./google/oauth.js";
import { syncStream } from "./engine.js";
import { connectorsFor } from "./registry.js";
import type { DB } from "../kernel/db.js";
import type { Account } from "../store/accounts.js";
import type { EngineOptions, StreamReport, SyncMode } from "./engine.js";

export interface Credential {
  readonly token: string;
  readonly scheme: "Bearer" | "Basic";
}

export async function credentialFor(db: DB, account: Account): Promise<Credential> {
  if (account.sourceType === "google") {
    // Refreshed on demand; the connectors never see an expired token.
    return { token: await accessToken(db, account), scheme: "Bearer" };
  }

  if (account.sourceType === "imap") {
    // Host, port, user, and password packed into the one opaque token the
    // connector interface carries. Widening the interface for a single source
    // would have been the wrong trade.
    return { token: account.credentials.accessToken, scheme: "Basic" };
  }

  if (account.sourceType === "imessage") {
    // A file on this machine. There is nothing to authenticate against, and
    // pretending otherwise would mean inventing a credential to satisfy a
    // signature. The permission that matters is Full Disk Access, granted in
    // System Settings rather than held by Harbor.
    return { token: "", scheme: "Basic" };
  }

  if (account.sourceType === "apple") {
    // DAV Basic auth. The stored credential is already the base64 payload, so
    // nothing has to reconstruct it from a password sitting in memory.
    return { token: account.credentials.accessToken, scheme: "Basic" };
  }

  throw new Error(`No credential strategy for source type ${account.sourceType}`);
}

export interface AccountSyncOptions extends EngineOptions {
  /** Restrict to one connector, by id. */
  readonly only?: string | undefined;
  /** Restrict to specific streams, by id. Used by the background history fill. */
  readonly onlyStreams?: ReadonlySet<string> | undefined;
}

export async function syncAccount(
  db: DB,
  account: Account,
  mode: SyncMode,
  options: AccountSyncOptions,
): Promise<readonly StreamReport[]> {
  const credential = await credentialFor(db, account);

  const connectors = connectorsFor(account.sourceType).filter(
    (connector) =>
      (options.only === undefined || connector.id === options.only) &&
      (options.onlyStreams === undefined ||
        options.onlyStreams.has(`${account.id}/${connector.id}`)),
  );

  const reports: StreamReport[] = [];

  // Sequential. Connectors under one account share a quota budget and one
  // SQLite writer, so running them at once buys nothing and makes progress
  // output unreadable.
  for (const connector of connectors) {
    reports.push(
      await syncStream(
        db,
        connector,
        account.id,
        credential.token,
        mode,
        options,
        credential.scheme,
      ),
    );
  }

  return reports;
}
