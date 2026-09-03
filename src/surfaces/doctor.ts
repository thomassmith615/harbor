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
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { affixNote } from "../derive/embed/affixes.js";
import { keyOpens } from "../kernel/db.js";
import { readSecret } from "../kernel/keychain.js";
import type { KeySource } from "../kernel/encryption.js";
import { join } from "node:path";
import { harborHome } from "../kernel/paths.js";
import { directoryBytes, freeBytes } from "../kernel/housekeeping.js";
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
      fix: backend === "none" ? null : "harbor settings secrets --move",
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

  // Read the header, do not guess from the filename.
  //
  // A `VACUUM INTO` snapshot taken from an encrypted store inherits the cipher,
  // so a plain `.db` name says nothing about whether the contents are readable.
  // Calling that a problem sends somebody to delete a backup that was fine,
  // which is the most expensive kind of wrong answer this command can give.
  const plain = files.filter((name) => !isEncryptedFile(join(directory, name)));
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


/**
 * Whether a file is an encrypted database, from its own first bytes.
 *
 * Covers both formats Harbor writes: a `VACUUM INTO` snapshot carrying the
 * store cipher, and a passphrase backup, which begins with its own magic. Read
 * the header rather than guessing from the filename, because a plain `.db` name
 * says nothing about whether the contents are readable, and calling such a file
 * a problem sends somebody to delete a backup that was fine.
 */
function isEncryptedFile(path: string): boolean {
  try {
    const handle = openSync(path, "r");

    try {
      const header = Buffer.alloc(16);
      readSync(handle, header, 0, 16, 0);

      const text = header.toString("latin1");

      return text !== "SQLite format 3\u0000" || text.startsWith("HARBOR01");
    } finally {
      closeSync(handle);
    }
  } catch {
    // Unreadable is not the same as unencrypted, and guessing "plaintext" would
    // raise an alarm about a file nobody can open anyway.
    return true;
  }
}

