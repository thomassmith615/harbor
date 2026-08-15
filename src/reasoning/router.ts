/**
 * The model router.
 *
 * Resolves a task class to the cheapest tier that satisfies it, records what
 * that cost, and keeps a quality signal so the ladder cannot degrade silently.
 *
 * Three things make this an engine rather than an intention:
 *
 *   Nothing outside this file names a model. Callers declare a task class.
 *
 *   Every call is verified in some declared way. A tier whose shadow samples
 *   disagree with the top tier too often demotes itself and reports it, which
 *   is the only thing standing between "cheap by default" and "quietly worse
 *   every month".
 *
 *   Cheapest model is no model. The cache is checked before any tier is
 *   considered, keyed on task class plus input plus pipeline version.
 */
import { createHash } from "node:crypto";
import { anthropicProvider } from "./provider.js";
import { localModelFor, localProvider } from "./local.js";
import { costMicros, taskClass, TIERS } from "./tasks.js";
import { record } from "../store/audit.js";
import type { DB } from "../kernel/db.js";
import type { CompletionRequest, CompletionResult, Provider } from "./provider.js";
import type { Capability, TaskClass, Tier } from "./tasks.js";

interface TierSpec {
  readonly tier: Tier;
  readonly capabilities: readonly Capability[];
  readonly local: boolean;
  create(): Provider;
}

/**
 * The ladder.
 *
 * Model names appear here and nowhere else. Adding a provider is one entry.
 */
const LADDER: readonly TierSpec[] = [
  {
    tier: "local_small",
    capabilities: ["json"],
    local: true,
    create: () => localProvider(localModelFor("small")),
  },
  {
    tier: "local_large",
    capabilities: ["json", "long_context"],
    local: true,
    create: () => localProvider(localModelFor("large")),
  },
  {
    tier: "cloud_cheap",
    capabilities: ["json", "tools", "long_context"],
    local: false,
    create: () => anthropicProvider(process.env["HARBOR_CHEAP_MODEL"] ?? "claude-haiku-4-5-20251001"),
  },
  {
    tier: "cloud_premium",
    capabilities: ["json", "tools", "long_context"],
    local: false,
    create: () => anthropicProvider(process.env["HARBOR_MODEL"] ?? "claude-sonnet-5"),
  },
];

function specFor(tier: Tier): TierSpec {
  const found = LADDER.find((entry) => entry.tier === tier);

  if (found === undefined) {
    throw new Error(`No provider registered for tier ${tier}`);
  }

  return found;
}

function satisfies(spec: TierSpec, task: TaskClass): boolean {
  if (task.privacy === "local_only" && !spec.local) {
    return false;
  }

  return task.requires.every((capability) => spec.capabilities.includes(capability));
}

/** Disagreement rate above which a tier stops being used for a task class. */
const DEMOTE_RATE = 0.2;
const DEMOTE_MIN_SAMPLES = 20;

function demoted(db: DB, taskClassId: string, tier: Tier): boolean {
  const row = db
    .prepare(`SELECT demoted FROM router_quality WHERE task_class = ? AND tier = ?`)
    .get(taskClassId, tier) as { demoted: number } | undefined;

  return row !== undefined && row.demoted === 1;
}

/**
 * Picks a tier.
 *
 * Walks the ladder cheapest-first and takes the first tier that satisfies the
 * task's capability and privacy requirements, sits at or above its floor, and
 * has not demoted itself on quality.
 */
export function chooseTier(db: DB, task: TaskClass): Tier {
  const floorIndex = task.floor === undefined ? 0 : TIERS.indexOf(task.floor);

  for (let index = 0; index < TIERS.length; index += 1) {
    const tier = TIERS[index];

    if (tier === undefined || index < floorIndex) {
      continue;
    }

    const spec = specFor(tier);

    if (!satisfies(spec, task) || demoted(db, task.id, tier)) {
      continue;
    }

    return tier;
  }

  // Nothing satisfied the requirements. The top tier is the honest fallback,
  // except for local-only work, where going to the cloud would violate the
  // whole point and failing loudly is correct.
  if (task.privacy === "local_only") {
    throw new Error(
      `No local tier can serve ${task.id}. Start a local model server or change the task's ` +
        "privacy class deliberately.",
    );
  }

  return "cloud_premium";
}

