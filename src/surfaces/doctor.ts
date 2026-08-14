/**
 * `harbor doctor`.
 *
 * An appliance that runs unattended for months needs one command that answers
 * "is this actually working, and what is exposed". Harbor could already report
 * counts and coverage, but every one of those numbers looks fine when a
 * connector has been quietly failing since March: the items it already has are
 * still there, and nothing says the newest one is four months old.
 *
 * So this checks the things that fail silently. A source that stopped syncing.
 * A credential still sitting in the database. A backup that is either missing
 * or is a plaintext copy of everything. A store growing faster than the disk
 * can take. A derivation that has fallen far enough behind that answers are
 * being given from stale data.
 *
 * Every check states what is wrong and what to run. A diagnostic that reports a
 * problem without a next step just moves the work.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { harborHome } from "../kernel/paths.js";
import { detectKeychain, isReference } from "../kernel/keychain.js";
import type { DB } from "../kernel/db.js";

export type Severity = "ok" | "warn" | "problem";

export interface Finding {
  readonly area: string;
  readonly severity: Severity;
  readonly detail: string;
  readonly fix: string | null;
}

/** A source silent for longer than this has probably stopped, not gone quiet. */
const STALE_SYNC_MS = 3 * 86_400_000;

/** Derived work this far behind means answers are coming from an old picture. */
const PENDING_LIMIT = 5_000;

function bytes(size: number): string {
  if (size > 1_073_741_824) {
    return `${(size / 1_073_741_824).toFixed(1)} GB`;
  }

  return `${String(Math.round(size / 1_048_576))} MB`;
}

function checkCredentials(db: DB, backend: string): readonly Finding[] {
  const rows = db.prepare(`SELECT id, source_type, credentials FROM accounts`).all() as {
    id: string;
    source_type: string;
    credentials: string;
  }[];

  if (rows.length === 0) {
    return [{ area: "credentials", severity: "ok", detail: "no accounts connected", fix: null }];
  }

  const inDatabase = rows.filter((row) => !isReference(row.credentials));

  if (inDatabase.length === 0) {
    return [
      {
        area: "credentials",
        severity: "ok",
        detail: `all ${String(rows.length)} in the ${backend} keychain`,
        fix: null,
      },
    ];
  }

  return [
    {
      area: "credentials",
      severity: backend === "none" ? "warn" : "problem",
      detail:
        `${String(inDatabase.length)} of ${String(rows.length)} stored in the database in plain text ` +
        `(${inDatabase.map((row) => row.source_type).join(", ")})` +
        (backend === "none" ? ", and no keychain is available on this machine" : ""),
      fix: backend === "none" ? null : "harbor secrets --move",
    },
  ];
}

function checkSources(db: DB, now: number): readonly Finding[] {
  const rows = db
    .prepare(
      `SELECT s.connector_id AS connector, a.label AS label, s.last_sync_at AS last,
              (SELECT COUNT(*) FROM items i WHERE i.stream_id = s.id AND i.deleted_at IS NULL) AS items
       FROM streams s JOIN accounts a ON a.id = s.account_id`,
    )
    .all() as { connector: string; label: string; last: number | null; items: number }[];

  const findings: Finding[] = [];

  for (const row of rows) {
    if (row.last === null) {
      findings.push({
        area: `source ${row.connector}`,
        severity: row.items === 0 ? "warn" : "ok",
        detail:
          row.items === 0
            ? "connected but has never synced"
            : `${String(row.items)} items, mid-backfill (no cursor yet)`,
        fix: row.items === 0 ? "harbor start recent" : null,
      });

      continue;
    }

    const age = now - row.last;

    findings.push({
      area: `source ${row.connector}`,
      severity: age > STALE_SYNC_MS ? "problem" : "ok",
      detail:
        age > STALE_SYNC_MS
          ? `last synced ${String(Math.round(age / 86_400_000))} days ago, which usually means it is failing`
          : `synced ${String(Math.round(age / 3_600_000))} hours ago, ${String(row.items)} items`,
      fix: age > STALE_SYNC_MS ? `harbor sync --source ${row.connector}` : null,
    });
  }

  return findings;
}

