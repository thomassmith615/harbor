#!/usr/bin/env node
/**
 * The CLI is a client, not the platform.
 *
 * Every command here is a thin adapter: parse, call into a module, render.
 * When the HTTP and MCP surfaces arrive they call the same functions, which is
 * only true if none of the logic leaks into this file.
 */
import { Command } from "commander";
import { openDatabase } from "../kernel/db.js";
import { inspectCards } from "../derive/contacts.js";
import {
  clearEdges,
  countEdges,
  countThreads,
  resetRelationshipVersions,
  connectionsFor,
  threadNodes,
  topThreads,
} from "../store/relationships.js";
import { explain, relate } from "../derive/relate.js";
import { getEpisode, episodeItems } from "../store/episodes.js";
import { searchEpisodes } from "../retrieval/episodes.js";
import { segmentEpisodes } from "../derive/episodes.js";
import { buildCommitments, intentCandidates } from "../derive/commitments.js";
import { latestDigest, produceDigest, recentDigests } from "../derive/digest.js";
import { extractPurchases, purchaseCandidates } from "../derive/extract.js";
import { attachmentSummary, attachmentsFor } from "../store/attachments.js";
import { linesFor, listProjections, spendByMerchant } from "../store/projections.js";
import {
  countCommitments,
  evidenceFor,
  getCommitment,
  listCommitments,
} from "../store/commitments.js";
import { createLogger } from "../kernel/logger.js";
import { harborHome, loadEnv } from "../kernel/paths.js";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import { backup, encryptedBackup, restoreBackup } from "../kernel/backup.js";
import { doctor } from "../surfaces/doctor.js";
import { proposeFacts, factCandidates } from "../derive/facts.js";
import {
  countFacts,
  decideFact,
  forgetFact,
  getFact,
  listFacts,
  recordFact,
} from "../store/facts.js";
import { detectKeychain } from "../kernel/keychain.js";
import { EXIT_CODES, HarborError } from "../kernel/errors.js";
import { formatBytes, formatDuration, humanWhen, timezone } from "../kernel/time.js";
import { authorize } from "../connectors/google/oauth.js";
import { fetchProfile } from "../connectors/google/gmail.js";
import { syncAccount } from "../connectors/dispatch.js";
import { listCalendars } from "../connectors/google/calendar.js";
import { accessToken } from "../connectors/google/oauth.js";
import {
  CONNECTORS,
  connectorById,
  connectorsFor,
  missingScopes,
  SOURCE_TYPES,
} from "../connectors/registry.js";
import { basicAuth, discover, discoverWith } from "../connectors/apple/dav.js";
import {
  available as imessageAvailable,
  chatDbPath,
  checkExtraction,
  inspect,
} from "../connectors/imessage/messages.js";
import { packCredential, probe } from "../connectors/imap/mail.js";
import { discoverImap } from "../connectors/imap/autoconfig.js";
import { createInterface } from "node:readline";
import {
  isKeychainBacked,
  listAccounts,
  moveCredentialsToKeychain,
  saveAccount,
  warmCredentials,
} from "../store/accounts.js";
import { countItems, readRaw } from "../store/items.js";
import { coverageByKind, coverageFor, databaseSize, rawStats } from "../store/coverage.js";
import { listStreams } from "../store/streams.js";
import { recentRuns } from "../store/syncruns.js";
import { mostRecent } from "../retrieval/search.js";
import { ask } from "../reasoning/ask.js";
import {
  allTurns,
  deleteConversation,
  getConversation,
  listConversations,
} from "../store/conversations.js";
import { cacheStats, clearDemotion, qualityStats } from "../reasoning/router.js";
import { formatCost, TASK_CLASSES } from "../reasoning/tasks.js";
import { classifyItems, countUnclassified, CLASSIFIER_VERSION, sensitivityBreakdown } from "../derive/classify.js";
import { classify } from "../policy/classify.js";
import { addRule, listRules, removeRule, setRuleEnabled } from "../policy/rules.js";
import { egressSince, recent, spend } from "../store/audit.js";
import {
  addSchedule,
  listSchedules,
  removeSchedule,
  setScheduleEnabled,
  SCHEDULABLE,
} from "../scheduler/schedule.js";
import { runTaskDirectly, startScheduler } from "../scheduler/runner.js";
import { startApi } from "../surfaces/api.js";
import { advertise } from "../surfaces/discovery.js";
import { currentFingerprint, ensureTls, tlsAvailable } from "../kernel/tls.js";
import { problems, setupState } from "../surfaces/setup.js";
import { enqueue, JOB_TASKS, stop, stopAll } from "../jobs/runner.js";
import {
  clearHandle,
  delegateJob,
  readHandle,
  stopViaDaemon,
  writeHandle,
} from "../kernel/daemon-handle.js";
import { getJob, listJobs } from "../store/jobs.js";
import { activeCodes, issueCode } from "../store/pairing.js";
import type { JobTask } from "../jobs/runner.js";
import { serveMcp } from "../surfaces/mcp.js";
import { listDevices, pairDevice, revokeDevice } from "../store/devices.js";
import { installInstructions, launchdPlist, systemdUnit } from "../kernel/service.js";
import { writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { ScheduledTask } from "../scheduler/schedule.js";
import { createEmbedder } from "../derive/embed/index.js";
import { derive, PIPELINE_VERSION, reindex } from "../derive/pipeline.js";
import { countPending, deriveStats } from "../store/chunks.js";
import { vectorBackend } from "../retrieval/vector.js";
import { ENTITY_VERSION, resolveEntities } from "../derive/entities.js";
import { composeBrief, dismissObservation, renderBrief, runDetectors, DEFAULT_BUDGET } from "../derive/brief.js";
import {
  addInterest,
  detectorStats,
  getObservation,
  listInterests,
  saveInterestEmbedding,
  setDetectorSuppressed,
  setInterestState,
} from "../store/signals.js";
import { toBlob } from "../derive/embed/index.js";
import {
  countPendingResolution,
  entityStats,
  identifiersFor,
  lookupEntities,
  mergeEntities,
  pinEntity,
  topEntities,
  unlinkIdentifier,
} from "../store/entities.js";
import { search } from "../retrieval/search.js";
import type { Embedder } from "../derive/embed/index.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import { nodeKey, parseNodeRef, summarize } from "../store/nodes.js";
import type { SyncMode } from "../connectors/engine.js";

const logger = createLogger("info");
const tz = timezone();

function when(ms: number | null): string {
  return ms === null ? "never" : humanWhen(ms, tz);
}

/**
 * How many records a command prints before it stops.
 *
 * Every list in here used to be unbounded, which is fine until `harbor people
 * cards` prints four hundred contacts and pushes the thing you were actually
 * reading out of the terminal's scrollback. A default ceiling with an honest
 * footer is strictly better: you can always ask for more, and you cannot
 * un-lose history.
 */
const PAGE = 25;

/**
 * Trims a list to a page and reports what was left out.
 *
 * The footer is not decoration. A truncated list that does not say it was
 * truncated is a list that quietly lies about what Harbor holds, which is the
 * one thing these commands exist to tell you.
 */
function page<T>(
  rows: readonly T[],
  options: { readonly limit?: string | undefined; readonly all?: boolean | undefined },
): { readonly shown: readonly T[]; readonly footer: string | null } {
  if (options.all === true) {
    return { shown: rows, footer: null };
  }

  const asked = options.limit === undefined ? Number.NaN : Number.parseInt(options.limit, 10);
  const limit = Number.isFinite(asked) && asked > 0 ? asked : PAGE;

  if (rows.length <= limit) {
    return { shown: rows, footer: null };
  }

  return {
    shown: rows.slice(0, limit),
    footer:
      `Showing ${String(limit)} of ${String(rows.length)}. ` +
      "`-n <count>` for more, `--all` for everything.",
  };
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * Semantic retrieval is a bonus, not a requirement. If no embedding backend is
 * reachable, say so once and carry on with keyword search rather than failing a
 * question the store can still mostly answer.
 */
async function optionalEmbedder(quiet = false): Promise<Embedder | undefined> {
  try {
    return await createEmbedder();
  } catch (error: unknown) {
    if (!quiet) {
      logger.warn(
        `no embedding backend, using keyword search only (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return undefined;
  }
}

/**
 * Reads a secret from the terminal without echoing it.
 *
 * An app-specific password pasted into a shell history or a process list is a
 * long-lived credential in a place it should not be, so it is prompted for
 * rather than accepted as a flag.
 */
async function promptHidden(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  const stdout = process.stdout as NodeJS.WriteStream & { _writeToOutput?: unknown };
  const original = (readline as unknown as { _writeToOutput?: (text: string) => void })
    ._writeToOutput;

  (readline as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (
    text: string,
  ): void => {
    stdout.write(text.includes(question) ? question : "");
  };

  const answer = await new Promise<string>((resolve) => {
    readline.question(question, (value) => {
      resolve(value);
    });
  });

  if (original !== undefined) {
    (readline as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = original;
  }

  readline.close();
  process.stdout.write("\n");

  return answer.trim();
}

async function prompt(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise<string>((resolve) => {
    readline.question(question, (value) => {
      resolve(value);
    });
  });

  readline.close();
  return answer.trim();
}

/**
 * iCloud pairing.
 *
 * No OAuth, no developer program, no cost. An app-specific password from
 * appleid.apple.com is the whole credential, and it is stored the same way an
 * OAuth refresh token is: in the accounts table, in one file, ready to move to
 * the keychain later.
 *
 * Discovery runs immediately so that a wrong password fails here with a clear
 * message rather than three commands later inside a sync.
 */
async function authenticateApple(checkOnly: boolean): Promise<void> {
  const { db } = openDatabase();

  try {
    const existing = listAccounts(db, "apple")[0];

    if (checkOnly) {
      if (existing === undefined) {
        logger.print("No Apple account connected. Run `harbor auth apple`.");
        return;
      }

      const found = await discoverWith(`Basic ${existing.credentials.accessToken}`);

      logger.print(`Apple ID       ${existing.label}`);
      logger.print(`Principal      ${found.principalUrl}`);
      logger.print(`Calendars      ${String(found.calendars.length)}`);

      for (const calendar of found.calendars) {
        logger.print(`  ${calendar.displayName}   ctag ${calendar.ctag ?? "none"}`);
      }

      logger.print(
        `Address books  ${found.addressBookHome === null ? "unavailable" : String(found.addressBooks.length)}`,
      );

      for (const book of found.addressBooks) {
        logger.print(`  ${book.displayName}`);
      }

      return;
    }

    logger.print("iCloud uses an app-specific password, not your Apple ID password.");
    logger.print("");
    logger.print("  1. https://appleid.apple.com -> Sign-In and Security");
    logger.print("  2. App-Specific Passwords -> generate one, call it Harbor");
    logger.print("  3. Paste it below. It is free and revocable from the same page.");
    logger.print("");
    logger.print("Two-factor authentication must be on. There is no developer");
    logger.print("program and no cost involved.");
    logger.print("");

    const appleId = await prompt("Apple ID (email): ");
    const appPassword = await promptHidden("App-specific password: ");

    if (appleId.length === 0 || appPassword.length === 0) {
      throw new HarborError("Both an Apple ID and an app-specific password are required", {
        code: "usage.missing_credentials",
        exitCode: EXIT_CODES.usage,
      });
    }

    logger.print("Checking with iCloud...");

    const found = await discover({ appleId, appPassword });

    const header = basicAuth({ appleId, appPassword });

    saveAccount(db, {
      sourceType: "apple",
      label: appleId,
      credentials: {
        // The Basic payload, so nothing has to hold the password in memory
        // again. Same shape as the OAuth record; `expiresAt: 0` means it never
        // expires on its own, which app-specific passwords do not.
        accessToken: header.replace(/^Basic /, ""),
        refreshToken: "",
        expiresAt: 0,
        scope: "caldav carddav",
      },
    });

    logger.print("");
    logger.print(`Connected      ${appleId}`);
    logger.print(`Calendars      ${String(found.calendars.length)}`);

    for (const calendar of found.calendars) {
      logger.print(`  ${calendar.displayName}`);
    }

    logger.print(
      `Address books  ${found.addressBookHome === null ? "unavailable" : String(found.addressBooks.length)}`,
    );

    for (const book of found.addressBooks) {
      logger.print(`  ${book.displayName}`);
    }

    logger.print("");
    logger.print("Next: harbor sync --backfill");
  } finally {
    db.close();
  }
}

/**
 * Connecting iMessage.
 *
 * No credential to store, so this is really a permission check with a receipt.
 * Proving access here means a Full Disk Access problem surfaces as one sentence
 * rather than as an empty store three commands later.
 */
/**
 * Connecting any IMAP mailbox.
 *
 * Asks for an address and a password, and works the server out itself, which is
 * what Thunderbird and Apple Mail have done for fifteen years. "Enter your
 * address and password" versus "enter your address, password, hostname, port,
 * and TLS mode" is the difference between a source most people can add and one
 * most people cannot.
 */
async function authenticateImap(
  address: string | undefined,
  hostOverride: string | undefined,
  portOverride: string | undefined,
): Promise<void> {
  const user = address ?? (await prompt("Email address: "));

  if (user.length === 0 || !user.includes("@")) {
    throw new HarborError("An email address is required", {
      code: "usage.missing_address",
      exitCode: EXIT_CODES.usage,
      hint: "harbor auth imap --address you@example.com",
    });
  }

  logger.print("Working out the server...");

  const discovered = await discoverImap(user);
  const host = hostOverride ?? discovered.host;
  const port = portOverride === undefined ? discovered.port : Number.parseInt(portOverride, 10);

  logger.print(`Server         ${host}:${String(port)} (${discovered.source})`);

  if (discovered.note !== undefined) {
    logger.print(`               ${discovered.note}`);
  }

  logger.print("");
  logger.print("Most providers need an app-specific password, not your account password.");
  logger.print("");

  const pass = await promptHidden("Password: ");

  if (pass.length === 0) {
    throw new HarborError("A password is required", {
      code: "usage.missing_password",
      exitCode: EXIT_CODES.usage,
    });
  }

  const credential = { host, port, secure: port === 993, user, pass };

  logger.print("Connecting...");

  const found = await probe(credential);
  const { db } = openDatabase();

  try {
    saveAccount(db, {
      sourceType: "imap",
      label: user,
      credentials: {
        accessToken: packCredential(credential),
        refreshToken: "",
        expiresAt: 0,
        scope: "imap",
      },
    });

    logger.print("");
    logger.print(`Connected      ${user}`);
    logger.print(`Messages       ${found.total.toLocaleString()}`);
    logger.print("");

    for (const folder of found.folders.slice(0, 10)) {
      logger.print(`  ${String(folder.messages).padStart(7)}  ${folder.path}`);
    }

    logger.print("");
    logger.print("Read only. Harbor cannot send mail.");
    logger.print("Next: harbor update");
  } finally {
    db.close();
  }
}

function connectMessages(): void {
  if (!imessageAvailable()) {
    throw new HarborError(`No iMessage database at ${chatDbPath()}`, {
      code: "precondition.no_imessage",
      exitCode: EXIT_CODES.precondition,
      hint:
        "iMessage only exists on macOS, and Harbor has to be running on the Mac that has it.",
    });
  }

  const { db } = openDatabase();

  try {
    const found = inspect();

    saveAccount(db, {
      sourceType: "imessage",
      label: "iMessage",
      credentials: { accessToken: "", refreshToken: "", expiresAt: 0, scope: "local" },
    });

    logger.print(`Database       ${chatDbPath()}`);
    logger.print(`Messages       ${found.total.toLocaleString()}`);
    logger.print("");
    logger.print("Busiest conversations");

    for (const chat of found.chats.slice(0, 8)) {
      logger.print(
        `  ${String(chat.messages).padStart(7)}  ${chat.isGroup ? "group" : "     "}  ${chat.name}`,
      );
    }

    logger.print("");
    logger.print("Read only. Harbor cannot send a message.");
    logger.print("Next: harbor sync --backfill");
  } finally {
    db.close();
  }
}

/**
 * The version in package.json, read at run time.
 *
 * Resolved from this file's own location rather than the working directory, so
 * `harbor` reports the build it is actually running whether it was invoked
 * through `npm link`, a global install, or `node dist/cli/main.js`. The literal
 * that used to be here read 0.17.0 for nine releases, which made the one
 * command a person runs to check what they are running the one command that
 * lied to them.
 */
function packageVersion(): string {
  try {
    const here = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
    const text = nodeFs.readFileSync(nodePath.join(here, "..", "..", "package.json"), "utf8");

    return (JSON.parse(text) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  loadEnv();

  const program = new Command();

  program
    .name("harbor")
    .description(
      "A local, private layer over your own digital life. Messages, mail, calendars, " +
        "and reminders, connected and reasoned over on this machine.",
    )
    // Read, not hardcoded. The literal that used to be here said 0.17.0 for
    // nine releases, which meant the one command a person runs to check what
    // they are running was the one command that lied to them.
    .version(packageVersion())
    .showHelpAfterError();

  // Credentials that live in the keychain are read once, before any command
  // runs. Every account reader in Harbor is synchronous and keychain access is
  // not, so resolving here keeps one async boundary in one place instead of
  // turning the whole store layer inside out. A store with no keychain-backed
  // accounts does no work at all.
  program.hook("preAction", async () => {
    try {
      const { db } = openDatabase();

      try {
        await warmCredentials(db);
      } finally {
        db.close();
      }
    } catch {
      // A command run before `harbor init` has no database yet. That is a
      // normal state, not a failure, and the command itself will say so.
    }
  });

  // The development surface.
  //
  // Nine of Harbor's commands are pipeline stages whose order matters and whose
  // names describe Harbor's internals rather than anything a person wants:
  // nobody outside this project knows what `relate` means, why `segment` comes
  // before `derive`, or that `commit` has nothing to do with git. They are real
  // and worth keeping, and they belong behind a prefix rather than in the list
  // somebody reads when they type `harbor`.
  //
  // Same code, same behaviour, honestly labelled.
  const dev = program
    .command("dev")
    .description("Pipeline stages and inspection tools, for working on Harbor itself");

  // How Harbor behaves, in one place.
  //
  // Schedules, egress policy, detectors, account weight, router tiers, spend,
  // interests, and secrets are all "how Harbor behaves", they are all rarely
  // touched, and each of them used to own a top-level verb. Eight groups a
  // person reads past to find the six they actually use.
  const settings = program
    .command("settings")
    .description("How Harbor behaves: schedules, policy, detectors, models, secrets");

  // Who is who.
  //
  // `person`, `merge`, `unlink`, and `rename` are all things you do to a person
  // and none of them deserved a verb of its own. `harbor people` still lists
  // them, because listing is what you want nine times out of ten.
  const people = program.command("people").description("Who Harbor knows about");

  // Nouns take an optional id.
  //
  // `commitments` and `commitment` were one verb wearing two hats, and so were
  // conversations, digests, facts, and purchases. Listing is what you want nine
  // times out of ten, so it stays the default and the rest become subcommands.
  const commitments = program.command("commitments").description("What you said would happen and has not happened yet");
  const conversations = program.command("conversations").description("What was discussed");
  const purchases = program.command("purchases").description("What was bought, and what it cost");
  const facts = program.command("facts").description("What Harbor knows about you");
  const digest = program.command("digest").description("The few things worth knowing");

  program
    .command("init")
    .description("Create the Harbor state directory and database")
    .action(() => {
      const { db, migrationsApplied, rulesSeeded } = openDatabase();
      const seeded = rulesSeeded;
      let scheduled = false;

      // A fresh store used to schedule nothing at all, so an unattended Harbor
      // did precisely nothing after the first manual run. For something meant
      // to sit in a closet, an empty schedule table is the wrong default: the
      // appliance should keep itself current and the owner should have to opt
      // out, not discover `harbor settings schedule` and opt in.
      //
      // Deliberately modest. A pulse often enough to feel live, the expensive
      // passes overnight, and one digest in the morning.
      const existingSchedules = listSchedules(db).length;

      if (existingSchedules === 0) {
        const tzNow = timezone();

        addSchedule(db, { principalId: DEFAULT_PRINCIPAL, task: "pulse", intervalMinutes: 15, timezone: tzNow });
        addSchedule(db, { principalId: DEFAULT_PRINCIPAL, task: "derive", atHour: 3, atMinute: 0, timezone: tzNow });
        addSchedule(db, { principalId: DEFAULT_PRINCIPAL, task: "commit", atHour: 3, atMinute: 30, timezone: tzNow });
        addSchedule(db, { principalId: DEFAULT_PRINCIPAL, task: "extract", atHour: 4, atMinute: 30, timezone: tzNow });
        addSchedule(db, { principalId: DEFAULT_PRINCIPAL, task: "notice", atHour: 5, atMinute: 0, timezone: tzNow });
        addSchedule(db, { principalId: DEFAULT_PRINCIPAL, task: "digest", atHour: 7, atMinute: 0, timezone: tzNow });
        addSchedule(db, { principalId: DEFAULT_PRINCIPAL, task: "backup", atHour: 4, atMinute: 0, timezone: tzNow });

        scheduled = true;
      }


      db.close();

      logger.print(`Harbor home    ${harborHome()}`);
      logger.print(`Timezone       ${tz}`);
      logger.print(
        `Migrations     ${migrationsApplied === 0 ? "already up to date" : `applied ${String(migrationsApplied)}`}`,
      );
      logger.print(
        `Policy         ${seeded === 0 ? "built-in rules present" : `seeded ${String(seeded)} built-in rules`}`,
      );
      if (scheduled) {
        logger.print("Schedules      pulse every 15m, derive and commit overnight, digest at 7am");
        logger.print("               (`harbor settings schedule` to change or disable any of it)");
      }

      logger.print("");
      logger.print("Next: connect a source. On a Mac, `harbor auth apple` and");
      logger.print("`harbor auth imessage` cost nothing and need no developer account.");
      logger.print("For other mail: `harbor auth imap --address you@example.com`.");
      logger.print("`harbor setup` shows what is left at any point.");
    });

  program
    .command("auth")
    .argument("<source>", `source to authenticate (${SOURCE_TYPES.join(", ")})`)
    .option("--check", "verify existing credentials without re-authenticating")
    .option("--address <email>", "for imap: the address to connect")
    .option("--host <hostname>", "for imap: override the discovered server")
    .option("--port <port>", "for imap: override the discovered port")
    .description("Authorize a source and store its credentials")
    .action(
      async (
        source: string,
        options: { check?: boolean; address?: string; host?: string; port?: string },
      ) => {
      if (!SOURCE_TYPES.includes(source)) {
        throw new HarborError(`Unknown source: ${source}`, {
          code: "usage.unknown_source",
          exitCode: EXIT_CODES.usage,
          hint: `Known sources: ${SOURCE_TYPES.join(", ")}`,
        });
      }

      if (source === "apple") {
        await authenticateApple(options.check === true);
        return;
      }

      if (source === "imessage") {
        connectMessages();
        return;
      }

      if (source === "imap") {
        await authenticateImap(options.address, options.host, options.port);
        return;
      }

      const { db } = openDatabase();

      try {
        logger.print("Opening your browser to authorize Gmail access (read only).");
        logger.print("");

        const credentials = await authorize((url) => {
          logger.print("If the browser did not open, visit:");
          logger.print(url);
          logger.print("");
        });

        const profile = await fetchProfile(credentials.accessToken);
        const account = saveAccount(db, {
          sourceType: "google",
          label: profile.emailAddress,
          credentials,
        });

        logger.print(`Connected      ${account.label}`);
        logger.print(`Account        ${account.id}`);
        logger.print(`Mailbox size   ${profile.messagesTotal.toLocaleString()} messages`);
        logger.print(
          `Connectors     ${connectorsFor("google")
            .map((connector) => connector.label)
            .join(", ")}`,
        );
        logger.print("");
        logger.print("Next: harbor sync --backfill");
      } finally {
        db.close();
      }
    });

  program
    .command("sync")
    .description("Pull data from every connected source")
    .option("--backfill", "full ingest of every stream (resumable)")
    .option("--incremental", "only what changed since the last sync")
    .option("-s, --source <id>", "limit to one connector (gmail, calendar)")
    .option("-c, --concurrency <count>", "parallel fetches", "3")
    .action(
      async (options: {
        backfill?: boolean;
        incremental?: boolean;
        source?: string;
        concurrency: string;
      }) => {
        const { db } = openDatabase();

        try {
          const accounts = listAccounts(db);

          if (accounts.length === 0) {
            throw new HarborError("No connected accounts", {
              code: "precondition.no_accounts",
              exitCode: EXIT_CODES.precondition,
              hint: `Run \`harbor auth ${SOURCE_TYPES[0] ?? "google"}\` first.`,
            });
          }

          if (options.source !== undefined && connectorById(options.source) === null) {
            throw new HarborError(`Unknown source: ${options.source}`, {
              code: "usage.unknown_connector",
              exitCode: EXIT_CODES.usage,
              hint: `Known connectors: ${CONNECTORS.map((entry) => entry.id).join(", ")}`,
            });
          }

          const mode: SyncMode =
            options.backfill === true
              ? "backfill"
              : options.incremental === true
                ? "incremental"
                : "auto";

          const concurrency = Number.parseInt(options.concurrency, 10);

          for (const account of accounts) {
            const missing =
              account.sourceType === "google"
                ? missingScopes("google", account.credentials.scope)
                : [];

            if (missing.length > 0) {
              logger.print(`${account.label}`);
              logger.print(
                `  This grant is missing ${plural(missing.length, "scope", "scopes")}, so some`,
              );
              logger.print(`  connectors cannot run. Re-run \`harbor auth google\` to add them.`);
              logger.print("");
            }

            let lastLine = "";

            const reports = await syncAccount(db, account, mode, {
              timezone: tz,
              concurrency: Number.isFinite(concurrency) ? concurrency : 3,
              ...(options.source === undefined ? {} : { only: options.source }),
              onNote: (message) => {
                process.stdout.write("\r".padEnd(48) + "\r");
                logger.print(`  note: ${message}`);
              },
              onProgress: (phase, done, total) => {
                const line =
                  total === null
                    ? `  ${phase} ${String(done)}`
                    : `  ${phase} ${String(done)}/${String(total)}`;
                if (line !== lastLine) {
                  lastLine = line;
                  process.stdout.write(`\r${line}          `);
                }
              },
            });

            process.stdout.write("\r".padEnd(48) + "\r");
            logger.print(`${account.label}`);

            for (const report of reports) {
              logger.print(
                `  ${report.connectorLabel}  (${report.mode}${report.resumed ? ", resumed" : ""})`,
              );
              logger.print(`    seen         ${String(report.upserted)}`);
              logger.print(`    new/changed  ${String(report.changed)}`);
              logger.print(`    unchanged    ${String(report.unchanged)}`);
              if (report.tombstoned > 0) {
                logger.print(`    tombstoned   ${String(report.tombstoned)}`);
              }
              logger.print(`    took         ${formatDuration(report.durationMs)}`);
              if (report.complete) {
                logger.print(`    full ingest  complete`);
              }
            }
          }

          logger.print("");
          logger.print(
            `Stored         ${String(countItems(db))} items, ${formatBytes(databaseSize(db))} on disk`,
          );
        } finally {
          db.close();
        }
      },
    );

  dev
    .command("calendars")
    .description("List the calendars Harbor can see")
    .action(async () => {
      const { db } = openDatabase();

      try {
        for (const account of listAccounts(db, "google")) {
          const token = await accessToken(db, account);
          logger.print(`${account.label}  (Google)`);

          for (const calendar of await listCalendars(token)) {
            logger.print(
              `  ${calendar.primary === true ? "*" : " "} ${calendar.summary ?? calendar.id}` +
                `  (${calendar.accessRole ?? "unknown"})`,
            );
          }
        }

        for (const account of listAccounts(db, "apple")) {
          logger.print(`${account.label}  (iCloud)`);

          const found = await discoverWith(`Basic ${account.credentials.accessToken}`);

          for (const calendar of found.calendars) {
            logger.print(`    ${calendar.displayName}`);
          }

          for (const book of found.addressBooks) {
            logger.print(`    ${book.displayName}  (contacts)`);
          }
        }
      } finally {
        db.close();
      }
    });

  program
    .command("ask")
    .argument("<question...>", "what you want to know")
    .description("Answer a question from your stored data")
    .option("--evidence", "list every item the model was shown")
    .option("--trace", "print each tool call as it happens")
    .option("--new", "start a fresh conversation instead of continuing")
    .option("-c, --conversation <id>", "continue a specific conversation")
    .action(
      async (
        parts: string[],
        options: {
          evidence?: boolean;
          trace?: boolean;
          new?: boolean;
          conversation?: string;
        },
      ) => {
      const { db } = openDatabase();

      try {
        if (countItems(db) === 0) {
          throw new HarborError("The store is empty", {
            code: "precondition.empty_store",
            exitCode: EXIT_CODES.precondition,
            hint: "Run `harbor sync` first.",
          });
        }

        const embedder = await optionalEmbedder();
        const question = parts.join(" ");

        const result = await ask(db, question, {
          principal: DEFAULT_PRINCIPAL,
          timezone: tz,
          ...(embedder === undefined ? {} : { embedder }),
          ...(options.new === true
            ? { conversation: "new" as const }
            : options.conversation === undefined
              ? {}
              : { conversation: options.conversation }),
          ...(options.trace === true
            ? {
                onToolCall: (name: string, input: Record<string, unknown>): void => {
                  logger.print(`  [tool] ${name} ${JSON.stringify(input)}`);
                },
              }
            : {}),
        });

        logger.print("");
        logger.print(result.answer);
        logger.print("");
        logger.print(
          `  ${result.model} (${result.tier}) | ` +
            `${plural(result.toolCalls, "tool call", "tool calls")} | ` +
            `${String(result.usage.inputTokens)} in / ${String(result.usage.outputTokens)} out | ` +
            formatCost(result.costMicros) +
            ` | ${result.continued ? "continuing" : "new"} ${result.conversationId}`,
        );

        if (result.withheld > 0 || result.redactions > 0) {
          logger.print(
            `  policy: ${String(result.withheld)} withheld, ${String(result.redactions)} redacted`,
          );
        }

        if (options.evidence === true) {
          logger.print("");
          logger.print(`  evidence (${plural(result.evidence.length, "item", "items")}):`);
          for (const id of result.evidence) {
            logger.print(`    ${id}`);
          }
        }
      } finally {
        db.close();
      }
      },
    );

  dev
    .command("imessage")
    .argument("[action]", "check")
    .description("Diagnose iMessage text extraction on this Mac")
    .option("-n, --sample <count>", "how many recent messages to test", "400")
    .action((_action: string | undefined, options: { sample: string }) => {
      if (!imessageAvailable()) {
        logger.print(`No message database at ${chatDbPath()}.`);
        return;
      }

      const count = Number.parseInt(options.sample, 10);
      const report = checkExtraction(Number.isFinite(count) ? count : 400);

      logger.print(`Sampled        ${String(report.sampled)} recent messages`);
      logger.print(`Plain text     ${String(report.plainText)}`);
      logger.print(`Decoded        ${String(report.fromAttributed)}`);
      logger.print(`Unreadable     ${String(report.unreadable)}`);

      const readable = report.plainText + report.fromAttributed;
      const total = readable + report.unreadable;

      logger.print("");

      if (total === 0) {
        logger.print("Nothing with text in the sample.");
        return;
      }

      if (report.unreadable === 0) {
        logger.print("All good.");
        return;
      }

      logger.print(
        `${String(Math.round((readable / total) * 100))}% readable. ` +
          "The rest use an archive layout Harbor does not recognise.",
      );
      logger.print("");
      logger.print("Send this sample so the format can be added:");
      logger.print("");
      logger.print(report.sample ?? "(none)");
    });

  program
    .command("situations")
    .description("Things spanning more than one source")
    .option("-n, --limit <count>", "how many", "10")
    .option("--days <days>", "only those active in the last N days")
    .action((options: { limit: string; days?: string }) => {
      const { db } = openDatabase();

      try {
        const limit = Number.parseInt(options.limit, 10);
        const days = options.days === undefined ? null : Number.parseInt(options.days, 10);

        const found = topThreads(db, DEFAULT_PRINCIPAL, {
          limit: Number.isFinite(limit) ? limit : 10,
          minSources: 2,
          ...(days === null || !Number.isFinite(days)
            ? {}
            : { since: Date.now() - days * 86_400_000 }),
        });

        if (found.length === 0) {
          logger.print("Nothing spanning more than one source yet.");
          logger.print("Needs `harbor dev relate` to have run, and more than one source connected.");
          return;
        }

        for (const thread of found) {
          logger.print(`${thread.title ?? "(unnamed)"}`);
          logger.print(
            `  ${String(thread.itemCount)} things across ${String(thread.sourceCount)} sources` +
              `  ${when(thread.startsAt)} to ${when(thread.endsAt)}`,
          );

          for (const ref of threadNodes(db, thread.id).slice(0, 6)) {
            const node = summarize(db, ref);

            if (node === null) {
              continue;
            }

            const size =
              ref.kind === "episode" ? ` (${String(node.itemIds.length)} messages)` : "";

            logger.print(
              `    ${node.kind.padEnd(12)} ${when(node.occurredAt).padEnd(24)} ` +
                `${(node.title ?? "").slice(0, 40)}${size}`,
            );
          }

          logger.print("");
        }
      } finally {
        db.close();
      }
    });

  program
    .command("related")
    .argument("<id>", "item id")
    .description("Everything connected to one item, and why")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        const ref = parseNodeRef(id);
        const edges = connectionsFor(db, ref);

        if (edges.length === 0) {
          logger.print("Nothing connected to that.");
          logger.print("`harbor why <id>` says what was considered and why it was not linked.");
          return;
        }

        for (const edge of edges) {
          const other = summarize(db, edge.to);

          if (other === null) {
            continue;
          }

          logger.print(`${other.kind.padEnd(12)} ${(other.title ?? "").slice(0, 52)}`);
          logger.print(`  ${when(other.occurredAt)}   ${nodeKey(other.ref)}`);
          logger.print(`  ${edge.evidence}  (${edge.kind}, ${edge.confidence.toFixed(2)})`);

          for (const also of edge.also) {
            logger.print(`  and ${also}`);
          }
        }
      } finally {
        db.close();
      }
    });

  dev
    .command("extract")
    .description("Pull structured facts out of receipts and confirmations")
    .option("--dry-run", "show what would be read, and spend nothing")
    .option("-n, --limit <count>", "items to read, default 50")
    .action(async (options: { dryRun?: boolean; limit?: string }) => {
      const { db } = openDatabase();

      try {
        const limit = options.limit === undefined ? 50 : Number.parseInt(options.limit, 10);
        const budget = Number.isFinite(limit) ? limit : 50;

        // Free, and the number that matters most before starting. On a mailbox
        // that is mostly marketing, this is the difference between reading two
        // hundred items and reading thirty thousand.
        if (options.dryRun === true) {
          const candidates = purchaseCandidates(db, budget);

          logger.print(`${String(candidates.length)} items look like receipts:`);
          logger.print("");

          for (const candidate of candidates) {
            logger.print(`  ${when(candidate.occurredAt)}  ${(candidate.title ?? "").slice(0, 56)}`);
            logger.print(`    ${(candidate.author ?? "").slice(0, 70)}`);
          }

          logger.print("");
          logger.print("Read this list before running for real. If it is full of marketing,");
          logger.print("the predicate is too loose and should be tightened first.");
          return;
        }

        const report = await extractPurchases(db, {
          principalId: DEFAULT_PRINCIPAL,
          limit: budget,
          onNote: (message) => {
            logger.print(`  note: ${message}`);
          },
        });

        logger.print(`Considered     ${String(report.considered)}`);
        logger.print(`Read           ${String(report.read)}`);
        logger.print(`Purchases      ${String(report.written)}`);
        logger.print(`Not purchases  ${String(report.notPurchases)} (read, and correctly declined)`);

        if (report.rejected.length > 0) {
          logger.print(`Rejected       ${String(report.rejected.length)} that failed verification`);

          for (const reason of report.rejected.slice(0, 5)) {
            logger.print(`  ${reason}`);
          }
        }

        if (report.model !== null) {
          logger.print(
            `Model          ${report.model} via ${report.tier ?? "?"} (${formatCost(report.costMicros)})`,
          );
        }

        logger.print(`Remaining      ${String(report.remaining)} items`);
        logger.print(`Took           ${formatDuration(report.durationMs)}`);
      } finally {
        db.close();
      }
    });

  purchases
    .command("list", { isDefault: true })
    .description("What has been bought, most recent first")
    .option("--days <count>", "how far back, default 90")
    .option("--merchant <name>", "narrow to one merchant")
    .option("-n, --limit <count>", "how many, default 30")
    .action((options: { days?: string; merchant?: string; limit?: string }) => {
      const { db } = openDatabase();

      try {
        const days = options.days === undefined ? 90 : Number.parseInt(options.days, 10);
        const limit = options.limit === undefined ? 30 : Number.parseInt(options.limit, 10);

        const found = listProjections(db, {
          principalId: DEFAULT_PRINCIPAL,
          type: "purchase",
          since: Date.now() - (Number.isFinite(days) ? days : 90) * 86_400_000,
          ...(options.merchant === undefined ? {} : { merchant: options.merchant }),
          limit: Number.isFinite(limit) ? limit : 30,
        });

        if (found.length === 0) {
          logger.print("No purchases. Run `harbor dev extract --dry-run` to see what would be read.");
          return;
        }

        for (const purchase of found) {
          const amount =
            purchase.totalCents === null
              ? "        "
              : `${(purchase.totalCents / 100).toFixed(2)}`.padStart(9);

          logger.print(
            `${amount} ${(purchase.currency ?? "").padEnd(4)} ${(purchase.merchant ?? "unknown").slice(0, 30).padEnd(30)} ${when(purchase.occurredAt)}`,
          );

          for (const line of linesFor(db, purchase.id).slice(0, 4)) {
            const each = line.amountCents === null ? "" : ` ${(line.amountCents / 100).toFixed(2)}`;
            logger.print(`            ${line.description.slice(0, 50)}${each}`);
          }
        }
      } finally {
        db.close();
      }
    });

  purchases
    .command("merchants")
    .description("What has been spent, grouped by merchant")
    .option("--days <count>", "how far back, default 90")
    .action((options: { days?: string }) => {
      const { db } = openDatabase();

      try {
        const days = options.days === undefined ? 90 : Number.parseInt(options.days, 10);
        const since = Date.now() - (Number.isFinite(days) ? days : 90) * 86_400_000;

        const rows = spendByMerchant(db, DEFAULT_PRINCIPAL, since, Date.now());

        if (rows.length === 0) {
          logger.print("Nothing to add up yet.");
          return;
        }

        let total = 0;

        for (const row of rows) {
          total += row.totalCents;

          logger.print(
            `${(row.totalCents / 100).toFixed(2).padStart(10)} ${(row.currency ?? "").padEnd(4)} ` +
              `${row.merchant.slice(0, 34).padEnd(34)} ${String(row.count)} purchase${row.count === 1 ? "" : "s"}`,
          );
        }

        logger.print("");
        logger.print(`${(total / 100).toFixed(2).padStart(10)}      across ${String(rows.length)} merchants`);
        logger.print("");
        // Said plainly, because a spending total that quietly omits what it
        // could not read is worse than one that admits the gap.
        logger.print("Only receipts Harbor could read and verify are counted here.");
      } finally {
        db.close();
      }
    });

  dev
    .command("attachments")
    .argument("[item]", "an item id, to list just its files")
    .description("Files that arrived with your mail, and what text came out of them")
    .action((item: string | undefined) => {
      const { db } = openDatabase();

      try {
        if (item !== undefined) {
          const found = attachmentsFor(db, item);

          if (found.length === 0) {
            logger.print("No attachments on that item.");
            return;
          }

          for (const attachment of found) {
            logger.print(`${attachment.filename ?? "(unnamed)"}  ${attachment.mime ?? ""}`);
            logger.print(
              `  ${String(Math.round(attachment.sizeBytes / 1024))} KB, ` +
                `${attachment.textLength === 0 ? "no text" : `${String(attachment.textLength)} chars extracted`}` +
                `${attachment.error === null ? "" : `  (${attachment.error})`}`,
            );
          }

          return;
        }

        const summary = attachmentSummary(db);

        if (summary.total === 0) {
          logger.print("No attachments yet. They are captured during mail sync.");
          return;
        }

        logger.print(`Attachments    ${String(summary.total)}`);
        logger.print(`  with text    ${String(summary.withText)}`);
        logger.print(`  unreadable   ${String(summary.failed)}`);
        logger.print(`  original size ${String(Math.round(summary.bytes / 1_048_576))} MB (bytes are not stored)`);
        logger.print("");

        for (const type of summary.byType) {
          logger.print(`  ${type.mime.slice(0, 40).padEnd(40)} ${String(type.count)}`);
        }
      } finally {
        db.close();
      }
    });

  digest
    .command("list", { isDefault: true })
    .description("The few things worth knowing, delivered")
    .option("--preview", "compose without recording or suppressing anything")
    .option("--notify", "also send a local notification")
    .option("--last", "show the last digest instead of composing a new one")
    .option("-n, --budget <count>", "how many things, at most")
    .action(async (options: { preview?: boolean; notify?: boolean; last?: boolean; budget?: string }) => {
      const { db } = openDatabase();

      try {
        if (options.last === true) {
          const previous = latestDigest(db, DEFAULT_PRINCIPAL);

          if (previous === null) {
            logger.print("No digest yet.");
            return;
          }

          logger.print(`${when(previous.createdAt)}${previous.deliveredAt === null ? "" : "  (delivered)"}`);
          logger.print("");
          logger.print(previous.text);
          return;
        }

        const budget = options.budget === undefined ? undefined : Number.parseInt(options.budget, 10);

        const report = await produceDigest(db, {
          principalId: DEFAULT_PRINCIPAL,
          timezone: timezone(),
          ...(budget === undefined || !Number.isFinite(budget) ? {} : { budget }),
          ...(options.preview === true ? { preview: true } : {}),
          ...(options.notify === true ? { notify: true } : {}),
        });

        if (report.skipped !== null) {
          logger.print(report.skipped === "nothing worth saying"
            ? "Nothing worth interrupting you about."
            : `Skipped: ${report.skipped}`);
          return;
        }

        logger.print(renderBrief(report.brief));

        if (options.notify === true) {
          logger.print(report.notified ? "" : "(notification not delivered on this platform)");
        }
      } finally {
        db.close();
      }
    });

  digest
    .command("history")
    .description("What Harbor has said recently")
    .action(() => {
      const { db } = openDatabase();

      try {
        const found = recentDigests(db, DEFAULT_PRINCIPAL, 10);

        if (found.length === 0) {
          logger.print("Nothing said yet.");
          return;
        }

        for (const digest of found) {
          logger.print(
            `${when(digest.createdAt).padEnd(24)} ${String(digest.entryCount)} things` +
              `${digest.deliveredAt === null ? "" : `  via ${digest.channel ?? "unknown"}`}`,
          );
        }
      } finally {
        db.close();
      }
    });

  settings
    .command("weight")
    .argument("[account]", "account id, or a provider name. Omit to list.")
    .argument("[value]", "0 to 2. Lower means less likely to be surfaced.")
    .description("How much an account's mail is worth interrupting you about")
    .action((account: string | undefined, value: string | undefined) => {
      const { db } = openDatabase();

      try {
        if (account === undefined || value === undefined) {
          const rows = db
            .prepare(`SELECT id, source_type, label, weight FROM accounts ORDER BY source_type`)
            .all() as { id: string; source_type: string; label: string | null; weight: number }[];

          for (const row of rows) {
            logger.print(
              `${row.weight.toFixed(1)}  ${row.source_type.padEnd(16)} ${row.label ?? ""}  ${row.id}`,
            );
          }

          return;
        }

        const parsed = Number.parseFloat(value);

        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
          logger.print("Weight must be between 0 and 2.");
          return;
        }

        // Matched by id or provider, because nobody remembers an account id and
        // "the google one" is what a person actually means.
        const changed = db
          .prepare(`UPDATE accounts SET weight = ? WHERE id = ? OR source_type = ?`)
          .run(parsed, account, account).changes;

        logger.print(
          changed === 0
            ? "No account matched."
            : `${String(changed)} account(s) set to ${parsed.toFixed(1)}. This affects what gets surfaced, not what Harbor can find.`,
        );
      } finally {
        db.close();
      }
    });

  commitments
    .command("list", { isDefault: true })
    .description("What has been said would happen and has not happened yet")
    .option("--all", "include done, lapsed, and cancelled")
    .option("--lapsed", "only the ones nothing has touched since they were due")
    .option("-n, --limit <count>", "how many, default 40")
    .action((options: { all?: boolean; lapsed?: boolean; limit?: string }) => {
      const { db } = openDatabase();

      try {
        const limit = options.limit === undefined ? 40 : Number.parseInt(options.limit, 10);

        const states =
          options.all === true
            ? (["stated", "scheduled", "done", "lapsed", "cancelled"] as const)
            : options.lapsed === true
              ? (["lapsed"] as const)
              : (["stated", "scheduled"] as const);

        const found = listCommitments(db, {
          principalId: DEFAULT_PRINCIPAL,
          states: [...states],
          limit: Number.isFinite(limit) ? limit : 40,
        });

        if (found.length === 0) {
          logger.print("Nothing on the books. Run `harbor dev commit` after syncing.");
          return;
        }

        const now = Date.now();

        for (const commitment of found) {
          const at = commitment.dueAt ?? commitment.occursAt;
          const late = at !== null && at < now && commitment.state !== "done";

          const marker =
            commitment.state === "done"
              ? "done "
              : commitment.state === "lapsed"
                ? "lapsed"
                : late
                  ? "late  "
                  : commitment.state === "scheduled"
                    ? "sched "
                    : "      ";

          const who = commitment.owner === "me" ? "" : ` (${commitment.owner})`;
          const repeats = commitment.recurring ? " repeats" : "";

          logger.print(
            `${marker} ${commitment.title.slice(0, 50).padEnd(50)}${who} ${at === null ? "no date" : when(at)}`,
          );
          logger.print(`       ${commitment.id}  from ${commitment.origin}${repeats}`);
        }

        const counts = countCommitments(db);
        logger.print("");
        logger.print(`${String(counts.open)} open of ${String(counts.total)} total`);
      } finally {
        db.close();
      }
    });

  commitments
    .command("show")
    .argument("<id>", "commitment id")
    .description("One commitment and every source that contributed to it")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        const commitment = getCommitment(db, id);

        if (commitment === null) {
          logger.print("No such commitment.");
          return;
        }

        logger.print(commitment.title);
        logger.print(`  state        ${commitment.state}`);
        logger.print(`  owner        ${commitment.owner}`);
        logger.print(`  due          ${commitment.dueAt === null ? "none stated" : when(commitment.dueAt)}`);
        if (commitment.occursAt !== null) {
          logger.print(`  scheduled    ${when(commitment.occursAt)}`);
        }
        logger.print(`  confidence   ${commitment.confidence.toFixed(2)}`);
        if (commitment.closedReason !== null) {
          logger.print(`  closed       ${commitment.closedReason}`);
        }
        logger.print("");
        logger.print("Evidence");

        for (const record of evidenceFor(db, commitment.id)) {
          logger.print(`  ${record.role.padEnd(10)} ${when(record.occurredAt)}`);
          logger.print(`             ${record.note}`);
          logger.print(`             ${record.itemId ?? record.episodeId ?? ""}`);
        }
      } finally {
        db.close();
      }
    });

  dev
    .command("commit")
    .description("Build commitments from reminders, conversations, and the calendar")
    .option("--dry-run", "show what would be read, and spend nothing")
    .option("-n, --limit <count>", "conversations to read, default 25")
    .action(async (options: { dryRun?: boolean; limit?: string }) => {
      const { db } = openDatabase();

      try {
        const limit = options.limit === undefined ? 25 : Number.parseInt(options.limit, 10);
        const budget = Number.isFinite(limit) ? limit : 25;

        // The dry run is the whole reason candidate detection is deterministic.
        // Before a single model call, the number of calls a real run would make
        // is knowable, and so is which conversations they would be.
        if (options.dryRun === true) {
          const candidates = intentCandidates(db, budget);

          logger.print(`${String(candidates.length)} conversations would be read:`);
          logger.print("");

          for (const candidate of candidates) {
            logger.print(`  ${when(candidate.endsAt)}  ${candidate.participants.join(", ")}`);
            logger.print(`    ${candidate.preview}`);
          }

          logger.print("");
          logger.print("Reminders and calendar matching cost nothing and run either way.");
          return;
        }

        const report = await buildCommitments(db, {
          principalId: DEFAULT_PRINCIPAL,
          limit: budget,
          onNote: (message) => {
            logger.print(`  note: ${message}`);
          },
        });

        logger.print(`Reminders      ${String(report.remindersRead)}`);
        logger.print(`Conversations  ${String(report.episodesRead)} read of ${String(report.episodesConsidered)} flagged`);
        logger.print(`Created        ${String(report.created)}`);
        logger.print(`Merged         ${String(report.merged)} into commitments that already existed`);
        logger.print(`Scheduled      ${String(report.scheduled)} matched to a calendar entry`);
        logger.print(`Closed         ${String(report.closed)}`);
        logger.print(`Lapsed         ${String(report.lapsed)}`);

        if (report.rejected.length > 0) {
          logger.print(`Rejected       ${String(report.rejected.length)} extractions that failed verification`);

          for (const reason of report.rejected.slice(0, 5)) {
            logger.print(`  ${reason}`);
          }
        }

        if (report.model !== null) {
          logger.print(`Model          ${report.model} (${formatCost(report.costMicros)})`);
        }

        logger.print(`Remaining      ${String(report.remaining)} conversations`);
        logger.print(`Took           ${formatDuration(report.durationMs)}`);
      } finally {
        db.close();
      }
    });

  dev
    .command("segment")
    .description("Group messages into conversation episodes (no model calls)")
    .option("-n, --limit <count>", "stop after this many conversations")
    .action((options: { limit?: string }) => {
      const { db } = openDatabase();

      try {
        const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);

        // Deliberately separate from `derive`, which needs an embedding server.
        // Segmentation is pure text handling, so a store with no local model
        // still gets conversations and keyword search over them.
        const report = segmentEpisodes(db, {
          principalId: DEFAULT_PRINCIPAL,
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
        });

        logger.print(`Conversations  ${String(report.threadsExamined)} examined`);
        logger.print(`Episodes       ${String(report.episodesWritten)}`);
        if (report.episodesReplaced > 0) {
          logger.print(`  replaced     ${String(report.episodesReplaced)} that grew or re-split`);
        }
        logger.print(`Messages       ${String(report.messagesCovered)}`);
        logger.print(`Remaining      ${String(report.remaining)}`);
      } finally {
        db.close();
      }
    });

  conversations
    .command("list", { isDefault: true })
    .argument("[query]", "what the conversation was about")
    .description("Search conversations rather than individual messages")
    .option("-n, --limit <count>", "how many, default 6")
    .action(async (query: string | undefined, options: { limit?: string }) => {
      const { db } = openDatabase();

      try {
        const embedder = await optionalEmbedder();
        const limit = options.limit === undefined ? 6 : Number.parseInt(options.limit, 10);

        const hits = await searchEpisodes(db, {
          principal: DEFAULT_PRINCIPAL,
          ...(query === undefined ? {} : { query }),
          limit: Number.isFinite(limit) ? limit : 6,
          ...(embedder === undefined ? {} : { embedder }),
        });

        if (hits.length === 0) {
          logger.print("No conversations. Run `harbor dev derive` after syncing a message source.");
          return;
        }

        for (const hit of hits) {
          logger.print(`${hit.episode.id}`);
          logger.print(
            `  ${hit.episode.participants.join(", ") || "unknown"}  ${String(hit.episode.messageCount)} messages`,
          );
          logger.print(`  ${when(hit.episode.startsAt)} to ${when(hit.episode.endsAt)}`);
          logger.print(`  ${hit.episode.transcript.split("\n")[0]?.slice(0, 78) ?? ""}`);
          logger.print(`  matched: ${hit.reasons.join(", ")}`);
          logger.print("");
        }
      } finally {
        db.close();
      }
    });

  conversations
    .command("show")
    .argument("<id>", "episode id")
    .description("The full transcript of one conversation")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        const episode = getEpisode(db, id);

        if (episode === null) {
          logger.print("No such conversation.");
          return;
        }

        logger.print(`${episode.participants.join(", ") || "unknown"}`);
        logger.print(`${when(episode.startsAt)} to ${when(episode.endsAt)}`);
        logger.print(`${String(episode.messageCount)} messages, ${String(episodeItems(db, id).length)} still present`);
        logger.print("");
        logger.print(episode.transcript);
      } finally {
        db.close();
      }
    });

  program
    .command("reminders")
    .description("What you have not done, by due date")
    .option("--all", "include completed ones")
    .option("-n, --limit <count>", "how many, default 30")
    .action((options: { all?: boolean; limit?: string }) => {
      const { db } = openDatabase();

      try {
        const limit = options.limit === undefined ? 30 : Number.parseInt(options.limit, 10);

        const rows = db
          .prepare(
            `SELECT id, title, snippet, state, due_at, occurred_at, recurrence FROM items
             WHERE kind = 'task' AND deleted_at IS NULL
               AND (@all = 1 OR state IS NULL OR state <> 'completed')
             ORDER BY COALESCE(due_at, occurred_at) ASC
             LIMIT @limit`,
          )
          .all({ all: options.all === true ? 1 : 0, limit: Number.isFinite(limit) ? limit : 30 }) as {
          id: string;
          title: string | null;
          snippet: string | null;
          state: string | null;
          due_at: number | null;
          occurred_at: number;
          recurrence: string | null;
        }[];

        if (rows.length === 0) {
          logger.print("Nothing open. Either you are on top of things or Reminders is not connected.");
          return;
        }

        const now = Date.now();

        for (const row of rows) {
          const due = row.due_at ?? row.occurred_at;
          // Overdue is the only thing a list of reminders needs to shout about.
          const flag = row.state === "completed" ? "done " : due < now ? "late " : "     ";

          const repeats = row.recurrence === null || row.recurrence.length === 0 ? "" : "  repeats";

          logger.print(
            `${flag}${(row.title ?? "").slice(0, 56).padEnd(56)} ${when(due)}${repeats}`,
          );

          if (row.snippet !== null && row.snippet.length > 0) {
            logger.print(`      ${row.snippet}`);
          }
        }
      } finally {
        db.close();
      }
    });

  // Why one thing is connected to what it is, and why it is not connected to
  // the rest.
  //
  // Promoted from a flag on `relate` to a command of its own, because it is not
  // a mode of running the pass: it writes nothing, it is the first thing to
  // reach for when an answer looks wrong, and it was previously reachable only
  // by knowing that a pipeline stage had an option on it.
  program
    .command("why")
    .argument("<id>", "an item id, or an episode id beginning ep_")
    .option("-n, --limit <count>", "how many candidates to show")
    .option("--all", "every candidate considered")
    .option("--linked", "only the ones an edge was actually drawn to")
    .description("Why Harbor connected something to what it did, and what it passed over")
    .action((id: string, options: { limit?: string; all?: boolean; linked?: boolean }) => {
      const { db } = openDatabase();

      try {
        const result = explain(db, parseNodeRef(id), DEFAULT_PRINCIPAL, timezone());

        if (result === null) {
          logger.print("No such item or conversation.");
          return;
        }

        logger.print(`${result.subject.kind}  ${(result.subject.title ?? "").slice(0, 60)}`);
        logger.print(`  ${when(result.subject.occurredAt)}`);
        logger.print(`  people       ${result.people.join(", ") || "none resolved"}`);
        logger.print(`  references   ${result.references.join(", ") || "none"}`);
        logger.print(
          `  rare words   ${result.distinctive.slice(0, 10).join(", ") || "none distinctive enough"}`,
        );

        for (const note of result.notes) {
          logger.print(`  note         ${note}`);
        }

        const considered =
          options.linked === true
            ? result.candidates.filter((candidate) => candidate.drawn.length > 0)
            : result.candidates;

        const { shown, footer } = page(considered, options);

        logger.print("");
        logger.print(
          `${String(result.candidates.length)} candidates considered, ` +
            `${String(result.candidates.filter((entry) => entry.drawn.length > 0).length)} linked`,
        );

        for (const candidate of shown) {
          const cross = candidate.sameStream ? "" : "  [cross-source]";
          logger.print("");
          logger.print(
            `  ${candidate.kind.padEnd(12)} ${(candidate.title ?? "").slice(0, 48)}${cross}`,
          );
          logger.print(`    ${when(candidate.occurredAt)}   found via ${candidate.via.join(", ")}`);

          for (const edge of candidate.drawn) {
            logger.print(`    drawn    ${edge.kind}: ${edge.evidence}`);
          }

          for (const rejection of candidate.rejected) {
            logger.print(`    no edge  ${rejection.linker}: ${rejection.reason}`);
          }

          if (candidate.drawn.length === 0 && candidate.rejected.length === 0) {
            logger.print("    no edge  no linker applies to this pair");
          }
        }

        if (footer !== null) {
          logger.print("");
          logger.print(`${footer} \`--linked\` for only what connected.`);
        }
      } finally {
        db.close();
      }
    });

  dev
    .command("relate")
    .description("Connect items and conversations across sources into situations")
    .option("-n, --limit <count>", "stop after this many nodes")
    .option("--rebuild", "throw away every edge and draw the whole graph again")
    .action((options: { limit?: string; rebuild?: boolean }) => {
      const { db } = openDatabase();

      try {
        const tz = timezone();

        if (options.rebuild === true) {
          const edges = clearEdges(db);
          const items = resetRelationshipVersions(db);
          logger.print(
            `Cleared ${String(edges)} edges, ${String(items)} items queued for redrawing.`,
          );
        }

        const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);
        let lastLine = "";

        const report = relate(db, {
          principalId: DEFAULT_PRINCIPAL,
          timezone: tz,
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
          onNote: (message) => {
            process.stdout.write("\r".padEnd(48) + "\r");
            logger.print(`  note: ${message}`);
          },
          onProgress: (done, total) => {
            const line = `  ${String(done)}/${String(total)} items`;
            if (line !== lastLine) {
              lastLine = line;
              process.stdout.write(`\r${line}          `);
            }
          },
        });

        process.stdout.write("\r".padEnd(48) + "\r");

        logger.print(`Nodes examined ${String(report.nodesExamined)}`);
        logger.print(`Candidates     ${String(report.candidatesConsidered)}`);
        logger.print(`References     ${String(report.references)}`);
        logger.print(`Edges drawn    ${String(report.edgesDrawn)} (${String(report.totalEdges)} total)`);
        logger.print(`Cross-source   ${String(report.crossSource)}, the number that matters`);

        for (const kind of report.byKind) {
          logger.print(`  ${kind.kind.padEnd(18)} ${String(kind.count)}`);
        }

        logger.print(`Situations     ${String(report.threads.threads)} across more than one source`);
        logger.print(`Remaining      ${String(report.remaining)}`);
        logger.print(`Took           ${formatDuration(report.durationMs)}`);
      } finally {
        db.close();
      }
    });

  people
    .command("cards")
    .argument("[query]", "narrow to cards whose name matches")
    .option("-n, --limit <count>", "how many to show")
    .option("--all", "every card, however many that is")
    .option("--stranded", "only cards with nothing Harbor can anchor to")
    .description("Every contact card and what Harbor could read from it")
    .action((query: string | undefined, options: { limit?: string; all?: boolean; stranded?: boolean }) => {
      const { db } = openDatabase();

      try {
        const found = inspectCards(db, query);

        const cards =
          options.stranded === true
            ? found.filter((card) => card.emails.length + card.phones.length === 0)
            : found;

        if (cards.length === 0) {
          logger.print(query === undefined ? "No contact cards stored." : `No card matching "${query}".`);
          return;
        }

        const { shown, footer } = page(cards, options);

        for (const card of shown) {
          logger.print(`${card.title ?? "(unnamed)"}`);

          const identifiers = [...card.emails, ...card.phones];

          logger.print(
            `  ${identifiers.length === 0 ? "no address or phone Harbor could read" : identifiers.join(", ")}`,
          );

          if (card.nickname !== null) {
            logger.print(`  nickname: ${card.nickname}`);
          }

          logger.print(
            `  ${card.linkedTo === null ? "not linked to anyone yet" : `linked to ${card.linkedTo}`}`,
          );
        }

        if (footer !== null) {
          logger.print("");
          logger.print(footer);
        }

        const stranded = found.filter((card) => card.emails.length + card.phones.length === 0);

        if (stranded.length > 0 && options.stranded !== true) {
          logger.print("");
          logger.print(
            `${plural(stranded.length, "card has", "cards have")} nothing Harbor can anchor to. ` +
              "A name alone cannot identify anyone, so those are skipped. `--stranded` lists them.",
          );
        }
      } finally {
        db.close();
      }
    });

  dev
    .command("chats")
    .description("Recent conversations")
    .option("-n, --limit <count>", "how many", "10")
    .action((options: { limit: string }) => {
      const { db } = openDatabase();

      try {
        const limit = Number.parseInt(options.limit, 10);
        const found = listConversations(db, DEFAULT_PRINCIPAL, Number.isFinite(limit) ? limit : 10);

        if (found.length === 0) {
          logger.print("No conversations yet.");
          return;
        }

        for (const conversation of found) {
          logger.print(
            `${conversation.id}  ${when(conversation.updatedAt).padEnd(22)} ${conversation.title ?? "(untitled)"}`,
          );
        }

        logger.print("");
        logger.print("harbor dev chat <id> to read one. harbor ask -c <id> to continue it.");
      } finally {
        db.close();
      }
    });

  dev
    .command("chat")
    .argument("<id>", "conversation id")
    .description("Read a conversation back")
    .option("--forget", "delete it")
    .action((id: string, options: { forget?: boolean }) => {
      const { db } = openDatabase();

      try {
        if (options.forget === true) {
          logger.print(deleteConversation(db, id) ? `${id} forgotten.` : `No conversation ${id}.`);
          return;
        }

        const conversation = getConversation(db, id);

        if (conversation === null) {
          logger.print(`No conversation ${id}.`);
          return;
        }

        logger.print(`${conversation.title ?? "(untitled)"}`);
        logger.print(`${when(conversation.createdAt)}`);

        if (conversation.summary !== null) {
          logger.print("");
          logger.print("Earlier, summarized:");
          logger.print(`  ${conversation.summary}`);
        }

        for (const turn of allTurns(db, conversation.id)) {
          logger.print("");
          logger.print(turn.role === "user" ? "You" : "Harbor");
          logger.print(`  ${turn.content.replace(/\n/g, "\n  ")}`);

          if (turn.toolsUsed.length > 0) {
            logger.print(`  [${turn.toolsUsed.join(", ")}]`);
          }
        }
      } finally {
        db.close();
      }
    });

  dev
    .command("derive")
    .description("Chunk and embed everything that is new or stale")
    .option("-n, --limit <count>", "stop after this many items")
    .action(async (options: { limit?: string }) => {
      const { db } = openDatabase();

      try {
        const embedder = await createEmbedder();
        const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);

        logger.print(`Embedder       ${embedder.model} (${String(embedder.dims)} dims)`);
        logger.print(`Pipeline       v${String(PIPELINE_VERSION)}`);
        logger.print("");

        let lastLine = "";

        const report = await derive(db, embedder, {
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
          onNote: (message) => {
            process.stdout.write("\r".padEnd(48) + "\r");
            logger.print(`  note: ${message}`);
          },
          onProgress: (done, total) => {
            const line = `  ${String(done)}/${String(total)} items`;
            if (line !== lastLine) {
              lastLine = line;
              process.stdout.write(`\r${line}          `);
            }
          },
        });

        process.stdout.write("\r".padEnd(48) + "\r");

        logger.print(`Index          ${report.backend}`);
        logger.print(`Items derived  ${String(report.itemsDerived)}`);
        if (report.skippedEmpty > 0) {
          logger.print(`  no content   ${String(report.skippedEmpty)}`);
        }
        if (report.itemsInEpisodes > 0) {
          logger.print(`  in episodes  ${String(report.itemsInEpisodes)} (embedded as conversations)`);
        }
        if (report.episodesWritten > 0 || report.episodesDerived > 0) {
          logger.print(
            `Conversations  ${String(report.episodesWritten)} segmented, ${String(report.episodesDerived)} embedded`,
          );
        }
        logger.print(`Chunks         ${String(report.chunksWritten)}`);

        if (report.embeddingsDropped.length > 0) {
          logger.print(
            `Refused        ${String(report.embeddingsDropped.length)} chunk(s) the model would not embed`,
          );

          for (const reason of report.embeddingsDropped.slice(0, 3)) {
            logger.print(`  ${reason}`);
          }
        }
        logger.print(`Embeddings     ${String(report.embeddingsWritten)}`);
        logger.print(`Remaining      ${String(report.remaining)}`);
        logger.print(`Took           ${formatDuration(report.durationMs)}`);
      } finally {
        db.close();
      }
    });

  dev
    .command("reindex")
    .description("Rebuild the vector index from stored embeddings (no model calls)")
    .action(async () => {
      const { db } = openDatabase();

      try {
        const embedder = await createEmbedder();
        const count = reindex(db, embedder.model, embedder.dims);
        logger.print(`Reindexed      ${String(count)} vectors`);
      } finally {
        db.close();
      }
    });

  dev
    .command("resolve")
    .description("Extract and link the people involved in every item")
    .option("-n, --limit <count>", "stop after this many items")
    .action((options: { limit?: string }) => {
      const { db } = openDatabase();

      try {
        const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);
        let lastLine = "";

        const report = resolveEntities(db, {
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
          onNote: (message) => {
            process.stdout.write("\r".padEnd(48) + "\r");
            logger.print(`  note: ${message}`);
          },
          onProgress: (done, total) => {
            const line = `  ${String(done)}/${String(total)} items`;
            if (line !== lastLine) {
              lastLine = line;
              process.stdout.write(`\r${line}          `);
            }
          },
        });

        process.stdout.write("\r".padEnd(48) + "\r");

        const stats = entityStats(db);

        logger.print(`Resolver       v${String(report.version)}`);
        logger.print(`Items          ${String(report.itemsResolved)}`);
        logger.print(`People/orgs    ${String(stats.entities)} (${String(report.entitiesCreated)} new)`);
        logger.print(`Identifiers    ${String(stats.identifiers)}`);
        logger.print(`Links          ${String(stats.links)}`);
        logger.print(`Your addresses ${String(report.selfAddresses)}`);
        if (report.contactCards > 0) {
          logger.print(
            `Address book   ${String(report.contactCards)} cards, ${String(report.contactMerges)} merges`,
          );
        }
        logger.print(`Remaining      ${String(report.remaining)}`);
        logger.print(`Took           ${formatDuration(report.durationMs)}`);
      } finally {
        db.close();
      }
    });

  people
    .command("list", { isDefault: true })
    .description("Who Harbor knows about, by how much correspondence there is")
    .option("-n, --limit <count>", "how many to show", "25")
    .option("--all", "include newsletters and senders you have never written to")
    .action((options: { limit: string; all?: boolean }) => {
      const { db } = openDatabase();

      try {
        const limit = Number.parseInt(options.limit, 10);
        const people = topEntities(db, Number.isFinite(limit) ? limit : 25, options.all === true);

        if (people.length === 0) {
          logger.print("Nobody yet. Run `harbor dev resolve`.");
          return;
        }

        for (const person of people) {
          const marks = `${person.entity.kind === "self" ? "*" : " "}${person.entity.pinned ? "+" : " "}`;
          logger.print(
            `${marks} ${String(person.items).padStart(6)}  ${person.entity.displayName}`,
          );
          logger.print(
            `          ${person.addresses.join(", ") || "(no address)"}` +
              `   in ${String(person.received)} / out ${String(person.sent)}` +
              `   last ${when(person.lastSeen)}`,
          );
        }

        logger.print("");
        logger.print("* you   + corrected by hand");
        if (options.all !== true) {
          logger.print("Showing people you have written to. --all for everything.");
        }
      } finally {
        db.close();
      }
    });

  people
    .command("show")
    .argument("<query...>", "name, partial name, or address")
    .description("Everything Harbor knows about one person")
    .action((parts: string[]) => {
      const { db } = openDatabase();

      try {
        const matches = lookupEntities(db, parts.join(" "), 5);

        if (matches.length === 0) {
          logger.print("No match.");
          return;
        }

        for (const match of matches) {
          logger.print(`${match.entity.displayName}   ${match.entity.id}`);
          logger.print(
            `  kind         ${match.entity.kind}${match.entity.pinned ? " (corrected by hand)" : ""}`,
          );
          logger.print(`  items        ${String(match.items)}`);
          logger.print(`  received     ${String(match.received)}`);
          logger.print(`  sent to      ${String(match.sent)}`);
          logger.print(`  last contact ${when(match.lastSeen)}`);

          for (const identifier of identifiersFor(db, match.entity.id)) {
            logger.print(
              `  ${identifier.kind.padEnd(6)} ${identifier.value}` +
                `  (${String(identifier.occurrences)}x, confidence ${identifier.confidence.toFixed(2)})`,
            );
          }

          logger.print("");
        }
      } finally {
        db.close();
      }
    });

  people
    .command("merge")
    .argument("<source>", "entity id to fold in")
    .argument("<target>", "entity id to keep")
    .description("Declare two entities the same person")
    .action((source: string, target: string) => {
      const { db } = openDatabase();

      try {
        const count = mergeEntities(db, source, target);
        logger.print(`Merged. ${plural(count, "identifier", "identifiers")} now on ${target}.`);
        logger.print("Both entities are pinned, so re-resolving will not undo this.");
      } finally {
        db.close();
      }
    });

  people
    .command("unlink")
    .argument("<address>", "email address to detach onto its own entity")
    .description("Undo a wrong merge by splitting one address out")
    .action((address: string) => {
      const { db } = openDatabase();

      try {
        const entity = unlinkIdentifier(db, "email", address.trim().toLowerCase());

        if (entity === null) {
          logger.print(`No identifier for ${address}.`);
          return;
        }

        logger.print(`${address} is now ${entity.id}.`);
      } finally {
        db.close();
      }
    });

  people
    .command("rename")
    .argument("<id>", "entity id")
    .argument("<name...>", "what to call them")
    .description("Correct a name, and pin it so resolution stops changing it")
    .action((id: string, parts: string[]) => {
      const { db } = openDatabase();

      try {
        pinEntity(db, id, parts.join(" "));
        logger.print(`${id} is now "${parts.join(" ")}" and pinned.`);
      } finally {
        db.close();
      }
    });

  program
    .command("find")
    .argument("<query...>", "what to look for")
    .description("Run retrieval directly, showing scores and why each hit matched")
    .option("-n, --limit <count>", "how many results", "10")
    .option("--lexical", "keyword only, skipping the semantic side")
    .option("-p, --person <id>", "restrict to items involving this entity")
    .action(
      async (parts: string[], options: { limit: string; lexical?: boolean; person?: string }) => {
      const { db } = openDatabase();

      try {
        const query = parts.join(" ");
        const limit = Number.parseInt(options.limit, 10);
        const embedder = options.lexical === true ? undefined : await optionalEmbedder();

        const vector =
          embedder === undefined ? undefined : (await embedder.embed([query]))[0];

        const hits = search(
          db,
          {
            principal: DEFAULT_PRINCIPAL,
            query,
            limit: Number.isFinite(limit) ? limit : 10,
            ...(options.person === undefined ? {} : { personId: options.person }),
            ...(options.lexical === true ? { mode: "lexical" as const } : {}),
          },
          embedder,
          vector,
        );

        if (hits.length === 0) {
          logger.print("No matches.");
          return;
        }

        for (const hit of hits) {
          logger.print(
            `${hit.score.toFixed(4)}  ${hit.item.kind.padEnd(8)} ${when(hit.item.occurredAt)}`,
          );
          logger.print(`        ${hit.item.title ?? "(no title)"}`);
          logger.print(`        ${hit.item.author ?? ""}`);
          logger.print(`        ${hit.reasons.join("; ")}`);
          logger.print(`        ${hit.item.id}`);
          logger.print("");
        }
      } finally {
        db.close();
      }
      },
    );

  const interest = settings.command("interest").description("What you are working on");

  interest
    .command("add")
    .argument("<statement...>", 'e.g. "looking at new backend roles"')
    .description("Tell Harbor something to keep an eye out for")
    .action(async (parts: string[]) => {
      const { db } = openDatabase();

      try {
        const statement = parts.join(" ");
        const record = addInterest(db, { principalId: DEFAULT_PRINCIPAL, statement });

        const embedder = await optionalEmbedder();

        if (embedder !== undefined) {
          const vector = (await embedder.embed([statement]))[0];
          if (vector !== undefined) {
            saveInterestEmbedding(db, record.id, embedder.model, toBlob(vector));
          }
        }

        logger.print(`${record.id}  ${record.statement}`);
        if (embedder === undefined) {
          logger.print("No embedder, so this will not match anything until you run it again");
          logger.print("with an embedding backend available.");
        }
      } finally {
        db.close();
      }
    });

  interest
    .command("list", { isDefault: true })
    .description("Everything Harbor is watching for")
    .option("--all", "include dormant and dismissed")
    .action((options: { all?: boolean }) => {
      const { db } = openDatabase();

      try {
        const states =
          options.all === true
            ? (["active", "dormant", "fulfilled", "dismissed"] as const)
            : (["active"] as const);

        const records = listInterests(db, DEFAULT_PRINCIPAL, states);

        if (records.length === 0) {
          logger.print('Nothing yet. Try: harbor settings interest add "looking at new roles"');
          return;
        }

        for (const record of records) {
          logger.print(`${record.state.padEnd(9)} ${record.id}  ${record.statement}`);
          logger.print(
            `          added ${when(record.createdAt)}` +
              (record.expiresAt === null ? "" : `, goes dormant ${when(record.expiresAt)}`),
          );
        }
      } finally {
        db.close();
      }
    });

  interest
    .command("drop")
    .argument("<id>", "interest id")
    .description("Stop watching for something")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        setInterestState(db, id, "dismissed");
        logger.print(`${id} dismissed.`);
      } finally {
        db.close();
      }
    });

  dev
    .command("signals")
    .description("Run the detectors and queue anything worth mentioning")
    .action(async () => {
      const { db } = openDatabase();

      try {
        const embedder = await optionalEmbedder();

        const report = runDetectors(db, {
          principalId: DEFAULT_PRINCIPAL,
          timezone: tz,
          ...(embedder === undefined ? {} : { embedder }),
        });

        for (const result of report.results) {
          logger.print(
            `${result.detectorId.padEnd(16)} examined ${String(result.examined).padStart(5)}` +
              `   new ${String(result.created).padStart(4)}` +
              `   closed ${String(result.resolved).padStart(4)}`,
          );
        }

        if (report.interestsExpired > 0) {
          logger.print("");
          logger.print(
            `${plural(report.interestsExpired, "interest", "interests")} went dormant.`,
          );
        }

        for (const detector of report.suppressed) {
          logger.print("");
          logger.print(`Muted ${detector}: you dismissed most of what it produced.`);
          logger.print(`Re-enable with \`harbor settings detectors --enable ${detector}\`.`);
        }

        logger.print("");
        logger.print(`Took           ${formatDuration(report.durationMs)}`);
        logger.print("Next: harbor dev brief");
      } finally {
        db.close();
      }
    });

  dev
    .command("brief")
    .description("What Harbor thinks is worth your attention right now")
    .option("-n, --budget <count>", "how many things, at most", String(DEFAULT_BUDGET))
    .option("--preview", "look without marking anything as said")
    .action((options: { budget: string; preview?: boolean }) => {
      const { db } = openDatabase();

      try {
        const budget = Number.parseInt(options.budget, 10);

        const brief = composeBrief(db, {
          principalId: DEFAULT_PRINCIPAL,
          timezone: tz,
          budget: Number.isFinite(budget) ? budget : DEFAULT_BUDGET,
          ...(options.preview === true ? { preview: true } : {}),
        });

        logger.print(renderBrief(brief));

        if (brief.entries.length > 0 && options.preview !== true) {
          logger.print("");
          logger.print("Not useful? harbor dismiss <id>");
        }
      } finally {
        db.close();
      }
    });

  program
    .command("dismiss")
    .argument("<id>", "observation id from the brief")
    .description("Tell Harbor that was not worth saying")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        const observation = getObservation(db, id);

        if (observation === null) {
          logger.print(`No observation ${id}.`);
          return;
        }

        dismissObservation(db, observation.id, observation.detectorId);
        logger.print(`Dismissed. ${observation.detectorId} noted.`);
      } finally {
        db.close();
      }
    });

  settings
    .command("detectors")
    .description("How each detector is performing")
    .option("--enable <id>", "un-mute a detector")
    .option("--disable <id>", "mute a detector")
    .action((options: { enable?: string; disable?: string }) => {
      const { db } = openDatabase();

      try {
        if (options.enable !== undefined) {
          setDetectorSuppressed(db, options.enable, false);
          logger.print(`${options.enable} enabled.`);
          return;
        }

        if (options.disable !== undefined) {
          setDetectorSuppressed(db, options.disable, true);
          logger.print(`${options.disable} muted.`);
          return;
        }

        const stats = detectorStats(db);

        if (stats.length === 0) {
          logger.print("No detector has surfaced anything yet. Run `harbor dev signals`.");
          return;
        }

        for (const entry of stats) {
          logger.print(
            `${entry.detectorId.padEnd(16)} surfaced ${String(entry.surfaced).padStart(4)}` +
              `  dismissed ${String(entry.dismissed).padStart(4)}` +
              `  acted ${String(entry.acted).padStart(4)}` +
              `  ${(entry.dismissalRate * 100).toFixed(0)}% dismissed` +
              (entry.suppressed ? "   MUTED" : ""),
          );
        }
      } finally {
        db.close();
      }
    });

  dev
    .command("classify")
    .description("Label every item's sensitivity, deterministically")
    .option("-n, --limit <count>", "stop after this many items")
    .option("--explain <text...>", "show how a piece of text would be classified")
    .action((options: { limit?: string; explain?: string[] }) => {
      if (options.explain !== undefined) {
        const text = options.explain.join(" ");
        const result = classify({ title: null, body: text, author: null, kind: "message" });

        logger.print(`Sensitivity    ${result.sensitivity}`);
        logger.print(
          `Because        ${result.reasons.length === 0 ? "nothing matched" : result.reasons.join(", ")}`,
        );
        return;
      }

      const { db } = openDatabase();

      try {
        const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);
        let lastLine = "";

        const report = classifyItems(db, {
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
          onProgress: (done, total) => {
            const line = `  ${String(done)}/${String(total)}`;
            if (line !== lastLine) {
              lastLine = line;
              process.stdout.write(`\r${line}          `);
            }
          },
        });

        process.stdout.write("\r".padEnd(40) + "\r");

        logger.print(`Classifier     v${String(report.version)} (no model calls)`);
        logger.print(`Examined       ${String(report.examined)}`);
        logger.print(`  normal       ${String(report.normal)}`);
        logger.print(`  sensitive    ${String(report.sensitive)}`);
        logger.print(`  restricted   ${String(report.restricted)}`);
        logger.print(`Remaining      ${String(report.remaining)}`);
        logger.print(`Took           ${formatDuration(report.durationMs)}`);
      } finally {
        db.close();
      }
    });

  const policy = settings.command("policy").description("What may leave this machine");

  policy
    .command("list", { isDefault: true })
    .description("Rules, in the order they are evaluated")
    .option("--all", "include disabled rules")
    .action((options: { all?: boolean }) => {
      const { db } = openDatabase();

      try {
        for (const rule of listRules(db, options.all === true)) {
          const match = [
            rule.matchSensitivity === null ? null : `sensitivity=${rule.matchSensitivity}`,
            rule.matchKind === null ? null : `kind=${rule.matchKind}`,
            rule.matchEntity === null ? null : `entity=${rule.matchEntity}`,
            rule.matchPattern === null ? null : `pattern=/${rule.matchPattern}/`,
          ]
            .filter((entry) => entry !== null)
            .join(" ");

          logger.print(
            `${String(rule.priority).padStart(5)}  ${rule.egress.padEnd(11)} ${rule.id}` +
              (rule.builtin ? "  [built-in]" : "") +
              (rule.enabled ? "" : "  [disabled]"),
          );
          logger.print(`       ${match.length === 0 ? "matches everything" : match}`);
          if (rule.note !== null) {
            logger.print(`       ${rule.note}`);
          }
        }
      } finally {
        db.close();
      }
    });

  policy
    .command("add")
    .argument("<id>", "rule id")
    .requiredOption("--egress <mode>", "local_only, redacted, or allowed")
    .option("--priority <n>", "lower runs first", "100")
    .option("--sensitivity <level>", "normal, sensitive, or restricted")
    .option("--kind <kind>", "message or event")
    .option("--entity <id>", "entity id from harbor people")
    .option("--pattern <regex>", "match against the item text")
    .option("--note <text>", "why this rule exists")
    .action(
      (
        id: string,
        options: {
          egress: string;
          priority: string;
          sensitivity?: string;
          kind?: string;
          entity?: string;
          pattern?: string;
          note?: string;
        },
      ) => {
        if (!["local_only", "redacted", "allowed"].includes(options.egress)) {
          throw new HarborError(`Unknown egress mode: ${options.egress}`, {
            code: "usage.bad_egress",
            exitCode: EXIT_CODES.usage,
            hint: "Use local_only, redacted, or allowed.",
          });
        }

        const { db } = openDatabase();

        try {
          const priority = Number.parseInt(options.priority, 10);

          addRule(db, {
            id,
            priority: Number.isFinite(priority) ? priority : 100,
            egress: options.egress as "local_only" | "redacted" | "allowed",
            ...(options.sensitivity === undefined
              ? {}
              : { matchSensitivity: options.sensitivity as "normal" | "sensitive" | "restricted" }),
            ...(options.kind === undefined ? {} : { matchKind: options.kind }),
            ...(options.entity === undefined ? {} : { matchEntity: options.entity }),
            ...(options.pattern === undefined ? {} : { matchPattern: options.pattern }),
            ...(options.note === undefined ? {} : { note: options.note }),
          });

          logger.print(`${id} added.`);
        } finally {
          db.close();
        }
      },
    );

  policy
    .command("disable")
    .argument("<id>", "rule id")
    .description("Turn a rule off without deleting it")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        setRuleEnabled(db, id, false);
        logger.print(`${id} disabled.`);
      } finally {
        db.close();
      }
    });

  policy
    .command("remove")
    .argument("<id>", "rule id")
    .description("Delete a custom rule (built-ins are disabled instead)")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        logger.print(removeRule(db, id) ? `${id} removed.` : `No rule ${id}.`);
      } finally {
        db.close();
      }
    });

  settings
    .command("audit")
    .description("What left this machine, and under which rule")
    .option("-n, --limit <count>", "how many entries", "20")
    .option("--days <count>", "summary window", "30")
    .action((options: { limit: string; days: string }) => {
      const { db } = openDatabase();

      try {
        const limit = Number.parseInt(options.limit, 10);
        const days = Number.parseInt(options.days, 10);
        const since = Date.now() - (Number.isFinite(days) ? days : 30) * 86_400_000;

        const summary = egressSince(db, since);

        logger.print(`Last ${String(Number.isFinite(days) ? days : 30)} days`);
        logger.print(`  model calls  ${String(summary.calls)}`);
        logger.print(`  items sent   ${String(summary.itemsIncluded)}`);
        logger.print(`  withheld     ${String(summary.itemsWithheld)}`);
        logger.print(`  redactions   ${String(summary.redactions)}`);
        logger.print(`  bytes out    ${formatBytes(summary.bytesOut)}`);
        logger.print("");

        for (const row of recent(db, Number.isFinite(limit) ? limit : 20)) {
          logger.print(
            `${when(row.at)}  ${(row.task_class ?? row.kind).padEnd(18)} ` +
              `${(row.tier ?? "").padEnd(14)} ${row.outcome.padEnd(7)} ` +
              `${String(row.items_included)} sent / ${String(row.items_withheld)} held / ` +
              `${String(row.redactions)} redacted  ` +
              (row.cost_micros === null ? "" : formatCost(row.cost_micros)),
          );
          if (row.note !== null) {
            logger.print(`    ${row.note}`);
          }
        }
      } finally {
        db.close();
      }
    });

  settings
    .command("cost")
    .description("Spend by task class, so the number is actionable")
    .option("--days <count>", "window", "30")
    .action((options: { days: string }) => {
      const { db } = openDatabase();

      try {
        const days = Number.parseInt(options.days, 10);
        const since = Date.now() - (Number.isFinite(days) ? days : 30) * 86_400_000;
        const rows = spend(db, since);

        if (rows.length === 0) {
          logger.print("No model calls in this window.");
          return;
        }

        let total = 0;

        for (const row of rows) {
          total += row.costMicros;
          logger.print(
            `${row.taskClass.padEnd(20)} ${row.tier.padEnd(14)} ` +
              `${String(row.calls).padStart(5)} calls  ` +
              `${String(row.inputTokens).padStart(9)} in  ${String(row.outputTokens).padStart(8)} out  ` +
              formatCost(row.costMicros).padStart(8),
          );
        }

        const cache = cacheStats(db);

        logger.print("");
        logger.print(`Total          ${formatCost(total)}`);
        logger.print(
          `Cache          ${String(cache.entries)} entries, ${plural(cache.hits, "hit", "hits")} avoided`,
        );
      } finally {
        db.close();
      }
    });

  settings
    .command("router")
    .description("Which tier handles what, and whether it is still good enough")
    .option("--reset <task>", "clear a demotion, with --tier")
    .option("--tier <tier>", "tier to reset")
    .action((options: { reset?: string; tier?: string }) => {
      const { db } = openDatabase();

      try {
        if (options.reset !== undefined && options.tier !== undefined) {
          clearDemotion(db, options.reset, options.tier);
          logger.print(`${options.reset} on ${options.tier} reset.`);
          return;
        }

        for (const task of TASK_CLASSES) {
          logger.print(`${task.id}`);
          logger.print(`  ${task.description}`);
          logger.print(
            `  privacy ${task.privacy}   verification ${task.verification}` +
              (task.floor === undefined ? "" : `   floor ${task.floor}`) +
              (task.requires.length === 0 ? "" : `   needs ${task.requires.join(", ")}`),
          );
        }

        const quality = qualityStats(db);

        if (quality.length > 0) {
          logger.print("");
          logger.print("Shadow samples");

          for (const row of quality) {
            const rate = row.samples === 0 ? 0 : row.disagreements / row.samples;
            logger.print(
              `  ${row.task_class.padEnd(20)} ${row.tier.padEnd(14)} ` +
                `${String(row.samples)} samples, ${(rate * 100).toFixed(0)}% disagreed` +
                (row.demoted === 1 ? "   DEMOTED" : ""),
            );
          }
        }
      } finally {
        db.close();
      }
    });

  const schedule = settings.command("schedule").description("What runs unattended");

  schedule
    .command("add")
    .argument("<task>", SCHEDULABLE.join(" | "))
    .option("--every <minutes>", "run on an interval, in minutes")
    .option("--at <hh:mm>", "run daily at a local time")
    .option("--source <connector>", "restrict to one connector, for a per-source cadence")
    .description("Add or replace a schedule")
    .action((task: string, options: { every?: string; at?: string; source?: string }) => {
      if (!SCHEDULABLE.includes(task as ScheduledTask)) {
        throw new HarborError(`Unknown task: ${task}`, {
          code: "usage.unknown_task",
          exitCode: EXIT_CODES.usage,
          hint: `Known tasks: ${SCHEDULABLE.join(", ")}`,
        });
      }

      if (options.every === undefined && options.at === undefined) {
        throw new HarborError("Give either --every or --at", {
          code: "usage.no_trigger",
          exitCode: EXIT_CODES.usage,
          hint: "harbor settings schedule add sync --every 15   |   harbor settings schedule add pipeline --at 06:30",
        });
      }

      const { db } = openDatabase();

      try {
        const [hourText, minuteText] = (options.at ?? "").split(":");
        const every = options.every === undefined ? null : Number.parseInt(options.every, 10);

        const record = addSchedule(db, {
          principalId: DEFAULT_PRINCIPAL,
          task: task as ScheduledTask,
          timezone: tz,
          ...(options.source === undefined ? {} : { target: options.source }),
          ...(every !== null && Number.isFinite(every) ? { intervalMinutes: every } : {}),
          ...(options.at === undefined
            ? {}
            : {
                atHour: Number.parseInt(hourText ?? "7", 10),
                atMinute: Number.parseInt(minuteText ?? "0", 10),
              }),
        });

        logger.print(`${record.task} scheduled. Next run ${when(record.nextRunAt)}.`);
      } finally {
        db.close();
      }
    });

  schedule
    .command("list", { isDefault: true })
    .description("Everything scheduled, and how it last went")
    .action(() => {
      const { db } = openDatabase();

      try {
        const records = listSchedules(db);

        if (records.length === 0) {
          logger.print("Nothing scheduled. A sensible default:");
          logger.print("  harbor settings schedule add sync --every 15");
          logger.print("  harbor settings schedule add pipeline --at 06:00");
          logger.print("  harbor settings schedule add backup --at 03:00");
          return;
        }

        for (const record of records) {
          const cadence =
            record.intervalMinutes !== null
              ? `every ${String(record.intervalMinutes)}m`
              : `daily at ${String(record.atHour ?? 0).padStart(2, "0")}:${String(record.atMinute ?? 0).padStart(2, "0")}`;

          logger.print(
            `${(record.target === null ? record.task : `${record.task}:${record.target}`).padEnd(20)} ` +
              `${cadence.padEnd(16)} ${record.enabled ? "" : "[disabled] "}next ${when(record.nextRunAt)}`,
          );

          if (record.lastRunAt !== null) {
            logger.print(
              `           last ${when(record.lastRunAt)}  ${record.lastStatus ?? ""}  ${record.lastNote ?? ""}`,
            );
          }
        }
      } finally {
        db.close();
      }
    });

  schedule
    .command("remove")
    .argument("<task>", "task name")
    .action((task: string) => {
      const { db } = openDatabase();

      try {
        // Accepts either `pulse` or `pulse:imessage`, matching what list shows.
        const id = task.includes(":") ? `s_${task}` : `s_${task}`;
        logger.print(removeSchedule(db, id) ? `${task} unscheduled.` : `No schedule for ${task}.`);
      } finally {
        db.close();
      }
    });

  schedule
    .command("disable")
    .argument("<task>", "task name")
    .action((task: string) => {
      const { db } = openDatabase();

      try {
        setScheduleEnabled(db, `s_${task}`, false);
        logger.print(`${task} disabled.`);
      } finally {
        db.close();
      }
    });

  dev
    .command("run")
    .argument("<task>", SCHEDULABLE.join(" | "))
    .description("Run a scheduled task once, right now")
    .action(async (task: string) => {
      // Two task vocabularies exist: the scheduler's, and the background job
      // runner's behind `harbor start`. They overlap enough that picking the
      // wrong one is easy and the failure used to be a bare "unknown task",
      // which tells a person nothing about where to look next.
      if (!SCHEDULABLE.includes(task as ScheduledTask)) {
        const elsewhere = ["recent", "history", "backfill", "onboard"].includes(task);

        throw new HarborError(`\`harbor dev run\` does not know the task ${task}.`, {
          code: "usage.unknown_task",
          exitCode: EXIT_CODES.usage,
          hint: elsewhere
            ? `${task} is a background job. Run \`harbor start ${task}\` instead.`
            : `Scheduled tasks: ${SCHEDULABLE.join(", ")}. ` +
              `Background jobs run with \`harbor start\`.`,
        });
      }

      const { db } = openDatabase();

      try {
        const note = await runTaskDirectly(db, task as ScheduledTask, {
          principalId: DEFAULT_PRINCIPAL,
          timezone: tz,
          logger,
        });

        logger.print(note);
      } finally {
        db.close();
      }
    });

  program
    .command("daemon")
    .description("Run the scheduler and the local API until stopped")
    .option("--port <port>", "API port", "8484")
    .option("--host <host>", "bind address", "127.0.0.1")
    .option("--no-http", "scheduler only")
    .option("--tls", "serve HTTPS with a self-signed, pinnable certificate")
    .option("--ui <dir>", "serve a built front end from this directory")
    .option(
      "--allow-origin <origin...>",
      "browser origins permitted to call the API (development only)",
    )
    .option("--no-discovery", "do not advertise over mDNS")
    .option("--tick <seconds>", "how often to check for due work", "60")
    .action(
      async (options: {
        port: string;
        host: string;
        http?: boolean;
        tls?: boolean;
        ui?: string;
        allowOrigin?: string[];
        discovery?: boolean;
        tick: string;
      }) => {
      const { db, rulesSeeded, orphanedJobs } = openDatabase();

      if (rulesSeeded > 0) {
        logger.warn(
          `seeded ${plural(rulesSeeded, "policy rule", "policy rules")}: the gate was ` +
            "unconfigured, which would have withheld everything",
        );
      }

      if (orphanedJobs > 0) {
        logger.warn(`${plural(orphanedJobs, "job", "jobs")} were interrupted by a restart`);
      }

      const port = Number.parseInt(options.port, 10);
      const tickSeconds = Number.parseInt(options.tick, 10);

      logger.print(`Harbor daemon  ${harborHome()}`);
      logger.print(`Timezone       ${tz}`);

      const scheduler = startScheduler(db, {
        principalId: DEFAULT_PRINCIPAL,
        timezone: tz,
        logger,
        tickSeconds: Number.isFinite(tickSeconds) ? tickSeconds : 60,
      });

      let server: ReturnType<typeof startApi> | null = null;
      let beacon: ReturnType<typeof advertise> | null = null;

      if (options.http !== false) {
        const useTls = options.tls === true && tlsAvailable();

        if (options.tls === true && !useTls) {
          logger.warn("openssl not found, so TLS is unavailable. Serving plain HTTP.");
        }

        const material = useTls ? ensureTls() : null;

        server = startApi(db, {
          port: Number.isFinite(port) ? port : 8484,
          host: options.host,
          timezone: tz,
          principalId: DEFAULT_PRINCIPAL,
          logger,
          ...(material === null ? {} : { tls: { key: material.key, cert: material.cert } }),
          ...(options.ui === undefined ? {} : { uiRoot: resolvePath(options.ui) }),
          ...(options.allowOrigin === undefined ? {} : { allowedOrigins: options.allowOrigin }),
        });

        logger.print(
          `API            ${useTls ? "https" : "http"}://${options.host}:${String(port)}`,
        );

        if (options.ui !== undefined) {
          logger.print(`UI             ${resolvePath(options.ui)}`);
        }

        if (options.allowOrigin !== undefined && options.allowOrigin.length > 0) {
          logger.print(`Allowed origin ${options.allowOrigin.join(", ")}`);
          logger.warn(
            "cross-origin access is enabled. That is right for a UI dev server and " +
              "wrong in production, where the front end should be served with --ui.",
          );
        }

        if (material !== null) {
          logger.print(`Fingerprint    ${material.fingerprint}`);
          logger.print("               Clients pin this at pairing time.");
        }

        if (!useTls && options.host !== "127.0.0.1" && options.host !== "localhost") {
          logger.warn(
            "bound beyond localhost without TLS: bearer tokens travel in the clear on " +
              "your LAN. Add --tls, or put a reverse proxy with a certificate in front.",
          );
        }

        // So the CLI can hand work over instead of opening a second writer.
        const cliDevice = pairDevice(db, {
          name: "harbor cli",
          principalId: DEFAULT_PRINCIPAL,
          scopes: ["read", "act"],
        });

        writeHandle({
          pid: process.pid,
          host: options.host === "0.0.0.0" ? "127.0.0.1" : options.host,
          port: Number.isFinite(port) ? port : 8484,
          scheme: useTls ? "https" : "http",
          token: cliDevice.token,
          startedAt: Date.now(),
        });

        if (options.discovery !== false) {
          beacon = advertise({
            port: Number.isFinite(port) ? port : 8484,
            tls: useTls,
            fingerprint: material?.fingerprint ?? null,
          });

          logger.print(`Discovery      ${beacon.instance}`);
          if (beacon.addresses.length > 0) {
            logger.print(`               ${beacon.addresses.join(", ")}`);
          }
        }
      }

      const schedules = listSchedules(db).filter((entry) => entry.enabled);
      logger.print(`Schedules      ${plural(schedules.length, "task", "tasks")}`);
      logger.print("");

      // A store mid-write is worse than a slow shutdown. Stop accepting work,
      // let the current tick finish, then close.
      const shutdown = (signal: string): void => {
        logger.print(`\n${signal}: finishing the current tick, then stopping.`);
        scheduler.stop();
        server?.close();
        beacon?.stop();
        clearHandle();

        void scheduler.stopped.then(() => {
          db.close();
          process.exit(0);
        });
      };

      process.on("SIGTERM", () => {
        shutdown("SIGTERM");
      });
      process.on("SIGINT", () => {
        shutdown("SIGINT");
      });

      await scheduler.stopped;
      },
    );

  dev
    .command("mcp")
    .description("Serve the tool surface over MCP on stdio")
    .action(async () => {
      const { db } = openDatabase();

      try {
        await serveMcp(db, { principalId: DEFAULT_PRINCIPAL, timezone: tz });
      } finally {
        db.close();
      }
    });

  dev
    .command("install-service")
    .description("Write a launchd plist or systemd unit for the daemon")
    .option("--port <port>", "HTTP port", "8484")
    .option("--host <host>", "bind address", "127.0.0.1")
    .action((options: { port: string; host: string }) => {
      const port = Number.parseInt(options.port, 10);

      const spec = {
        nodePath: process.execPath,
        entryPath: join(process.cwd(), "dist", "cli", "main.js"),
        port: Number.isFinite(port) ? port : 8484,
        host: options.host,
        timezone: tz,
      };

      const darwin = process.platform === "darwin";
      const path = join(harborHome(), darwin ? "com.harbor.daemon.plist" : "harbor.service");

      writeFileSync(path, darwin ? launchdPlist(spec) : systemdUnit(spec), { mode: 0o644 });

      for (const line of installInstructions(process.platform, path)) {
        logger.print(line);
      }
    });

  const device = program.command("device").description("Machines allowed to reach Harbor");

  device
    .command("pair")
    .argument("<name...>", "what to call it")
    .option("--act", "allow this device to approve write actions")
    .description("Create a token for another device")
    .action((parts: string[], options: { act?: boolean }) => {
      const { db } = openDatabase();

      try {
        const paired = pairDevice(db, {
          name: parts.join(" "),
          principalId: DEFAULT_PRINCIPAL,
          scopes: options.act === true ? ["read", "act"] : ["read"],
        });

        logger.print(`Device         ${paired.device.name}  (${paired.device.id})`);
        logger.print(`Scopes         ${paired.device.scopes.join(", ")}`);
        logger.print("");
        logger.print(`Token          ${paired.token}`);
        logger.print("");
        logger.print("Shown once. Harbor stores only a hash and cannot show it again.");
      } finally {
        db.close();
      }
    });

  device
    .command("code")
    .description("Issue a short-lived pairing code for a client to redeem")
    .option("--act", "the resulting device may approve write actions")
    .option("--label <text>", "what this code is for")
    .action((options: { act?: boolean; label?: string }) => {
      const { db } = openDatabase();

      try {
        const code = issueCode(db, {
          principalId: DEFAULT_PRINCIPAL,
          scopes: options.act === true ? ["read", "act"] : ["read"],
          ...(options.label === undefined ? {} : { label: options.label }),
        });

        logger.print(`Code           ${code.code}`);
        logger.print(`Scopes         ${code.scopes.join(", ")}`);
        logger.print(`Expires        ${when(code.expiresAt)}`);
        logger.print("");
        logger.print("Single use. The client POSTs it to /pair with a device name.");

        const outstanding = activeCodes(db).length;

        if (outstanding > 1) {
          logger.print("");
          logger.print(`${plural(outstanding, "code is", "codes are")} currently outstanding.`);
        }
      } finally {
        db.close();
      }
    });

  device
    .command("list")
    .description("Paired devices")
    .action(() => {
      const { db } = openDatabase();

      try {
        const devices = listDevices(db);

        if (devices.length === 0) {
          logger.print("No devices paired.");
          return;
        }

        for (const entry of devices) {
          logger.print(
            `${entry.id}  ${entry.name.padEnd(20)} ${entry.scopes.join(",").padEnd(10)}` +
              ` last seen ${when(entry.lastSeenAt)}${entry.revoked ? "  REVOKED" : ""}`,
          );
        }
      } finally {
        db.close();
      }
    });

  device
    .command("revoke")
    .argument("<id>", "device id")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        logger.print(revokeDevice(db, id) ? `${id} revoked.` : `No device ${id}.`);
      } finally {
        db.close();
      }
    });
  program
    .command("setup")
    .description("What is done, and what to do next")
    .action(() => {
      const { db } = openDatabase();

      try {
        const state = setupState(db, DEFAULT_PRINCIPAL);

        for (const step of state.steps) {
          logger.print(
            `${step.done ? "[x]" : step.current ? "[>]" : "[ ]"} ${step.label.padEnd(30)} ${step.detail}`,
          );
        }

        logger.print("");

        if (state.runningJob !== null) {
          const job = getJob(db, state.runningJob);
          logger.print(
            `Running        ${job?.task ?? ""} ${String(job?.progressDone ?? 0)}` +
              (job?.progressTotal === null || job?.progressTotal === undefined
                ? ""
                : `/${String(job.progressTotal)}`),
          );
        }

        logger.print(state.complete ? "Setup complete." : "Next step marked [>].");

        const found = problems(db, DEFAULT_PRINCIPAL);

        if (found.length > 0) {
          logger.print("");
          for (const problem of found) {
            logger.print(`${problem.severity === "error" ? "!!" : " !"} ${problem.message}`);
            logger.print(`   ${problem.fix}`);
          }
        }
      } finally {
        db.close();
      }
    });

  dev
    .command("problems")
    .description("Anything currently wrong")
    .action(() => {
      const { db } = openDatabase();

      try {
        const found = problems(db, DEFAULT_PRINCIPAL);

        if (found.length === 0) {
          logger.print("Nothing wrong.");
          return;
        }

        for (const problem of found) {
          logger.print(`${problem.severity === "error" ? "!!" : " !"} ${problem.message}`);
          logger.print(`   ${problem.fix}`);
        }
      } finally {
        db.close();
      }
    });

  /**
   * Starts one background task.
   *
   * Shared by `harbor update` and `harbor start`, so the two cannot drift.
   */
  async function startTask(task: JobTask, source?: string): Promise<boolean> {
    // One writer, always.
    //
    // Running the job here while a daemon holds the same database open is two
    // processes writing one SQLite file, which is not a thing to tune with
    // timeouts. If a daemon is up, it does the work.
    const daemon = readHandle();

    if (daemon !== null) {
      const result = await delegateJob(daemon, task, source);

      if (result.ok) {
        logger.print(result.detail);
        return true;
      }

      logger.warn(`could not reach the daemon (${result.detail}); running here instead`);
    }

    const { db } = openDatabase();

    // Not closed on purpose: the job runs detached and needs the handle.
    const started = enqueue(
      db,
      task,
      {
        principalId: DEFAULT_PRINCIPAL,
        timezone: tz,
        ...(source === undefined ? {} : { target: source }),
      },
      "cli",
    );

    if (started.blocked !== null) {
      logger.print(`${task} cannot run while ${started.blocked.task} is running.`);
      logger.print(`Stop it with \`harbor stop ${started.blocked.jobId}\`, or wait.`);
      return false;
    }

    if (started.job === null) {
      logger.print(`${task} could not be started.`);
      return false;
    }

    logger.print(`${started.job.id}  ${started.job.task}`);

    return started.started;
  }

  // Bringing Harbor up to date.
  //
  // This replaces a nine-command incantation whose order mattered and whose
  // names described Harbor's internals. `harbor update` is the same pipeline
  // with a name that says what it does, and it is the third and last command a
  // new person runs.
  //
  // The individual stages stay reachable as `harbor dev <stage>`.
  program
    .command("update")
    .description("Bring Harbor up to date: fetch what is new and work through it")
    .action(async () => {
      const started = await startTask("onboard");

      if (!started) {
        return;
      }

      // Honest about the wait. The recent pass makes Harbor answerable within a
      // couple of minutes while history fills in behind it, and nothing used to
      // say so, which meant the only way to find out was to ask a question and
      // get a confidently incomplete answer.
      logger.print("");
      logger.print("Recent mail, messages, calendars, and reminders come first, so you can");
      logger.print("ask Harbor something within a minute or two. Older history fills in behind.");
      logger.print("");
      logger.print("  harbor jobs      what it is doing now");
      logger.print("  harbor status    what it holds, and how far back");
    });

  program
    .command("start")
    .argument("<task>", JOB_TASKS.join(" | "))
    .option("--source <connector>", "restrict to one connector")
    .description("Run a task as a background job, returning a job id")
    .action(async (task: string, options: { source?: string }) => {
      if (!JOB_TASKS.includes(task as JobTask)) {
        throw new HarborError(`Unknown task: ${task}`, {
          code: "usage.unknown_task",
          exitCode: EXIT_CODES.usage,
          hint: `Known tasks: ${JOB_TASKS.join(", ")}`,
        });
      }

      const started = await startTask(task as JobTask, options.source);

      logger.print(
        started
          ? "Started. Watch it with `harbor jobs`."
          : "Already running; this is the existing job.",
      );
    });

  program
    .command("stop")
    .argument("[id]", "job id, or `all`")
    .option("--force", "mark it stopped immediately rather than waiting for it to notice")
    .description("Stop a running job")
    .action(async (id: string | undefined, options: { force?: boolean }) => {
      const target = id ?? "all";
      const daemon = readHandle();

      // The daemon owns the running job, so asking it is the only thing that
      // can actually interrupt one. Cancelling in a separate process would set
      // a flag nobody is reading.
      if (daemon !== null) {
        const result = await stopViaDaemon(daemon, target, options.force === true);
        logger.print(result);
        return;
      }

      const { db } = openDatabase();

      try {
        if (target === "all") {
          const count = stopAll(db, options.force === true);
          logger.print(count === 0 ? "Nothing running." : `Stopping ${plural(count, "job", "jobs")}.`);
          return;
        }

        const outcome = stop(db, target, options.force === true);

        logger.print(
          outcome.stopped
            ? options.force === true
              ? `${target} marked stopped.`
              : `${target} will stop at its next checkpoint.`
            : `${target} is not running.`,
        );
      } finally {
        db.close();
      }
    });

  const jobs = program.command("jobs").description("Background work");

  jobs
    .command("list", { isDefault: true })
    .option("-n, --limit <count>", "how many", "10")
    .action((options: { limit: string }) => {
      const { db } = openDatabase();

      try {
        const limit = Number.parseInt(options.limit, 10);
        const found = listJobs(db, Number.isFinite(limit) ? limit : 10);

        if (found.length === 0) {
          logger.print("No jobs yet. Start one with `harbor update`.");
          return;
        }

        for (const job of found) {
          const progress =
            job.progressTotal === null
              ? String(job.progressDone)
              : `${String(job.progressDone)}/${String(job.progressTotal)}`;

          logger.print(
            `${job.id}  ${job.task.padEnd(10)} ${job.state.padEnd(10)} ${progress.padStart(12)}  ${when(job.createdAt)}`,
          );

          if (job.note !== null) {
            logger.print(`             ${job.note}`);
          }
          if (job.error !== null) {
            logger.print(`             error: ${job.error}`);
          }
        }
      } finally {
        db.close();
      }
    });

  jobs
    .command("show")
    .argument("<id>", "job id")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        const job = getJob(db, id);

        if (job === null) {
          logger.print(`No job ${id}.`);
          return;
        }

        logger.print(`${job.id}`);
        logger.print(`  task       ${job.task}`);
        logger.print(`  state      ${job.state}`);
        logger.print(`  phase      ${job.phase ?? "-"}`);
        logger.print(
          `  progress   ${String(job.progressDone)}${job.progressTotal === null ? "" : `/${String(job.progressTotal)}`}`,
        );
        logger.print(`  started    ${when(job.startedAt)}`);
        logger.print(`  finished   ${when(job.finishedAt)}`);
        if (job.note !== null) {
          logger.print(`  note       ${job.note}`);
        }
        if (job.error !== null) {
          logger.print(`  error      ${job.error}`);
        }
      } finally {
        db.close();
      }
    });

  dev
    .command("fingerprint")
    .description("The TLS certificate fingerprint clients pin")
    .action(() => {
      const found = currentFingerprint();

      if (found === null) {
        logger.print("No certificate yet. Run the daemon with --tls once.");
        return;
      }

      logger.print(found);
    });

  program
    .command("status")
    .description("Show connected sources, coverage, and storage")
    .action(() => {
      const { db } = openDatabase();

      try {
        const accounts = listAccounts(db);
        const stats = rawStats(db);

        logger.print(`Harbor home    ${harborHome()}`);
        logger.print(`Timezone       ${tz}`);
        logger.print(`Items          ${String(countItems(db))}`);
        logger.print(`Database       ${formatBytes(databaseSize(db))}`);
        logger.print(
          `  raw payloads ${formatBytes(stats.rawBytes)} ` +
            `(${String(stats.gzipRows)} compressed, ${String(stats.plainRows)} plain)`,
        );
        logger.print(`  body text    ${formatBytes(stats.bodyBytes)}`);

        const derived = deriveStats(db);
        const pending = countPending(db, PIPELINE_VERSION);

        logger.print("");
        logger.print(`Derivation     pipeline v${String(PIPELINE_VERSION)}, index ${vectorBackend(db)}`);
        logger.print(`  chunks       ${String(derived.chunks)}`);
        logger.print(
          `  embeddings   ${String(derived.embeddings)} (${formatBytes(derived.vectorBytes)})` +
            (derived.models.length === 0 ? "" : `  ${derived.models.join(", ")}`),
        );
        logger.print(
          `  pending      ${String(pending)}${pending === 0 ? "" : "  (run `harbor dev derive`)"}`,
        );

        logger.print("");
        logger.print(`Sensitivity    classifier v${String(CLASSIFIER_VERSION)}`);
        for (const row of sensitivityBreakdown(db)) {
          logger.print(`  ${row.sensitivity.padEnd(13)}${String(row.count).padStart(7)}`);
        }
        const unclassified = countUnclassified(db, CLASSIFIER_VERSION);
        if (unclassified > 0) {
          logger.print(`  pending      ${String(unclassified)}  (run harbor classify)`);
        }

        const people = entityStats(db);
        const peoplePending = countPendingResolution(db, ENTITY_VERSION);

        logger.print("");
        const edges = countEdges(db);

        if (edges > 0) {
          logger.print(`Connections    ${edges.toLocaleString()} between items`);
          logger.print(
            `  situations   ${String(countThreads(db))} spanning more than one source`,
          );
          logger.print("");
        }

        logger.print(`Entities       resolver v${String(ENTITY_VERSION)}`);
        logger.print(
          `  people/orgs  ${String(people.entities)}` +
            (people.merged === 0 ? "" : `  (${String(people.merged)} merged away)`) +
            (people.pinned === 0 ? "" : `  ${String(people.pinned)} corrected by hand`),
        );
        logger.print(`  identifiers  ${String(people.identifiers)}`);
        logger.print(`  links        ${String(people.links)}`);
        logger.print(
          `  pending      ${String(peoplePending)}${peoplePending === 0 ? "" : "  (run `harbor dev resolve`)"}`,
        );
        logger.print("");

        if (accounts.length === 0) {
          logger.print("No connected accounts. Run `harbor auth google`.");
          return;
        }

        for (const account of accounts) {
          logger.print(`${account.label}  (${account.sourceType})`);
          logger.print(`  custodian    ${account.custodianPersonId}`);
          logger.print(`  items        ${String(countItems(db, account.id))}`);

          for (const stream of listStreams(db, account.id)) {
            const cursor =
              stream.cursor === null
                ? "none"
                : stream.cursor.length > 24
                  ? `${stream.cursor.slice(0, 24)}...`
                  : stream.cursor;
            logger.print(
              `  ${stream.connectorId.padEnd(10)} last sync ${when(stream.lastSyncAt)}  cursor ${cursor}`,
            );
          }

          for (const run of recentRuns(db, account.id, 4)) {
            logger.print(
              `  run ${String(run.id).padEnd(4)} ${run.mode.padEnd(12)} ${run.state.padEnd(9)} ` +
                `${String(run.fetched)} seen  ${when(run.startedAt)}`,
            );
          }
        }

        const coverage = coverageFor(db, DEFAULT_PRINCIPAL);

        logger.print("");
        logger.print("Coverage");

        for (const entry of coverageByKind(db, DEFAULT_PRINCIPAL)) {
          logger.print(
            `  ${entry.kind.padEnd(9)} ${String(entry.count).padStart(6)}   ` +
              `${when(entry.oldest)}  ->  ${when(entry.newest)}`,
          );
        }

        logger.print(`  received     ${String(coverage.inbound)}`);
        logger.print(`  sent         ${String(coverage.outbound)}`);
        logger.print(
          `  full ingest  ${coverage.complete ? "yes" : "no (run `harbor sync --backfill`)"}`,
        );

        const received = mostRecent(db, DEFAULT_PRINCIPAL, "inbound", 1)[0];
        const sent = mostRecent(db, DEFAULT_PRINCIPAL, "outbound", 1)[0];

        logger.print("");
        logger.print(
          `Newest received  ${received === undefined ? "none" : `${when(received.item.occurredAt)}  ${received.item.title ?? "(no subject)"}`}`,
        );
        logger.print(
          `Newest sent      ${sent === undefined ? "none" : `${when(sent.item.occurredAt)}  ${sent.item.title ?? "(no subject)"}`}`,
        );
      } finally {
        db.close();
      }
    });

  facts
    .command("add")
    .argument("<statement>", "something durable about you")
    .description("Tell Harbor a standing fact about yourself")
    .option("--kind <kind>", "preference | constraint | relationship | routine | detail")
    .action((statement: string, options: { kind?: string }) => {
      const { db } = openDatabase();

      try {
        const kinds = ["preference", "constraint", "relationship", "routine", "detail"] as const;
        const kind = kinds.find((entry) => entry === options.kind) ?? "detail";

        // Stated by the person, so confirmed on the spot. The proposal flow
        // exists for things Harbor noticed, not for things it was told.
        const outcome = recordFact(db, {
          principalId: DEFAULT_PRINCIPAL,
          kind,
          statement,
          state: "confirmed",
          confidence: 1,
          origin: "stated",
        });

        logger.print(
          outcome.created
            ? `Noted. ${outcome.id}`
            : `Already known (${outcome.state}). ${outcome.id}`,
        );
      } finally {
        db.close();
      }
    });

  facts
    .command("list", { isDefault: true })
    .description("What Harbor knows about you, and what it suspects")
    .option("--proposed", "only the ones waiting on you")
    .option("--rejected", "only the ones you turned down")
    .action((options: { proposed?: boolean; rejected?: boolean }) => {
      const { db } = openDatabase();

      try {
        const state =
          options.proposed === true ? "proposed" : options.rejected === true ? "rejected" : undefined;

        const found = listFacts(db, DEFAULT_PRINCIPAL, state);

        if (found.length === 0) {
          logger.print(
            state === "proposed"
              ? "Nothing waiting. Run `harbor dev notice` to look through your conversations."
              : "Nothing yet. Add one with `harbor facts add \"...\"`.",
          );
          return;
        }

        for (const fact of found) {
          const marker =
            fact.state === "confirmed" ? "[x]" : fact.state === "rejected" ? "[-]" : "[?]";

          logger.print(`${marker} ${fact.kind.padEnd(13)} ${fact.statement}`);
          logger.print(`    ${fact.id}  from ${fact.origin}`);

          if (fact.quote !== null) {
            logger.print(`    "${fact.quote.slice(0, 90)}"`);
          }
        }

        const counts = countFacts(db, DEFAULT_PRINCIPAL);
        logger.print("");
        logger.print(
          `${String(counts.confirmed)} confirmed, ${String(counts.proposed)} waiting, ${String(counts.rejected)} rejected.`,
        );

        if (counts.proposed > 0 && state === undefined) {
          logger.print("Only confirmed facts are ever used. `harbor facts confirm <id>` or `harbor facts reject <id>`.");
        }
      } finally {
        db.close();
      }
    });

  facts
    .command("confirm")
    .argument("<id>", "a fact id")
    .description("Accept something Harbor proposed about you")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        const fact = getFact(db, id);

        if (fact === null) {
          logger.print("No such fact.");
          return;
        }

        decideFact(db, id, "confirmed");
        logger.print(`Confirmed: ${fact.statement}`);
        logger.print("This will now shape answers.");
      } finally {
        db.close();
      }
    });

  facts
    .command("reject")
    .argument("<id>", "a fact id")
    .description("Turn down something Harbor proposed, permanently")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        const fact = getFact(db, id);

        if (fact === null) {
          logger.print("No such fact.");
          return;
        }

        // Permanent by design. Re-reading the same conversation next month must
        // not resurrect something already turned down.
        decideFact(db, id, "rejected");
        logger.print(`Rejected: ${fact.statement}`);
        logger.print("Harbor will not propose this again.");
      } finally {
        db.close();
      }
    });

  facts
    .command("forget")
    .argument("<id>", "a fact id")
    .description("Delete a fact entirely")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        logger.print(forgetFact(db, id) ? "Gone." : "No such fact.");
      } finally {
        db.close();
      }
    });

  dev
    .command("notice")
    .description("Look through conversations for standing facts about you")
    .option("--dry-run", "show what would be read, and spend nothing")
    .option("-n, --limit <count>", "conversations to read, default 20")
    .action(async (options: { dryRun?: boolean; limit?: string }) => {
      const { db } = openDatabase();

      try {
        const limit = options.limit === undefined ? 20 : Number.parseInt(options.limit, 10);
        const budget = Number.isFinite(limit) ? limit : 20;

        if (options.dryRun === true) {
          const candidates = factCandidates(db, budget);

          logger.print(`${String(candidates.length)} conversations would be read:`);
          logger.print("");

          for (const candidate of candidates) {
            logger.print(`  ${when(candidate.endsAt)}  ${candidate.participants.join(", ")}`);
            logger.print(`    ${candidate.preview}`);
          }

          return;
        }

        const report = await proposeFacts(db, {
          principalId: DEFAULT_PRINCIPAL,
          limit: budget,
          onNote: (message) => {
            logger.print(`  note: ${message}`);
          },
        });

        logger.print(`Read           ${String(report.read)} of ${String(report.considered)} flagged`);
        logger.print(`Proposed       ${String(report.proposed)}`);

        if (report.rejected.length > 0) {
          logger.print(`Discarded      ${String(report.rejected.length)}`);

          for (const reason of report.rejected.slice(0, 4)) {
            logger.print(`  ${reason}`);
          }
        }

        if (report.model !== null) {
          logger.print(`Model          ${report.model} (${formatCost(report.costMicros)})`);
        }

        logger.print(`Remaining      ${String(report.remaining)} conversations`);
        logger.print("");
        logger.print("Nothing here is used until you confirm it: `harbor facts --proposed`.");
      } finally {
        db.close();
      }
    });

  program
    .command("topics")
    .description("Subjects that keep coming up in your conversations")
    .action(() => {
      const { db } = openDatabase();

      try {
        const rows = db
          .prepare(
            `SELECT term, episode_count, first_at, last_at FROM topics
             WHERE principal_id = ? ORDER BY episode_count DESC`,
          )
          .all(DEFAULT_PRINCIPAL) as {
          term: string;
          episode_count: number;
          first_at: number;
          last_at: number;
        }[];

        if (rows.length === 0) {
          logger.print("Nothing recurring yet. Computed by `harbor dev signals`.");
          return;
        }

        for (const row of rows) {
          logger.print(
            `${row.term.padEnd(24)} ${String(row.episode_count)} conversations  ` +
              `${when(row.first_at)} to ${when(row.last_at)}`,
          );
        }
      } finally {
        db.close();
      }
    });

  program
    .command("doctor")
    .description("What is broken, what is exposed, and what to run about it")
    .action(async () => {
      const { db } = openDatabase();

      try {
        const report = await doctor(db);

        for (const finding of report.findings) {
          const marker =
            finding.severity === "problem" ? "[!]" : finding.severity === "warn" ? "[~]" : "[ok]";

          logger.print(`${marker.padEnd(5)} ${finding.area.padEnd(22)} ${finding.detail}`);

          if (finding.fix !== null) {
            logger.print(`                             -> ${finding.fix}`);
          }
        }

        logger.print("");
        logger.print(
          report.problems === 0 && report.warnings === 0
            ? "Nothing to do."
            : `${String(report.problems)} problem(s), ${String(report.warnings)} warning(s).`,
        );
      } finally {
        db.close();
      }
    });

  settings
    .command("secrets")
    .description("Where your credentials are stored")
    .option("--move", "move them into the operating system keychain")
    .action(async (options: { move?: boolean }) => {
      const { db } = openDatabase();

      try {
        const backend = await detectKeychain();

        if (options.move !== true) {
          logger.print(`Keychain       ${backend === "none" ? "not available on this machine" : backend}`);
          logger.print("");

          for (const account of listAccounts(db)) {
            const where = isKeychainBacked(db, account.id) ? "keychain" : "database (plain text)";
            logger.print(`  ${account.sourceType.padEnd(14)} ${where.padEnd(22)} ${account.label}`);
          }

          if (backend !== "none") {
            logger.print("");
            logger.print("Move them with `harbor settings secrets --move`.");
          }

          return;
        }

        if (backend === "none") {
          logger.print("No keychain available here, so there is nowhere to move them to.");
          return;
        }

        for (const account of listAccounts(db)) {
          const result = await moveCredentialsToKeychain(db, account.id);

          logger.print(
            `  ${account.sourceType.padEnd(14)} ${result.moved ? "moved" : `skipped: ${result.reason ?? "?"}`}`,
          );
        }

        logger.print("");
        logger.print("The database now holds references. Re-run `harbor doctor` to confirm.");
      } finally {
        db.close();
      }
    });

  program
    .command("restore")
    .argument("<file>", "an encrypted backup")
    .argument("<target>", "where to write the restored database")
    .description("Decrypt a backup to a new file")
    .option("--passphrase <value>", "for scripts; prompts when omitted")
    .action(async (file: string, target: string, options: { passphrase?: string }) => {
      const passphrase = options.passphrase ?? (await promptHidden("Passphrase: "));

      // Never restores over the live database. Writing to a new path and letting
      // a person move it themselves means a wrong passphrase or a wrong file
      // costs nothing.
      const size = restoreBackup(file, passphrase, target);

      logger.print(`Wrote  ${target}`);
      logger.print(`Size   ${formatBytes(size)}`);
      logger.print("");
      logger.print("Check it opens, then move it over harbor.db with Harbor not running.");
    });

  program
    .command("backup")
    .argument("[path]", "where to write the snapshot")
    .description("Write a consistent snapshot of the store")
    .option("--encrypt", "encrypt it with a passphrase you supply")
    .option("--passphrase <value>", "for scripts; prompts when omitted")
    .option("--plain", "acknowledge writing an unencrypted copy")
    .action(async (path: string | undefined, options: { encrypt?: boolean; passphrase?: string; plain?: boolean }) => {
      const { db } = openDatabase();

      try {
        if (options.encrypt === true || options.passphrase !== undefined) {
          const passphrase =
            options.passphrase ?? (await promptHidden("Passphrase (you will need this to restore): "));

          const result = encryptedBackup(db, passphrase, path);

          logger.print(`Wrote  ${result.path}`);
          logger.print(`Size   ${formatBytes(result.bytes)}`);
          logger.print(`Took   ${formatDuration(result.durationMs)}`);
          logger.print("");
          logger.print("Encrypted with AES-256-GCM. There is no recovery if you lose the passphrase.");
          logger.print("Restore with `harbor restore <file> <target>`.");
          return;
        }

        // Said plainly rather than buried. A backup is the copy of Harbor most
        // likely to end up somewhere Harbor does not control, and this one holds
        // every message in the store in the clear.
        if (options.plain !== true) {
          logger.print("An unencrypted backup is a complete, readable copy of everything Harbor holds,");
          logger.print("including messages other people wrote. Use --encrypt, or --plain to do it anyway.");
          return;
        }

        const result = backup(db, path);
        logger.print(`Wrote  ${result.path}`);
        logger.print(`Size   ${formatBytes(result.bytes)}`);
        logger.print(`Took   ${formatDuration(result.durationMs)}`);
        logger.print("");
        logger.print("This file is not encrypted.");
        logger.print("Restore by copying it over harbor.db with Harbor not running.");
      } finally {
        db.close();
      }
    });

  dev
    .command("raw")
    .argument("<id>", "Harbor item id")
    .description("Print the verbatim source payload for one item")
    .action((id: string) => {
      const { db } = openDatabase();

      try {
        const raw = readRaw(db, id);

        if (raw === null) {
          throw new HarborError(`No item with id ${id}`, {
            code: "precondition.no_item",
            exitCode: EXIT_CODES.precondition,
            hint: "Ids come from `harbor ask --evidence`.",
          });
        }

        logger.print(JSON.stringify(raw, null, 2));
      } finally {
        db.close();
      }
    });

  await program.parseAsync(process.argv);
  return EXIT_CODES.success;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof HarborError) {
      logger.error(error.message);
      if (error.hint !== undefined) {
        logger.error(error.hint);
      }
      process.exitCode = error.exitCode;
      return;
    }

    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_CODES.failure;
  });
