/**
 * Keeping the appliance from filling its own disk.
 *
 * Everything here exists because of one property of the thing we are building:
 * nobody is watching. A laptop that accumulates junk gets noticed the next time
 * somebody opens Finder. A box beside the router does not, and the first signal
 * is Harbor failing to write, which is also the moment it stops being able to
 * back itself up.
 *
 * Two unbounded writers existed:
 *
 *   `harbor init` schedules a backup at 4am. `backup()` writes a new timestamped
 *   file and refuses to overwrite one. Nothing ever deleted them. A store of a
 *   few gigabytes, backed up nightly, is a terabyte inside a year.
 *
 *   The daemon's stdout and stderr are redirected into `logs/` by the launchd
 *   plist and the systemd unit, and nothing rotated them. Slower, but
 *   monotonic, and the failure is the same failure.
 *
 * Both run after the nightly backup rather than on their own schedule, because
 * the moment just after a successful backup is exactly when discarding an older
 * one is safe.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { harborHome } from "./paths.js";

/**
 * How many backups to keep.
 *
 * Seven daily and four weekly, which covers "I broke something this week" and
 * "I broke something a while ago and only just noticed". Anything older is
 * covered by the source systems, which still hold the originals; what a Harbor
 * backup uniquely protects is derived state, and derived state a month stale is
 * worth less than the disk it sits on.
 */
export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;

/** Log files larger than this are rotated. */
export const LOG_ROTATE_BYTES = 8 * 1_024 * 1_024;
/** How many rotated generations to keep per log. */
export const KEEP_LOG_GENERATIONS = 3;

export interface PruneReport {
  readonly kept: number;
  readonly removed: number;
  readonly bytesFreed: number;
  readonly files: readonly string[];
}

interface Candidate {
  readonly path: string;
  readonly name: string;
  readonly at: number;
  readonly bytes: number;
}

function backupsDir(): string {
  return join(harborHome(), "backups");
}

/**
 * Which backups to keep, newest first.
 *
 * Deliberately a pure function over (name, mtime, size) so the retention policy
 * can be tested without writing gigabytes to a disk. Getting this wrong deletes
 * somebody's only copy of their digital history, which puts it in a small class
 * of functions that should never be verified by running it and looking.
 */
export function selectForRemoval(
  candidates: readonly Candidate[],
  now: number,
  keepDaily: number = KEEP_DAILY,
  keepWeekly: number = KEEP_WEEKLY,
): readonly Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.at - a.at);
  const keep = new Set<string>();

  // The most recent N, whatever their spacing. If somebody ran four backups by
  // hand this afternoon while debugging, those are the interesting ones.
  for (const candidate of sorted.slice(0, keepDaily)) {
    keep.add(candidate.path);
  }

  // Then one per ISO week going back, oldest-surviving wins within a week so
  // the kept set spreads out rather than clustering at the recent end.
  const weeksSeen = new Set<number>();

  for (const candidate of sorted) {
    const week = Math.floor((now - candidate.at) / (7 * 86_400_000));

    if (week < 0 || weeksSeen.has(week)) {
      continue;
    }

    weeksSeen.add(week);

    if (weeksSeen.size <= keepWeekly) {
      keep.add(candidate.path);
    }
  }

  // The newest is never removed under any policy or arithmetic mistake. This is
  // belt and braces on purpose: every branch above already keeps it, and the
  // cost of that being false once is unrecoverable.
  const newest = sorted[0];

  if (newest !== undefined) {
    keep.add(newest.path);
  }

  return sorted.filter((candidate) => !keep.has(candidate.path));
}

function backupCandidates(): readonly Candidate[] {
  const directory = backupsDir();

  if (!existsSync(directory)) {
    return [];
  }

  const found: Candidate[] = [];

  for (const name of readdirSync(directory)) {
    if (!name.startsWith("harbor-")) {
      continue;
    }

    const path = join(directory, name);

    try {
      const stat = statSync(path);

      if (!stat.isFile()) {
        continue;
      }

      found.push({ path, name, at: stat.mtimeMs, bytes: stat.size });
    } catch {
      // Vanished between readdir and stat. Nothing to prune.
    }
  }

  return found;
}