function checkBackups(): readonly Finding[] {
  const directory = join(harborHome(), "backups");

  if (!existsSync(directory)) {
    return [
      {
        area: "backups",
        severity: "warn",
        detail: "none taken",
        fix: "harbor backup --encrypt",
      },
    ];
  }

  const files = readdirSync(directory).filter((name) => name.startsWith("harbor-"));

  if (files.length === 0) {
    return [{ area: "backups", severity: "warn", detail: "none taken", fix: "harbor backup --encrypt" }];
  }

  const plain = files.filter((name) => !name.endsWith(".enc"));
  const newest = files
    .map((name) => statSync(join(directory, name)).mtimeMs)
    .reduce((max, value) => Math.max(max, value), 0);

  const age = Math.round((Date.now() - newest) / 86_400_000);

  if (plain.length > 0) {
    return [
      {
        area: "backups",
        severity: "problem",
        detail:
          `${String(plain.length)} unencrypted snapshot(s) on disk, each a full copy of everything Harbor holds`,
        fix: "harbor backup --encrypt, then delete the plain ones",
      },
    ];
  }

  return [
    {
      area: "backups",
      severity: age > 14 ? "warn" : "ok",
      detail: `${String(files.length)} encrypted, newest ${String(age)} days old`,
      fix: age > 14 ? "harbor backup --encrypt" : null,
    },
  ];
}

function checkStore(db: DB): readonly Finding[] {
  const path = join(harborHome(), "harbor.db");
  const size = existsSync(path) ? statSync(path).size : 0;

  const findings: Finding[] = [
    {
      area: "store",
      severity: "warn",
      detail:
        `${bytes(size)} on disk, unencrypted. Message bodies, contacts, and everything derived ` +
        `from them are readable by anything that can read the file.`,
      // Named rather than fixed, because the honest answer is a decision rather
      // than a command: full at-rest encryption needs a key at boot, and a
      // passphrase typed at every restart is not an appliance.
      fix: null,
    },
  ];

  const pending = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND derived_version IS NULL) AS derive,
         (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND entities_version IS NULL) AS resolve,
         (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND relationships_version IS NULL) AS relate`,
    )
    .get() as { derive: number; resolve: number; relate: number };

  for (const [name, count, command] of [
    ["derive", pending.derive, "harbor dev derive"],
    ["resolve", pending.resolve, "harbor dev resolve"],
    ["relate", pending.relate, "harbor dev relate"],
  ] as const) {
    if (count > PENDING_LIMIT) {
      findings.push({
        area: `pending ${name}`,
        severity: "warn",
        detail: `${String(count)} items behind, so answers are coming from an incomplete picture`,
        fix: command,
      });
    }
  }

  return findings;
}

function checkSchedule(db: DB): readonly Finding[] {
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1`).get() as {
    n: number;
  }).n;

  if (count === 0) {
    return [
      {
        area: "schedule",
        severity: "warn",
        detail: "nothing runs unattended, so Harbor only updates when you ask it to",
        fix: "harbor schedule add pulse --every 15m",
      },
    ];
  }

  return [{ area: "schedule", severity: "ok", detail: `${String(count)} tasks enabled`, fix: null }];
}

export interface DoctorReport {
  readonly findings: readonly Finding[];
  readonly problems: number;
  readonly warnings: number;
}

export async function doctor(db: DB, now: number = Date.now()): Promise<DoctorReport> {
  const backend = await detectKeychain();

  const findings = [
    ...checkCredentials(db, backend),
    ...checkSources(db, now),
    ...checkStore(db),
    ...checkBackups(),
    ...checkSchedule(db),
  ];

  return {
    findings,
    problems: findings.filter((finding) => finding.severity === "problem").length,
    warnings: findings.filter((finding) => finding.severity === "warn").length,
  };
}