function checkStore(db: DB, keySource: KeySource): readonly Finding[] {
  const path = join(harborHome(), "harbor.db");
  const size = existsSync(path) ? statSync(path).size : 0;

  // Read from the file rather than asked of the driver: a header check cannot
  // be wrong about this, and a process holding an unlocked handle would say
  // everything is fine either way.
  const encrypted = existsSync(path) && isEncryptedFile(path);

  const findings: Finding[] = [
    encrypted
      ? {
          area: "store",
          severity: "ok",
          detail:
            `${bytes(size)} on disk, encrypted, and the key Harbor is using opens it` +
            (keySource === "environment"
              ? ". That key is coming from HARBOR_STORE_KEY, not the keychain, so anything " +
                "that does not inherit your shell (the daemon, a LaunchAgent) will not find it"
              : ", from the keychain"),
          fix: null,
        }
      : {
          area: "store",
          severity: "warn",
          detail:
            `${bytes(size)} on disk, unencrypted. Message bodies, contacts, and everything ` +
            `derived from them are readable by anything that can read the file.`,
          fix: "harbor settings encryption --enable",
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

function checkSchedule(db: DB, now: number): readonly Finding[] {
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1`).get() as {
    n: number;
  }).n;

  if (count === 0) {
    return [
      {
        area: "schedule",
        severity: "warn",
        detail: "nothing runs unattended, so Harbor only updates when you ask it to",
        fix: "harbor settings schedule add pulse --every 15m",
      },
    ];
  }

  const findings: Finding[] = [
    { area: "schedule", severity: "ok", detail: `${String(count)} tasks enabled`, fix: null },
  ];

  // A schedule that is enabled and has never succeeded is the failure mode this
  // whole check exists for. It looks identical to a healthy one in
  // `settings schedule list`: enabled, next run set, and quietly failing or
  // being refused every time it comes due.
  const rows = db
    .prepare(
      `SELECT task, last_run_at, last_status, last_note, interval_minutes, next_run_at
       FROM schedules WHERE enabled = 1`,
    )
    .all() as {
    task: string;
    last_run_at: number | null;
    last_status: string | null;
    last_note: string | null;
    interval_minutes: number | null;
    next_run_at: number | null;
  }[];

  for (const row of rows) {
    // Twice its own interval for a repeating task, two days for a daily one.
    // Anything that has missed two consecutive windows is not late, it is
    // broken, and on an appliance nobody finds out any other way.
    const budget =
      row.interval_minutes === null ? 2 * 86_400_000 : row.interval_minutes * 60_000 * 2;

    if (row.last_run_at === null) {
      // A schedule that has never run is only interesting once it is overdue.
      // The first version of this warned unconditionally, which meant a fresh
      // `harbor init` printed eight warnings about tasks that were working
      // perfectly and simply had not come due yet. A diagnostic that cries on
      // a healthy new install teaches people to skim past it, and then it is
      // worth nothing on the day something is actually wrong.
      if (row.next_run_at !== null && now - row.next_run_at > budget) {
        findings.push({
          area: `schedule ${row.task}`,
          severity: "problem",
          detail: "was due and has still never run",
          fix: "harbor daemon, or check it is loaded with launchctl list | grep harbor",
        });
      }

      continue;
    }

    const age = now - row.last_run_at;

    if (age > budget) {
      findings.push({
        area: `schedule ${row.task}`,
        severity: "problem",
        detail:
          `last ran ${String(Math.round(age / 3_600_000))}h ago, which is past two of its own windows`,
        fix: "harbor jobs, and check the daemon is running",
      });

      continue;
    }

    if (row.last_status === "error") {
      findings.push({
        area: `schedule ${row.task}`,
        severity: "problem",
        detail: `last run failed: ${(row.last_note ?? "no detail").slice(0, 80)}`,
        fix: `harbor dev run ${row.task}`,
      });

      continue;
    }

    // Being refused once is routine coordination. Being refused every time is a
    // task that never runs, and the only difference visible from outside is
    // that one of them says "skipped" twice in a row.
    if (row.last_status === "skipped" && (row.last_note ?? "").startsWith("skipped:")) {
      findings.push({
        area: `schedule ${row.task}`,
        severity: "warn",
        detail: `last attempt was refused: ${(row.last_note ?? "").slice(0, 60)}`,
        fix: "harbor jobs, to see what is holding the lock",
      });
    }
  }

  return findings;
}

/**
 * Whether the appliance is going to run out of room.
 *
 * Two writers used to grow without limit: nightly backups, which nothing
 * pruned, and the daemon logs, which nothing rotated. Both are bounded now,
 * but the check stays, because the first symptom of a full disk is Harbor
 * failing to write, which is also the moment it stops being able to back
 * itself up. That is not a thing to discover from a stack trace.
 */
function checkDisk(): readonly Finding[] {
  const findings: Finding[] = [];
  const free = freeBytes();

  const storePath = join(harborHome(), "harbor.db");
  const storeBytes = existsSync(storePath) ? statSync(storePath).size : 0;
  const backupBytes = directoryBytes("backups");
  const logBytes = directoryBytes("logs");

  if (free !== null) {
    // Enough room for the store plus one more backup of it, with headroom. A
    // disk that cannot hold one more snapshot has already stopped being backed
    // up, whatever the schedule says.
    const needed = storeBytes * 2;

    findings.push({
      area: "disk",
      severity: free < needed ? "problem" : free < needed * 2 ? "warn" : "ok",
      detail:
        `${bytes(free)} free, store is ${bytes(storeBytes)}, ` +
        `backups ${bytes(backupBytes)}, logs ${bytes(logBytes)}`,
      fix:
        free < needed * 2
          ? "harbor backup --prune, or move ~/.harbor/backups to another volume"
          : null,
    });
  }

  return findings;
}

export interface DoctorReport {
  readonly findings: readonly Finding[];
  readonly problems: number;
  readonly warnings: number;
}

/**
 * Which embedding convention the store was written under.
 *
 * Worth a line in `doctor` because getting it wrong is silent. An asymmetric
 * model given no prefix returns vectors, the index builds, search runs, and
 * every answer is slightly off with nothing anywhere reporting a problem. The
 * other half of the check is mixed vintages: vectors written before the
 * prefixes existed are not comparable with vectors written after, so an index
 * holding both ranks two populations against each other.
 */
function checkEmbedding(db: DB): readonly Finding[] {
  const model = (
    db.prepare(`SELECT model FROM embeddings LIMIT 1`).get() as { model: string } | undefined
  )?.model;

  if (model === undefined) {
    return [];
  }

  const versions = db
    .prepare(`SELECT DISTINCT pipeline_version AS version FROM chunks ORDER BY version`)
    .all() as { version: number }[];

  const findings: Finding[] = [
    {
      area: "embedding",
      severity: "ok",
      detail: `${model}: ${affixNote(model)}`,
      fix: null,
    },
  ];

  if (versions.length > 1) {
    findings.push({
      area: "embedding",
      severity: "warn",
      detail:
        `chunks exist under ${String(versions.length)} pipeline versions, so vectors ` +
        "written under different conventions are being ranked against each other",
      fix: "harbor dev derive --rebuild",
    });
  }

  return findings;
}

export async function doctor(db: DB, now: number = Date.now()): Promise<DoctorReport> {
  // Which key is actually in use, not merely which one exists. The difference
  // decides whether the daemon can start, and it is the thing `doctor` is for.
  const keySource = await workingKeySource(join(harborHome(), "harbor.db"));

  const backend = await detectKeychain();

  const findings = [
    ...checkCredentials(db, backend),
    ...checkSources(db, now),
    ...checkStore(db, keySource),
    ...checkBackups(),
    ...checkDisk(),
    ...checkSchedule(db, now),
    ...checkEmbedding(db),
  ];

  return {
    findings,
    problems: findings.filter((finding) => finding.severity === "problem").length,
    warnings: findings.filter((finding) => finding.severity === "warn").length,
  };
}

/**
 * Where the key that opens the store came from, or that nothing does.
 *
 * "The key is in the keychain" was printed unconditionally whenever the store
 * was encrypted, which was true, useless, and actively misleading on the one
 * morning it mattered: the keychain held a key that did not open anything and
 * `doctor` cheerfully said everything was fine while the daemon crash-looped.
 */
async function workingKeySource(path: string): Promise<KeySource> {
  if (!isEncryptedFile(path)) {
    return "none";
  }

  const fromEnv = process.env["HARBOR_STORE_KEY"];

  if (fromEnv !== undefined && fromEnv.length > 0 && keyOpens(path, fromEnv.trim())) {
    return "environment";
  }

  const fromKeychain = await readSecret("store-encryption-key");

  return fromKeychain !== null && keyOpens(path, fromKeychain) ? "keychain" : "none";
}
