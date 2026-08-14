/**
 * Where Harbor keeps its state, and how it finds its secrets.
 *
 * Everything lives under one directory so that the whole install is one thing
 * to back up. The store is the product; if this directory is gone, Harbor is
 * gone, and the ability to say that in one sentence is worth the constraint.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Root of all Harbor state. Override with HARBOR_HOME. */
export function harborHome(): string {
  const dir = process.env["HARBOR_HOME"] ?? join(homedir(), ".harbor");
  const absolute = resolve(dir);

  if (!existsSync(absolute)) {
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }

  return absolute;
}

export function dbPath(): string {
  return join(harborHome(), "harbor.db");
}

/** Content-addressed blob directory. Unused in the MVP, created for shape. */
export function blobDir(): string {
  const dir = join(harborHome(), "blobs");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value.length > 0) {
      values[key] = value;
    }
  }

  return values;
}

/**
 * Loads KEY=VALUE pairs from `$HARBOR_HOME/.env` and `./.env`, without
 * overwriting anything already in the real environment. A real secrets story
 * (OS keychain) replaces this later; the interface callers use does not change.
 */
export function loadEnv(): void {
  const candidates = [join(harborHome(), ".env"), resolve(process.cwd(), ".env")];

  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }

    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function requireEnv(key: string, hint: string): string {
  const value = process.env[key];

  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${key} is not set. ${hint}`);
  }

  return value.trim();
}
