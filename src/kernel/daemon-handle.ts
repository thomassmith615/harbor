/**
 * How the CLI finds a running daemon.
 *
 * The underlying problem is that `harbor start onboard` opened its own database
 * connection and ran a long job in the CLI process, while the daemon sat in
 * another terminal doing the same thing. Two writers on one SQLite file is not
 * a configuration to tune; it is a mistake to avoid. The fix is that there is
 * one writer, and the CLI hands work to it.
 *
 * The daemon writes this file at startup and removes it on shutdown. It holds a
 * token minted for local use, which is why the file is mode 0600 and lives
 * beside the database rather than anywhere shared.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harborHome } from "./paths.js";

export interface DaemonHandle {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly scheme: "http" | "https";
  readonly token: string;
  readonly startedAt: number;
}

function handlePath(): string {
  return join(harborHome(), "daemon.json");
}

export function writeHandle(handle: DaemonHandle): void {
  writeFileSync(handlePath(), JSON.stringify(handle, null, 2), { mode: 0o600 });
}

export function clearHandle(): void {
  try {
    rmSync(handlePath(), { force: true });
  } catch {
    // Already gone, or the directory is.
  }
}

/**
 * The running daemon, or null.
 *
 * A stale file from a process that was killed would send the CLI to a port
 * nobody is listening on, so the pid is checked before the handle is trusted.
 * `kill(pid, 0)` tests for existence without signalling.
 */
export function readHandle(): DaemonHandle | null {
  const path = handlePath();

  if (!existsSync(path)) {
    return null;
  }

  try {
    const handle = JSON.parse(readFileSync(path, "utf8")) as DaemonHandle;

    try {
      process.kill(handle.pid, 0);
    } catch {
      clearHandle();
      return null;
    }

    return handle;
  } catch {
    clearHandle();
    return null;
  }
}

/** Asks the daemon to stop a job, since only it can actually interrupt one. */
export async function stopViaDaemon(
  handle: DaemonHandle,
  id: string,
  force: boolean,
): Promise<string> {
  try {
    const response = await fetch(
      `${handle.scheme}://${handle.host}:${String(handle.port)}/jobs/${id}/cancel`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${handle.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ force }),
      },
    );

    const body = (await response.json()) as { stopped?: number | boolean; error?: string };

    if (!response.ok) {
      return body.error ?? `daemon returned ${String(response.status)}`;
    }

    if (typeof body.stopped === "number") {
      return body.stopped === 0
        ? "Nothing running."
        : `Stopping ${String(body.stopped)} job${body.stopped === 1 ? "" : "s"}.`;
    }

    return body.stopped === true
      ? force
        ? `${id} marked stopped.`
        : `${id} will stop at its next checkpoint.`
      : `${id} is not running.`;
  } catch (cause: unknown) {
    return cause instanceof Error ? cause.message : "could not reach the daemon";
  }
}

export interface DelegateResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Hands a task to the daemon.
 *
 * Returns rather than throws on failure, because the caller's fallback is to
 * run the work itself and a daemon that cannot be reached should not stop that.
 */
export async function delegateJob(
  handle: DaemonHandle,
  task: string,
  source?: string,
): Promise<DelegateResult> {
  try {
    const response = await fetch(`${handle.scheme}://${handle.host}:${String(handle.port)}/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task, ...(source === undefined ? {} : { source }) }),
    });

    const body = (await response.json()) as {
      job?: { id: string; task: string } | null;
      alreadyRunning?: boolean;
      blocked?: { task: string } | null;
      error?: string;
    };

    if (!response.ok) {
      return { ok: false, detail: body.error ?? `daemon returned ${String(response.status)}` };
    }

    if (body.blocked != null) {
      return {
        ok: true,
        detail:
          `${task} cannot run while ${body.blocked.task} is running.\n` +
          "Stop it with `harbor stop all`, or wait.",
      };
    }

    return {
      ok: true,
      detail:
        body.alreadyRunning === true
          ? `${task} is already running (${body.job?.id ?? ""})`
          : `${body.job?.id ?? ""}  ${task}\nRunning in the daemon. Watch it with \`harbor jobs\`.`,
    };
  } catch (cause: unknown) {
    return {
      ok: false,
      detail: cause instanceof Error ? cause.message : "could not reach the daemon",
    };
  }
}
