/**
 * Setup state, and what is currently wrong.
 *
 * Two questions a client asks constantly and Harbor previously could not
 * answer: am I finished setting up, and is anything broken right now.
 *
 * Nearly every screen in a front end is a view over these two objects, which is
 * why they are computed here rather than assembled ad hoc per endpoint.
 */
import { countPendingResolution, entityStats } from "../store/entities.js";
import { countSituations } from "../store/relationships.js";
import { itemsByAccount } from "../store/coverage.js";
import { listJobs } from "../store/jobs.js";
import { taskAvailability } from "../jobs/runner.js";
import { SOURCE_TYPES } from "../connectors/registry.js";
import { available as imessageAvailable } from "../connectors/imessage/messages.js";
import { countPending, deriveStats } from "../store/chunks.js";
import { countUnclassified, CLASSIFIER_VERSION } from "../derive/classify.js";
import { coverageByKind, coverageFor, databaseSize } from "../store/coverage.js";
import { listAccounts } from "../store/accounts.js";
import { listDevices } from "../store/devices.js";
import { listInterests } from "../store/signals.js";
import { listRules } from "../policy/rules.js";
import { listStreams } from "../store/streams.js";
import { ENTITY_VERSION } from "../derive/entities.js";
import { PIPELINE_VERSION } from "../derive/pipeline.js";
import { vectorBackend } from "../retrieval/vector.js";
import { activeJob } from "../store/jobs.js";
import type { DB } from "../kernel/db.js";

export interface SetupStep {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
  readonly detail: string;
  /** True when this step is what the user should be doing next. */
  readonly current: boolean;
  /** A job that would advance this step, if one applies. */
  readonly job?: string;
}

export interface SetupState {
  readonly complete: boolean;
  readonly steps: readonly SetupStep[];
  readonly runningJob: string | null;
}

export function setupState(db: DB, principalId: string): SetupState {
  const accounts = listAccounts(db);
  const devices = listDevices(db).filter((device) => !device.revoked);
  const coverage = coverageFor(db, principalId);
  const unclassified = countUnclassified(db, CLASSIFIER_VERSION);
  const underived = countPending(db, PIPELINE_VERSION);
  const unresolved = countPendingResolution(db, ENTITY_VERSION);
  const interests = listInterests(db, principalId);

  const raw: Omit<SetupStep, "current">[] = [
    {
      id: "device",
      label: "Pair a device",
      done: devices.length > 0,
      detail:
        devices.length === 0
          ? "Nothing is paired yet"
          : `${String(devices.length)} paired`,
    },
    {
      id: "sources",
      label: "Connect a source",
      done: accounts.length > 0,
      detail:
        accounts.length === 0
          ? "No accounts connected"
          : // Qualified by source, because one address can be two accounts. An
            // Apple ID and an IMAP mailbox on the same address rendered as the
            // same string twice, which reads as a duplicate rather than as two
            // distinct connections with separate cursors and separate weights.
            accounts
              .map((account) => `${account.label} (${account.sourceType})`)
              .join(", "),
    },
    {
      id: "ingest",
      label: "Read your data",
      done: coverage.complete && coverage.items > 0,
      detail: coverage.complete
        ? `${String(coverage.items)} items`
        : `${String(coverage.items)} items so far`,
      job: "backfill",
    },
    {
      id: "classify",
      label: "Label sensitivity",
      done: unclassified === 0 && coverage.items > 0,
      detail: unclassified === 0 ? "up to date" : `${String(unclassified)} pending`,
      job: "classify",
    },
    {
      id: "derive",
      label: "Make it searchable",
      done: underived === 0 && coverage.items > 0,
      detail: underived === 0 ? "up to date" : `${String(underived)} pending`,
      job: "derive",
    },
    {
      id: "resolve",
      label: "Work out who is who",
      done: unresolved === 0 && coverage.items > 0,
      detail: unresolved === 0 ? "up to date" : `${String(unresolved)} pending`,
      job: "resolve",
    },
    {
      id: "interests",
      label: "Say what you are working on",
      done: interests.length > 0,
      detail:
        interests.length === 0
          ? "Harbor has nothing to watch for yet"
          : `${String(interests.length)} active`,
    },
  ];

  // Exactly one step is "current": the first unfinished one. A client showing
  // three simultaneous calls to action is a client nobody finishes.
  const firstUnfinished = raw.findIndex((step) => !step.done);

  const steps = raw.map((step, index) => ({ ...step, current: index === firstUnfinished }));

  const running =
    ["onboard", "backfill", "sync", "derive", "resolve", "classify", "signals"]
      .map((task) => activeJob(db, task))
      .find((job) => job !== null) ?? null;

  return {
    complete: firstUnfinished === -1,
    steps,
    runningJob: running?.id ?? null,
  };
}

export type ProblemSeverity = "error" | "warning";

export interface Problem {
  readonly id: string;
  readonly severity: ProblemSeverity;
  readonly message: string;
  readonly fix: string;
}

/**
 * Things that are wrong right now.
 *
 * Every one of these previously surfaced on stderr, where nobody was looking.
 * An expired credential means Harbor quietly stops learning anything new, and
 * the only symptom is answers that feel slightly stale.
 */
