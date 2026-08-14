/**
 * Pairing codes.
 *
 * A device joins by entering a short code shown on the box, not by someone
 * copying a bearer token out of a terminal. Single use, minutes-long TTL,
 * because a pairing secret that lives forever is a password nobody rotates.
 *
 * The code is short enough to read aloud or render as a QR. It is not the
 * credential: redeeming it mints a real device token, and the code is burned.
 */
import { randomInt } from "node:crypto";
import { pairDevice } from "./devices.js";
import type { DB } from "../kernel/db.js";
import type { DeviceScope, PairedDevice } from "./devices.js";

const TTL_MINUTES = 10;
/** No I, O, 0, or 1: this gets read off a screen and typed on a phone. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generate(length = 8): string {
  let code = "";

  for (let index = 0; index < length; index += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }

  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface PairingCode {
  readonly code: string;
  readonly scopes: readonly DeviceScope[];
  readonly label: string | null;
  readonly expiresAt: number;
}

export function issueCode(
  db: DB,
  input: {
    readonly principalId: string;
    readonly scopes?: readonly DeviceScope[];
    readonly label?: string;
  },
): PairingCode {
  const code = generate();
  const scopes = input.scopes ?? ["read"];
  const expiresAt = Date.now() + TTL_MINUTES * 60_000;

  db.prepare(
    `INSERT INTO pairing_codes (code, principal_id, scopes, label, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(code, input.principalId, scopes.join(","), input.label ?? null, expiresAt, Date.now());

  return { code, scopes, label: input.label ?? null, expiresAt };
}

export interface RedeemResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly device?: PairedDevice;
}

/**
 * Exchanges a code for a device token.
 *
 * Failure reasons are deliberately vague to the caller. "Expired" and "already
 * used" and "never existed" are all the same answer to someone guessing codes.
 */
export function redeem(db: DB, code: string, deviceName: string): RedeemResult {
  const normalized = code.trim().toUpperCase();

  const row = db.prepare(`SELECT * FROM pairing_codes WHERE code = ?`).get(normalized) as
    | {
        code: string;
        principal_id: string;
        scopes: string;
        expires_at: number;
        used_at: number | null;
      }
    | undefined;

  if (row === undefined || row.used_at !== null || row.expires_at < Date.now()) {
    return { ok: false, reason: "that code is not valid" };
  }

  db.prepare(`UPDATE pairing_codes SET used_at = ? WHERE code = ?`).run(Date.now(), normalized);

  const device = pairDevice(db, {
    name: deviceName,
    principalId: row.principal_id,
    scopes: row.scopes.split(",").filter((scope): scope is DeviceScope => scope.length > 0),
  });

  return { ok: true, device };
}

/** Housekeeping. Expired codes are useless and there is no reason to keep them. */
export function purgeExpired(db: DB): number {
  return db.prepare(`DELETE FROM pairing_codes WHERE expires_at < ?`).run(Date.now()).changes;
}

export function activeCodes(db: DB): readonly PairingCode[] {
  const rows = db
    .prepare(
      `SELECT code, scopes, label, expires_at FROM pairing_codes
       WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(Date.now()) as { code: string; scopes: string; label: string | null; expires_at: number }[];

  return rows.map((row) => ({
    code: row.code,
    scopes: row.scopes.split(",") as DeviceScope[],
    label: row.label,
    expiresAt: row.expires_at,
  }));
}
