/**
 * Reaching Harbor from somewhere that is not this machine.
 *
 * The requirement is a phone, from anywhere, and the network answer to that is
 * a private network rather than anything Harbor implements. Harbor stays bound
 * to loopback and something else carries the traffic; putting a mailbox on the
 * public internet is what the encryption work existed to prevent, and a
 * password on a port is not an answer.
 *
 * This file detects rather than configures. It reads Tailscale's state, works
 * out which of the four steps is missing, and prints the one command that fixes
 * it. It does not run `tailscale` on somebody's behalf, for the same reason
 * `install-service` writes a plist and does not install it.
 *
 * Everything here degrades to instructions. Tailscale may be absent, logged
 * out, or a version whose JSON has moved, and none of those are reasons to
 * throw at somebody trying to find out why their phone cannot reach Harbor.
 */
import { execFile } from "node:child_process";

export type RemoteState =
  | "no-tailscale"
  | "logged-out"
  | "not-served"
  | "served"
  | "unknown";

export interface RemoteStatus {
  readonly state: RemoteState;
  /** The tailnet hostname, once there is one. */
  readonly host: string | null;
  /** What a browser should open, once it would work. */
  readonly url: string | null;
  /** Which local port Tailscale is publishing, if any. */
  readonly servedPort: number | null;
}

/**
 * Run a command and return its output, or null.
 *
 * Timed out because `tailscale status` blocks while the daemon is starting,
 * and a status command that hangs is worse than one that admits it does not
 * know.
 */
function run(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 4000 }, (error, stdout) => {
      resolve(error === null ? stdout : null);
    });
  });
}

function parse(text: string | null): Record<string, unknown> | null {
  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The local port Tailscale is publishing, from a serve config of any shape. */
function servedPort(config: Record<string, unknown> | null): number | null {
  if (config === null) {
    return null;
  }

  // The shape of this config has changed across Tailscale releases and will
  // again. Rather than walk a path that a version bump can invalidate
  // silently, find the loopback target anywhere in it.
  const found = /127\.0\.0\.1:(\d+)/.exec(JSON.stringify(config));

  return found?.[1] === undefined ? null : Number.parseInt(found[1], 10);
}

export async function remoteStatus(): Promise<RemoteStatus> {
  const status = parse(await run("tailscale", ["status", "--json"]));

  if (status === null) {
    // Absent, or installed and not on PATH, which for the purpose of the next
    // thing to do are the same situation.
    return { state: "no-tailscale", host: null, url: null, servedPort: null };
  }

  if (status["BackendState"] !== "Running") {
    return { state: "logged-out", host: null, url: null, servedPort: null };
  }

  const self = status["Self"] as { DNSName?: string } | undefined;
  const host = (self?.DNSName ?? "").replace(/\.$/, "");

  if (host === "") {
    return { state: "unknown", host: null, url: null, servedPort: null };
  }

  const port = servedPort(parse(await run("tailscale", ["serve", "status", "--json"])));

  return {
    state: port === null ? "not-served" : "served",
    host,
    url: `https://${host}`,
    servedPort: port,
  };
}

/**
 * What to do next, in order, with only the step that is actually missing.
 *
 * Four steps, and a person who is stuck is stuck on exactly one of them. A wall
 * of setup instructions that includes the three already done is how somebody
 * reinstalls something that was working.
 */
export function remoteInstructions(
  status: RemoteStatus,
  port: number,
): readonly string[] {
  if (status.state === "no-tailscale") {
    return [
      "Tailscale is not installed, or is not on PATH.",
      "",
      "It is the free half of this: a private network between your own devices,",
      "so Harbor stays on loopback and is never exposed to anything else.",
      "",
      "  brew install --cask tailscale",
      "",
      "Then sign in, install it on your phone with the same account, and run",
      "`harbor remote` again.",
    ];
  }

  if (status.state === "logged-out") {
    return [
      "Tailscale is installed but not connected.",
      "",
      "  tailscale up",
    ];
  }

  if (status.state === "unknown") {
    return [
      "Tailscale answered, but not with a hostname this understands.",
      "",
      "  tailscale status",
    ];
  }

  if (status.state === "not-served") {
    return [
      `Tailscale is up as ${String(status.host)}, and nothing is published yet.`,
      "",
      `  tailscale serve --bg ${String(port)}`,
      "",
      "That proxies your tailnet address to Harbor on loopback. Harbor keeps",
      "binding 127.0.0.1: no port is forwarded and nothing listens on your LAN.",
      "",
      "If it refuses, HTTPS certificates are off for your tailnet. Turn them on",
      "at login.tailscale.com under Settings, DNS, HTTPS Certificates.",
    ];
  }

  if (status.servedPort !== port) {
    return [
      `Tailscale is publishing port ${String(status.servedPort)}, and Harbor is on ${String(port)}.`,
      "",
      `  tailscale serve --bg ${String(port)}`,
    ];
  }

  return [
    `Open ${String(status.url)} on your phone, on any network.`,
    "",
    "It will ask to be paired. Pair it with the code below, then use Share and",
    "Add to Home Screen so it opens without browser chrome.",
    "",
    "Only devices signed into your tailnet can reach it, and the connection is",
    "HTTPS with a real certificate, so the pairing token is never in the clear.",
  ];
}
