/**
 * Device tokens.
 *
 * The moment other machines in the house can reach Harbor, a process listening
 * on a socket stops being a trusted caller. Tokens are stored hashed and the
 * plaintext is shown exactly once at pairing, for the same reason every other
 * system does it: a token you can read out of a database later is a token an
 * attacker can read out of a backup.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "../kernel/db.js";

export type DeviceScope = "read" | "act";

export interface Device {
  readonly id: string;
  readonly name: string;
  readonly principalId: string;
  readonly scopes: readonly DeviceScope[];
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly revoked: boolean;
}

interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly principal_id: string;
  readonly scopes: string;
  readonly created_at: number;
  readonly last_seen_at: number | null;
  readonly revoked_at: number | null;
}

function hydrate(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    principalId: row.principal_id,
    scopes: row.scopes.split(",").filter((scope): scope is DeviceScope => scope.length > 0),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revoked: row.revoked_at !== null,
  };
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface PairedDevice {
  readonly device: Device;
  /** Shown once. Not recoverable. */
  readonly token: string;
}

export function pairDevice(
  db: DB,
  input: {
    readonly name: string;
    readonly principalId: string;
    readonly scopes?: readonly DeviceScope[];
  },
): PairedDevice {
  const token = `hbr_${randomBytes(24).toString("base64url")}`;
  const id = `d_${randomBytes(8).toString("hex")}`;
  // Read-only by default. Granting write to a phone should be a decision.
  const scopes = input.scopes ?? ["read"];

  db.prepare(
    `INSERT INTO devices (id, name, token_hash, principal_id, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, hash(token), input.principalId, scopes.join(","), Date.now());

  const device = getDevice(db, id);

  if (device === null) {
    throw new Error(`Device ${id} vanished immediately after being written`);
  }

  return { device, token };
}

export function getDevice(db: DB, id: string): Device | null {
  const row = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as DeviceRow | undefined;
  return row === undefined ? null : hydrate(row);
}

export function listDevices(db: DB): readonly Device[] {
  const rows = db.prepare(`SELECT * FROM devices ORDER BY created_at DESC`).all() as DeviceRow[];
  return rows.map(hydrate);
}

export function revokeDevice(db: DB, id: string): boolean {
  return db.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ?`).run(Date.now(), id).changes > 0;
}

/**
 * Resolves a bearer token.
 *
 * The hash comparison is constant-time. It matters less here than in a public
 * service, and costs nothing.
 */
export function authenticate(db: DB, token: string): Device | null {
  const digest = hash(token);

  const rows = db.prepare(`SELECT * FROM devices WHERE revoked_at IS NULL`).all() as (DeviceRow & {
    token_hash: string;
  })[];

  for (const row of rows) {
    const left = Buffer.from(row.token_hash, "hex");
    const right = Buffer.from(digest, "hex");

    if (left.length === right.length && timingSafeEqual(left, right)) {
      // Throttled, and it gives up almost immediately.
      //
      // Updating this on every request made every read a writer, which is how a
      // background job and a browser ended up fighting over one lock. Throttling
      // was not enough on its own: the first request of a session still tried to
      // write, and with a thirty second busy timeout it sat there for thirty
      // seconds before giving up.
      //
      // So the timeout is dropped to almost nothing for this one statement. The
      // value is displayed to a person and nothing depends on it, which makes
      // "skip it if the database is busy" exactly the right behaviour. The
      // connection is single-threaded, so nothing else can observe the window
      // where the pragma is lowered.
      const now = Date.now();

      if (row.last_seen_at === null || now - row.last_seen_at > 3_600_000) {
        try {
          db.pragma("busy_timeout = 40");
          db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(now, row.id);
        } catch {
          // Another process is writing. Nothing here is worth waiting for, let
          // alone failing a request over.
        } finally {
          db.pragma("busy_timeout = 30000");
        }
      }
      return hydrate(row);
    }
  }

  return null;
}