export function problems(db: DB, principalId: string): readonly Problem[] {
  const found: Problem[] = [];

  if (listRules(db).length === 0) {
    // Zero rules means the gate implicit-denies everything, which looks exactly
    // like retrieval returning nothing for no reason. Loudest problem there is.
    found.push({
      id: "policy.empty",
      severity: "error",
      message: "No egress policy is configured, so nothing can be sent to a model",
      fix: "Run `harbor init` to seed the built-in rules",
    });
  }

  if (listAccounts(db).length === 0) {
    found.push({
      id: "sources.none",
      severity: "warning",
      message: "No sources are connected",
      fix: "Connect Google or Apple",
    });
  }

  for (const stream of listStreams(db)) {
    if (stream.lastSyncAt === null) {
      continue;
    }

    const age = Date.now() - stream.lastSyncAt;

    if (age > 3 * 86_400_000) {
      found.push({
        id: `stream.stale.${stream.connectorId}`,
        severity: "warning",
        message: `${stream.connectorId} has not synced in ${String(Math.floor(age / 86_400_000))} days`,
        fix: "Run a sync, or check the credential is still valid",
      });
    }
  }

  const derived = deriveStats(db);

  if (derived.embeddings === 0 && coverageFor(db, principalId).items > 0) {
    found.push({
      id: "derive.none",
      severity: "warning",
      message: "Nothing has been embedded, so search is keyword only",
      fix: "Start an embedding server and run derive",
    });
  }

  if (vectorBackend(db) === "scan" && derived.embeddings > 0) {
    found.push({
      id: "vector.scan",
      severity: "warning",
      message: "The vector index did not load; semantic search is running as a scan",
      fix: "Reinstall sqlite-vec. Search still works, just slower",
    });
  }

  const unclassified = countUnclassified(db, CLASSIFIER_VERSION);

  if (unclassified > 0) {
    found.push({
      id: "classify.pending",
      severity: "warning",
      message: `${String(unclassified)} items have no sensitivity label and are being withheld`,
      fix: "Run classify",
    });
  }

  return found;
}

export interface SystemStatus {
  readonly items: number;
  readonly databaseBytes: number;
  readonly coverage: ReturnType<typeof coverageByKind>;
  readonly entities: ReturnType<typeof entityStats>;
  readonly vectorBackend: string;
  readonly pipelineVersion: number;
  readonly entityVersion: number;
  readonly classifierVersion: number;
}

export function systemStatus(db: DB, principalId: string): SystemStatus {
  return {
    items: coverageFor(db, principalId).items,
    databaseBytes: databaseSize(db),
    coverage: coverageByKind(db, principalId),
    entities: entityStats(db),
    vectorBackend: vectorBackend(db),
    pipelineVersion: PIPELINE_VERSION,
    entityVersion: ENTITY_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
  };
}

/**
 * Everything a client needs to draw itself, in one call.
 *
 * The page polls, and a poll that fans out into six requests is six chances
 * for a partial picture: sources from one instant, jobs from another, and a
 * screen that contradicts itself for a second every time something finishes.
 * One object, one instant.
 *
 * Nothing is computed here. Every field is a function the CLI already calls,
 * which is the rule that keeps a third surface cheap.
 */
export interface OverviewSource {
  readonly accountId: string;
  readonly label: string;
  readonly sourceType: string;
  readonly items: number;
  readonly newest: number | null;
  readonly streams: readonly {
    readonly id: string;
    readonly connector: string;
    readonly lastSyncAt: number | null;
    readonly recentDone: boolean;
    readonly historicalDone: boolean;
    readonly oldestReached: number | null;
  }[];
}

export interface Connectable {
  readonly sourceType: string;
  readonly connected: boolean;
  /** More than one account of this type is normal. */
  readonly multiple: boolean;
  readonly available: boolean;
  readonly reason: string;
}

export function overview(db: DB, principalId: string): Record<string, unknown> {
  const accounts = listAccounts(db);
  const streams = listStreams(db);
  const counts = new Map(itemsByAccount(db, principalId).map((row) => [row.accountId, row]));

  const sources: OverviewSource[] = accounts.map((account) => ({
    accountId: account.id,
    label: account.label,
    sourceType: account.sourceType,
    items: counts.get(account.id)?.count ?? 0,
    newest: counts.get(account.id)?.newest ?? null,
    streams: streams
      .filter((stream) => stream.accountId === account.id)
      .map((stream) => ({
        id: stream.id,
        connector: stream.connectorId,
        lastSyncAt: stream.lastSyncAt,
        recentDone: stream.recentDone,
        historicalDone: stream.historicalDone,
        oldestReached: stream.oldestReached,
      })),
  }));

  const connected = new Set(accounts.map((account) => account.sourceType));

  // Why a source cannot be connected, said in the place the button is, rather
  // than as a failure after somebody taps it.
  const connectable: Connectable[] = SOURCE_TYPES.map((sourceType) => {
    const usable =
      sourceType === "imessage"
        ? imessageAvailable()
        : sourceType === "google"
          ? (process.env["GOOGLE_CLIENT_ID"] ?? "").length > 0
          : true;

    const reason =
      sourceType === "imessage"
        ? "Only on the Mac holding the messages, and it needs Full Disk Access."
        : sourceType === "google"
          ? "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in ~/.harbor/.env first."
          : "";

    return {
      sourceType,
      connected: connected.has(sourceType),
      multiple: sourceType === "imap" || sourceType === "google",
      available: usable,
      reason,
    };
  });

  const jobs = listJobs(db, 14);
  const entities = entityStats(db);

  return {
    ok: true,
    at: Date.now(),
    items: coverageFor(db, principalId).items,
    databaseBytes: databaseSize(db),
    people: entities.entities,
    situations: countSituations(db, principalId),
    sources,
    connectable,
    jobs,
    running: jobs.filter((job) => job.state === "running" || job.state === "queued"),
    availability: taskAvailability(db),
    problems: problems(db, principalId),
    setupComplete: setupState(db, principalId).complete,
  };
}
