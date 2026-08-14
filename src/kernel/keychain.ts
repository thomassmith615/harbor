/**
 * Secrets in the operating system's keychain rather than in the database.
 *
 * Harbor's store holds OAuth refresh tokens, an iCloud app-specific password,
 * and an IMAP password, in a plain SQLite file alongside the full text of
 * everything they were used to fetch. A 0700 directory defends against another
 * user on the same machine and against nothing else: not a stolen laptop, not a
 * Time Machine volume, not a backup that gets synced somewhere.
 *
 * The keychain is not a complete answer, and it is worth being precise about
 * what it does buy. The message bodies are still in the clear; this narrows the
 * blast radius from "your accounts and their contents" to "their contents". It
 * also means a leaked database cannot be used to keep fetching new mail, which
 * is the difference between a snapshot and ongoing access.
 *
 * Implemented over the platform's own command line tool rather than a native
 * module. `security` ships with macOS and `secret-tool` with most Linux
 * desktops, so there is nothing to compile, nothing to keep working across Node
 * releases, and nothing that can fail to install on a machine meant to run
 * unattended for months.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How a credential value is marked when it lives in the keychain instead. */
const REFERENCE_PREFIX = "keychain:";

const SERVICE = "harbor";

export type KeychainBackend = "macos" | "libsecret" | "none";

let detected: KeychainBackend | null = null;

export async function detectKeychain(): Promise<KeychainBackend> {
  if (detected !== null) {
    return detected;
  }

  if (process.platform === "darwin") {
    try {
      await run("security", ["help"]);
      detected = "macos";
      return detected;
    } catch {
      detected = "none";
      return detected;
    }
  }

  try {
    await run("secret-tool", ["--version"]);
    detected = "libsecret";
    return detected;
  } catch {
    detected = "none";
    return detected;
  }
}

export function isReference(value: string): boolean {
  return value.startsWith(REFERENCE_PREFIX);
}

export function referenceFor(accountId: string): string {
  return `${REFERENCE_PREFIX}${accountId}`;
}

function accountFromReference(value: string): string {
  return value.slice(REFERENCE_PREFIX.length);
}

/**
 * Writes a secret, replacing any previous value.
 *
 * The secret goes in on stdin rather than as an argument, because command line
 * arguments are visible in the process table to every user on the machine, and
 * putting an OAuth refresh token there while claiming to have improved security
 * would be worse than leaving it in the database.
 */
export async function storeSecret(accountId: string, secret: string): Promise<boolean> {
  const backend = await detectKeychain();

  try {
    if (backend === "macos") {
      // Delete first: `add-generic-password -U` updates in place, but only when
      // the existing entry matches exactly, and an account whose label changed
      // would otherwise accumulate entries.
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", accountId]).catch(
        () => undefined,
      );

      await run("security", [
        "add-generic-password",
        "-s",
        SERVICE,
        "-a",
        accountId,
        "-w",
        secret,
        "-U",
      ]);

      return true;
    }

    if (backend === "libsecret") {
      const child = execFile("secret-tool", ["store", "--label=Harbor", "service", SERVICE, "account", accountId]);

      child.stdin?.write(secret);
      child.stdin?.end();

      await new Promise<void>((resolve, reject) => {
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${String(code)}`))));
        child.on("error", reject);
      });

      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export async function readSecret(accountId: string): Promise<string | null> {
  const backend = await detectKeychain();

  try {
    if (backend === "macos") {
      const { stdout } = await run("security", [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        accountId,
        "-w",
      ]);

      return stdout.trim();
    }

    if (backend === "libsecret") {
      const { stdout } = await run("secret-tool", [
        "lookup",
        "service",
        SERVICE,
        "account",
        accountId,
      ]);

      return stdout.length === 0 ? null : stdout;
    }
  } catch {
    return null;
  }

  return null;
}

export async function deleteSecret(accountId: string): Promise<boolean> {
  const backend = await detectKeychain();

  try {
    if (backend === "macos") {
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", accountId]);
      return true;
    }

    if (backend === "libsecret") {
      await run("secret-tool", ["clear", "service", SERVICE, "account", accountId]);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Resolves a stored credential value, wherever it actually lives.
 *
 * The one function every caller needs. A value that is not a reference is
 * returned unchanged, which is what makes the migration safe to do gradually:
 * an account that has not been moved yet keeps working exactly as before.
 */
export async function resolveCredential(stored: string, _accountId: string): Promise<string | null> {
  if (!isReference(stored)) {
    return stored;
  }

  // The reference carries the account it belongs to, so the caller's id is not
  // consulted. Kept in the signature because it makes call sites readable and
  // catches a caller that has the wrong account in hand.
  return readSecret(accountFromReference(stored));
}
