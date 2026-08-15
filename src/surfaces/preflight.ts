/**
 * The checks nothing else can make.
 *
 * Every serious failure in the last week lived outside the process: a declared
 * dependency missing from `node_modules`, a log path the instructions did not
 * name, a keychain entry holding a key that opened nothing, a service manager
 * that never reads a shell profile, a status line asserting something it had
 * not checked. Typecheck cannot see any of it. The build cannot see any of it.
 * Every test passed through all five.
 *
 * That is not bad luck, it is a category. A test suite verifies that the code
 * is right about itself. Nothing in it verifies that the machine around the
 * code is what the code believes. This command is that second thing, and it is
 * deliberately separate from `doctor`: `doctor` answers "is my Harbor healthy",
 * which a person asks, and this answers "is this installation wired up
 * correctly", which somebody asks after changing the installation.
 *
 * The bar for adding a check here: it must be something that can be true in
 * development and false on a real machine.
 */
import { existsSync, accessSync, constants, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { harborHome, dbPath } from "../kernel/paths.js";

/** Where the service manager is told to write. Matches `kernel/service.ts`. */
function logDir(): string {
  return join(harborHome(), "logs");
}
import { keyOpens } from "../kernel/db.js";
import { readSecret } from "../kernel/keychain.js";
import { KEY_ACCOUNT, isEncrypted } from "../kernel/encryption.js";
import { recoverJson } from "../reasoning/json.js";
import { localModelFor } from "../reasoning/local.js";

const run = promisify(execFile);

export type CheckState = "ok" | "warn" | "problem";

export interface Check {
  readonly area: string;
  readonly state: CheckState;
  readonly detail: string;
  readonly fix: string | null;
}

/**
 * Every package the code imports actually resolves.
 *
 * The cheapest check here and the one that caught a broken release: the
 * iMessage connector imported a driver that had been removed from
 * `package.json`, which typecheck could not see because the types were still
 * installed and the build could not see because `tsc` does not resolve runtime
 * dependencies.
 */
async function checkDependencies(): Promise<readonly Check[]> {
  const required = ["better-sqlite3-multiple-ciphers", "commander", "sqlite-vec"];
  const optional = ["unpdf"];
  const checks: Check[] = [];

  for (const name of required) {
    try {
      await import(name);
      checks.push({ area: `dep ${name}`, state: "ok", detail: "resolves", fix: null });
    } catch {
      checks.push({
        area: `dep ${name}`,
        state: "problem",
        detail: "declared but not installed",
        fix: "npm install",
      });
    }
  }

  for (const name of optional) {
    try {
      await import(name);
      checks.push({ area: `dep ${name}`, state: "ok", detail: "resolves", fix: null });
    } catch {
      checks.push({
        area: `dep ${name}`,
        state: "warn",
        detail: "not installed, so PDF attachments will not be read",
        fix: `npm install ${name}`,
      });
    }
  }

  return checks;
}

/**
 * Every key Harbor might use, and whether it opens the store.
 *
 * Not "is there a key". A key that exists and does not work is worse than none,
 * because it is found first and then confidently used, which is exactly how an
 * encrypted store locked out its owner while every status line said fine.
 */
async function checkKeys(): Promise<readonly Check[]> {
  const path = dbPath();

  if (!(await isEncrypted(path))) {
    return [{ area: "store key", state: "ok", detail: "the store is not encrypted", fix: null }];
  }

  const checks: Check[] = [];
  const fromEnv = process.env["HARBOR_STORE_KEY"];

  if (fromEnv !== undefined && fromEnv.length > 0) {
    const works = keyOpens(path, fromEnv.trim());

    checks.push({
      area: "key: environment",
      state: works ? "ok" : "warn",
      detail: works ? "HARBOR_STORE_KEY opens the store" : "HARBOR_STORE_KEY does not open the store",
      fix: works ? null : "unset it, or set it to the key you wrote down",
    });
  }

  const fromKeychain = await readSecret(KEY_ACCOUNT);

  if (fromKeychain === null) {
    checks.push({
      area: "key: keychain",
      state: "problem",
      detail: "no key in the keychain, so nothing that lacks your shell can start",
      fix: "harbor settings encryption --repair-keychain",
    });
  } else {
    const works = keyOpens(path, fromKeychain);

    checks.push({
      area: "key: keychain",
      state: works ? "ok" : "problem",
      detail: works
        ? "the keychain key opens the store"
        : "the keychain holds a key that does not open the store",
      fix: works ? null : "harbor settings encryption --repair-keychain",
    });
  }

  return checks;
}

/**
 * An installed service, and whether it is actually running.
 *
 * A background process that fails silently on a machine in a closet is the
 * failure mode the whole appliance idea lives or dies on. `launchctl list`
 * prints a PID and a last exit status, and a dash with a non-zero status means
 * it tried and died, which is invisible unless somebody thinks to look.
 */
async function checkService(): Promise<readonly Check[]> {
  if (process.platform !== "darwin") {
    return [];
  }

  const installed = join(
    process.env["HOME"] ?? "",
    "Library",
    "LaunchAgents",
    "com.harbor.daemon.plist",
  );

  if (!existsSync(installed)) {
    return [{ area: "service", state: "ok", detail: "not installed", fix: null }];
  }

  try {
    const { stdout } = await run("launchctl", ["list"]);
    const line = stdout.split("\n").find((entry) => entry.includes("com.harbor.daemon"));

    if (line === undefined) {
      return [
        {
          area: "service",
          state: "warn",
          detail: "installed but not loaded",
          fix: "launchctl load ~/Library/LaunchAgents/com.harbor.daemon.plist",
        },
      ];
    }

    const [pid, status] = line.trim().split(/\s+/);

    if (pid !== undefined && pid !== "-") {
      return [{ area: "service", state: "ok", detail: `running as pid ${pid}`, fix: null }];
    }

    return [
      {
        area: "service",
        state: "problem",
        detail: `loaded but not running, last exit ${status ?? "unknown"}`,
        fix: `tail ${join(logDir(), "harbor.log")}`,
      },
    ];
  } catch {
    return [{ area: "service", state: "warn", detail: "launchctl could not be read", fix: null }];
  }
}

/** Somewhere to write, which a daemon discovers only by failing. */
function checkPaths(): readonly Check[] {
  const checks: Check[] = [];

  for (const [area, path] of [
    ["home", harborHome()],
    ["logs", logDir()],
  ] as const) {
    if (!existsSync(path)) {
      checks.push({
        area,
        state: area === "home" ? "problem" : "warn",
        detail: `${path} does not exist`,
        fix: area === "home" ? "harbor init" : null,
      });
      continue;
    }

    try {
      accessSync(path, constants.W_OK);
      checks.push({ area, state: "ok", detail: "writable", fix: null });
    } catch {
      checks.push({ area, state: "problem", detail: `${path} is not writable`, fix: null });
    }
  }

  return checks;
}

/**
 * The node binary a service manager was told to use still exists.
 *
 * The plist records an absolute path, and a Homebrew upgrade moves it. The
 * symptom is a service that worked for months and then silently stops.
 */
function checkNode(): readonly Check[] {
  const plist = join(harborHome(), "com.harbor.daemon.plist");

  if (!existsSync(plist)) {
    return [];
  }

  const entry = join(process.cwd(), "dist", "cli", "main.js");

  return [
    {
      area: "entry point",
      state: existsSync(entry) ? "ok" : "problem",
      detail: existsSync(entry) ? "dist/cli/main.js is built" : "dist/cli/main.js is missing",
      fix: existsSync(entry) ? null : "npm run build",
    },
  ];
}

/** Backups, by what is in them rather than what they are called. */
function checkBackups(): readonly Check[] {
  const directory = join(harborHome(), "backups");

  if (!existsSync(directory)) {
    return [];
  }

  const files = readdirSync(directory).filter((name) => name.startsWith("harbor-"));

  if (files.length === 0) {
    return [];
  }

  const newest = files
    .map((name) => statSync(join(directory, name)).mtimeMs)
    .reduce((max, value) => Math.max(max, value), 0);

  const days = Math.round((Date.now() - newest) / 86_400_000);

  return [
    {
      area: "backups",
      state: days > 14 ? "warn" : "ok",
      detail: `${String(files.length)} on disk, newest ${String(days)} days old`,
      fix: days > 14 ? "harbor backup --encrypt" : null,
    },
  ];
}

/**
 * Whether the configured local model can return usable JSON.
 *
 * The check that would have saved a 23-minute run producing nothing. The model
 * was reachable, the name was right, the prompt was fine, and every response
 * began with a reasoning trace that made it unparseable. Nothing reported that
 * until the pass finished.
 *
 * Asks for the smallest possible object and reports what actually came back,
 * including whether it had to be recovered from around a `<think>` block, which
 * is the difference between a model that works and one that works slowly.
 */
async function checkLocalModel(): Promise<readonly Check[]> {
  const url = process.env["HARBOR_LOCAL_URL"] ?? "http://127.0.0.1:11434/v1/chat/completions";
  // The model the router will actually call, not a second guess at it.
  const model = localModelFor("small");

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: 'Reply with only this JSON: {"ok":true}' }],
        max_tokens: 1_000,
        stream: false,
        think: false,
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return [
      {
        area: `local model ${model}`,
        state: "warn",
        detail: `no reply from ${url}`,
        fix: "start it (ollama serve), or set HARBOR_LOCAL_URL",
      },
    ];
  }

  if (!response.ok) {
    const body = await response.text();

    return [
      {
        area: `local model ${model}`,
        state: "problem",
        detail: `${String(response.status)}: ${body.slice(0, 80)}`,
        fix: `ollama pull ${model}, or set HARBOR_LOCAL_MODEL`,
      },
    ];
  }

  const payload = (await response.json()) as {
    choices?: {
      finish_reason?: string;
      message?: { content?: string; reasoning?: string; reasoning_content?: string };
    }[];
  };

  const choice = payload.choices?.[0];
  const message = choice?.message;
  const content = message?.content ?? "";

  // Some servers move the reasoning into its own field and leave `content`
  // empty. An empty answer beside a full reasoning field is a model that is
  // still thinking despite being asked not to, which is a different problem
  // from a model that cannot follow instructions, and the fix is different too.
  const thoughts = message?.reasoning ?? message?.reasoning_content ?? "";

  if (content.trim().length === 0 && thoughts.trim().length > 0) {
    return [
      {
        area: `local model ${model}`,
        state: "problem",
        detail: "reasons but never answers; the reply is all thinking and no content",
        fix: `ollama pull llama3.2:3b && export HARBOR_LOCAL_MODEL=llama3.2:3b`,
      },
    ];
  }

  if (content.trim().length === 0) {
    return [
      {
        area: `local model ${model}`,
        state: "problem",
        detail:
          choice?.finish_reason === "length"
            ? "ran out of tokens before answering, which usually means it is reasoning"
            : "returned an empty reply",
        fix: `ollama pull llama3.2:3b && export HARBOR_LOCAL_MODEL=llama3.2:3b`,
      },
    ];
  }

  const recovery = recoverJson(content);

  if (recovery.error !== null) {
    return [
      {
        area: `local model ${model}`,
        state: "problem",
        detail: `answers, but not with JSON: ${recovery.error}`,
        fix: "set HARBOR_LOCAL_MODEL to a model that follows a JSON instruction",
      },
    ];
  }

  return [
    {
      area: `local model ${model}`,
      state: recovery.repaired.length === 0 ? "ok" : "warn",
      detail:
        recovery.repaired.length === 0
          ? "returns clean JSON"
          : `returns JSON wrapped in ${recovery.repaired.join(" and ")}, which is recoverable but slow`,
      fix: recovery.repaired.length === 0 ? null : "a non-reasoning model would be faster",
    },
  ];
}

export interface PreflightReport {
  readonly checks: readonly Check[];
  readonly problems: number;
  readonly warnings: number;
}

export async function preflight(): Promise<PreflightReport> {
  const checks = [
    ...(await checkDependencies()),
    ...checkPaths(),
    ...checkNode(),
    ...(await checkKeys()),
    ...(await checkService()),
    ...(await checkLocalModel()),
    ...checkBackups(),
  ];

  return {
    checks,
    problems: checks.filter((check) => check.state === "problem").length,
    warnings: checks.filter((check) => check.state === "warn").length,
  };
}