export function pruneBackups(now: number = Date.now(), dryRun = false): PruneReport {
  const candidates = backupCandidates();
  const doomed = selectForRemoval(candidates, now);

  let bytesFreed = 0;
  const files: string[] = [];

  for (const candidate of doomed) {
    files.push(candidate.name);
    bytesFreed += candidate.bytes;

    if (!dryRun) {
      try {
        rmSync(candidate.path, { force: true });
      } catch {
        // A backup we could not remove is not a failure worth aborting for.
      }
    }
  }

  return {
    kept: candidates.length - doomed.length,
    removed: doomed.length,
    bytesFreed,
    files,
  };
}

export interface RotateReport {
  readonly rotated: readonly string[];
  readonly removed: number;
  readonly bytesFreed: number;
}

/**
 * Rotates oversized logs.
 *
 * Rename rather than truncate, because the daemon holds these open through a
 * shell redirect and truncating a file somebody is appending to at an offset
 * leaves a sparse file that reports its old size forever. Renaming and letting
 * the next write recreate is the behaviour every log rotator settled on for the
 * same reason.
 *
 * The trade is that the running daemon keeps writing to the renamed inode until
 * it is restarted. That is acceptable: the bound is what matters, and the file
 * stops growing at the next restart, which for a scheduled appliance is nightly
 * at worst.
 */
export function rotateLogs(
  maxBytes: number = LOG_ROTATE_BYTES,
  generations: number = KEEP_LOG_GENERATIONS,
): RotateReport {
  const directory = join(harborHome(), "logs");

  if (!existsSync(directory)) {
    return { rotated: [], removed: 0, bytesFreed: 0 };
  }

  const rotated: string[] = [];
  let removed = 0;
  let bytesFreed = 0;

  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".log")) {
      continue;
    }

    const path = join(directory, name);

    let bytes = 0;

    try {
      const stat = statSync(path);

      if (!stat.isFile() || stat.size < maxBytes) {
        continue;
      }

      bytes = stat.size;
    } catch {
      continue;
    }

    try {
      renameSync(path, `${path}.1`);
      rotated.push(name);
    } catch {
      continue;
    }

    // Shift the older generations down and drop whatever falls off the end.
    for (let generation = generations; generation >= 1; generation -= 1) {
      const older = `${path}.${String(generation)}`;

      if (!existsSync(older)) {
        continue;
      }

      if (generation >= generations) {
        try {
          bytesFreed += statSync(older).size;
          rmSync(older, { force: true });
          removed += 1;
        } catch {
          // Already gone.
        }

        continue;
      }

      try {
        renameSync(older, `${path}.${String(generation + 1)}`);
      } catch {
        // Leave it; the next pass tries again.
      }
    }

    void bytes;
  }

  return { rotated, removed, bytesFreed };
}

/**
 * Free space on the volume holding the store, or null if it cannot be read.
 *
 * Statically imported. The first version of this reached for `require` inside a
 * try, which in an ESM build is not a fallback, it is a guaranteed throw caught
 * by the very handler that made it look like an unsupported platform. It
 * typechecked and returned null on every machine.
 */
export function freeBytes(): number | null {
  try {
    const stat = statfsSync(harborHome());

    return Number(stat.bsize) * Number(stat.bavail);
  } catch {
    return null;
  }
}

/** Total bytes under a directory in the Harbor home. Shallow, which is enough. */
export function directoryBytes(name: string): number {
  const directory = join(harborHome(), name);

  if (!existsSync(directory)) {
    return 0;
  }

  let total = 0;

  for (const entry of readdirSync(directory)) {
    try {
      const stat = statSync(join(directory, entry));

      if (stat.isFile()) {
        total += stat.size;
      }
    } catch {
      // Skip.
    }
  }

  return total;
}

export function ensureLogDir(): string {
  const directory = join(harborHome(), "logs");

  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  return directory;
}