/**
 * What makes two calls the same call.
 *
 * The model belongs in here, and its absence was expensive. Fifty extractions
 * against a model that returned nothing were cached, and switching models
 * replayed all fifty from cache in under a second: same failures, same reported
 * model name, one request in the server log, and no way to tell from the output
 * that nothing had actually run.
 *
 * A cached answer is an answer from a particular model. Change the model and it
 * is a different question.
 */
function cacheKey(
  taskClassId: string,
  request: CompletionRequest,
  version: number,
  model: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([taskClassId, version, model, request.system ?? "", request.messages]),
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * Whether a response is worth remembering.
 *
 * An empty completion is not a result, it is a failure that happened to return
 * 200, and caching one turns a transient problem into a permanent one. That is
 * exactly what happened: an empty answer from a model that spent its tokens
 * reasoning was stored, and every later run inherited it for free.
 */
function worthCaching(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * Which models this installation is currently configured to use.
 *
 * Part of the cache key, because a cached answer is an answer from a particular
 * model. Without it, changing the model replayed fifty cached failures in under
 * a second, reported the old model's name, and made one request to the server:
 * an experiment that looked like it ran and did not.
 *
 * The tier is not known until after routing, so this fingerprints the
 * configuration rather than the tier that ends up being used. Slightly coarse:
 * changing the large model invalidates entries the small model produced. That
 * is the right trade, because a stale hit is silent and a recomputation is
 * merely slow.
 */
function modelFingerprint(): string {
  return [
    localModelFor("small"),
    localModelFor("large"),
    process.env["HARBOR_MODEL"] ?? "",
  ].join("|");
}

export interface RouteOptions {
  readonly principalId: string;
  /** Included in the cache key so a logic change invalidates cached results. */
  readonly pipelineVersion?: number;
  /** Bytes of item content that reached the model, from the gate. */
  readonly bytesOut?: number;
  readonly itemIds?: readonly string[];
  readonly itemsIncluded?: number;
  readonly itemsWithheld?: number;
  readonly redactions?: number;
  readonly ruleIds?: readonly string[];
  readonly onNote?: (message: string) => void;
}

export interface RouteResult {
  readonly result: CompletionResult;
  readonly tier: Tier;
  readonly cached: boolean;
  readonly costMicros: number;
  readonly shadowed: boolean;
  readonly disagreed: boolean;
}

function textOf(result: CompletionResult): string {
  return result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function recordSample(db: DB, taskClassId: string, tier: Tier, disagreed: boolean): void {
  db.prepare(
    `INSERT INTO router_quality (task_class, tier, samples, disagreements, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (task_class, tier) DO UPDATE SET
       samples = samples + 1,
       disagreements = disagreements + excluded.disagreements,
       updated_at = excluded.updated_at`,
  ).run(taskClassId, tier, disagreed ? 1 : 0, Date.now());

  const row = db
    .prepare(`SELECT samples, disagreements, demoted FROM router_quality WHERE task_class = ? AND tier = ?`)
    .get(taskClassId, tier) as { samples: number; disagreements: number; demoted: number };

  if (
    row.demoted === 0 &&
    row.samples >= DEMOTE_MIN_SAMPLES &&
    row.disagreements / row.samples >= DEMOTE_RATE
  ) {
    db.prepare(
      `UPDATE router_quality SET demoted = 1, updated_at = ? WHERE task_class = ? AND tier = ?`,
    ).run(Date.now(), taskClassId, tier);
  }
}

/**
 * Runs one task through the ladder.
 *
 * The audit row is written whatever happens, including on failure, because a
 * log with gaps in it is not evidence of anything.
 */
export async function route(
  db: DB,
  taskClassId: string,
  request: CompletionRequest,
  options: RouteOptions,
): Promise<RouteResult> {
  const task = taskClass(taskClassId);
  const version = options.pipelineVersion ?? 1;

  if (task.cacheable) {
    const key = cacheKey(taskClassId, request, version, modelFingerprint());

    const hit = db.prepare(`SELECT value, model, tier FROM model_cache WHERE key = ?`).get(key) as
      | { value: string; model: string; tier: Tier }
      | undefined;

    // An empty cached value is a cached failure. Older rows may hold one, from
    // before empty answers stopped being stored, so they are ignored on read as
    // well as refused on write.
    if (hit !== undefined && worthCaching(hit.value)) {
      db.prepare(`UPDATE model_cache SET hits = hits + 1 WHERE key = ?`).run(key);

      return {
        result: {
          provider: "cache",
          model: hit.model,
          content: [{ type: "text", text: hit.value }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        tier: hit.tier,
        cached: true,
        costMicros: 0,
        shadowed: false,
        disagreed: false,
      };
    }
  }

  const tier = chooseTier(db, task);
  const provider = specFor(tier).create();

  const payload: CompletionRequest = {
    ...request,
    ...(task.maxTokens === undefined ? {} : { maxTokens: task.maxTokens }),
  };

  let result: CompletionResult;

  try {
    result = await provider.complete(payload);
  } catch (error: unknown) {
    record(db, {
      principalId: options.principalId,
      kind: "model_call",
      taskClass: taskClassId,
      provider: provider.id,
      model: provider.model,
      tier,
      outcome: "error",
      itemsIncluded: options.itemsIncluded ?? 0,
      itemsWithheld: options.itemsWithheld ?? 0,
      redactions: options.redactions ?? 0,
      bytesOut: options.bytesOut ?? 0,
      ...(options.itemIds === undefined ? {} : { itemIds: options.itemIds }),
      ...(options.ruleIds === undefined ? {} : { ruleIds: options.ruleIds }),
      note: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });

    throw error;
  }

  const cost = costMicros(result.model, result.usage.inputTokens, result.usage.outputTokens);

  // Shadow sampling: the general mechanism for noticing that a cheap tier has
  // stopped being good enough. Costs a controllable few percent.
  let shadowed = false;
  let disagreed = false;

  if (
    task.verification === "shadow" &&
    tier !== "cloud_premium" &&
    task.privacy !== "local_only" &&
    Math.random() < (task.shadowRate ?? 0.02)
  ) {
    shadowed = true;

    try {
      const reference = await specFor("cloud_premium").create().complete(payload);
      disagreed = normalize(textOf(reference)) !== normalize(textOf(result));
      recordSample(db, taskClassId, tier, disagreed);

      if (disagreed) {
        options.onNote?.(`shadow sample disagreed for ${taskClassId} on ${tier}`);
      }
    } catch {
      // A failed shadow is not a failed task. Drop it.
      shadowed = false;
    }
  }

  if (task.cacheable && worthCaching(textOf(result))) {
    db.prepare(
      `INSERT INTO model_cache (key, task_class, value, model, tier, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
    ).run(
      cacheKey(taskClassId, request, version, modelFingerprint()),
      taskClassId,
      textOf(result),
      result.model,
      tier,
      Date.now(),
    );
  }

  record(db, {
    principalId: options.principalId,
    kind: "model_call",
    taskClass: taskClassId,
    provider: result.provider,
    model: result.model,
    tier,
    outcome: "ok",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costMicros: cost,
    itemsIncluded: options.itemsIncluded ?? 0,
    itemsWithheld: options.itemsWithheld ?? 0,
    redactions: options.redactions ?? 0,
    bytesOut: options.bytesOut ?? 0,
    ...(options.itemIds === undefined ? {} : { itemIds: options.itemIds }),
    ...(options.ruleIds === undefined ? {} : { ruleIds: options.ruleIds }),
    ...(shadowed ? { note: disagreed ? "shadow: disagreed" : "shadow: agreed" } : {}),
  });

  return { result, tier, cached: false, costMicros: cost, shadowed, disagreed };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface QualityRow {
  readonly task_class: string;
  readonly tier: string;
  readonly samples: number;
  readonly disagreements: number;
  readonly demoted: number;
}

export function qualityStats(db: DB): readonly QualityRow[] {
  return db
    .prepare(`SELECT * FROM router_quality ORDER BY task_class, tier`)
    .all() as QualityRow[];
}

export function clearDemotion(db: DB, taskClassId: string, tier: string): void {
  db.prepare(
    `UPDATE router_quality SET demoted = 0, samples = 0, disagreements = 0, updated_at = ?
     WHERE task_class = ? AND tier = ?`,
  ).run(Date.now(), taskClassId, tier);
}

export function cacheStats(db: DB): { entries: number; hits: number } {
  const row = db
    .prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits FROM model_cache`)
    .get() as { entries: number; hits: number };

  return row;
}
