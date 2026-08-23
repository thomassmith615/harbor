/**
 * Task classes.
 *
 * Code never names a model. It declares what a piece of work needs, and the
 * router resolves that to the cheapest tier that satisfies it. Adding a model
 * or reordering the ladder is a change to this file and `router.ts`, and to
 * nothing else in Harbor.
 */

export type Tier = "local_small" | "local_large" | "cloud_cheap" | "cloud_premium";

/** The ladder, cheapest first. Order is meaningful; the router walks it. */
export const TIERS: readonly Tier[] = [
  "local_small",
  "local_large",
  "cloud_cheap",
  "cloud_premium",
];

export type Capability = "tools" | "json" | "long_context";
export type PrivacyClass = "local_only" | "cloud_ok";
export type LatencyClass = "interactive" | "background" | "batch";

/**
 * How a task's output is checked.
 *
 * An escalation ladder with no quality signal degrades silently: it will look
 * like it is working and cost almost nothing while producing worse answers
 * every month. Every task class has to declare how it would notice.
 */
export type Verification =
  /** Output must parse against a schema. Free, catches most failures. */
  | "schema"
  /** A caller-supplied predicate, for arithmetic that must reconcile. */
  | "cross_check"
  /** One in N also goes to the top tier and the answers are compared. */
  | "shadow"
  /** No automated check. Only legitimate where a human reads every output. */
  | "human";

export interface TaskClass {
  readonly id: string;
  readonly description: string;
  readonly requires: readonly Capability[];
  readonly privacy: PrivacyClass;
  readonly latency: LatencyClass;
  readonly verification: Verification;
  /** Lowest tier this task may use, regardless of what the router prefers. */
  readonly floor?: Tier;
  /** Fraction of calls shadowed against the top tier, when verification is shadow. */
  readonly shadowRate?: number;
  readonly maxTokens?: number;
  /** Identical input yields identical output, so results can be cached. */
  readonly cacheable: boolean;
}

export const TASK_CLASSES: readonly TaskClass[] = [
  {
    id: "ask.converse",
    description: "Answering a question against the user's data, using tools.",
    requires: ["tools", "long_context"],
    privacy: "cloud_ok",
    latency: "interactive",
    // A human reads every word of this one, so an automated check would be
    // measuring something the user is already measuring.
    verification: "human",
    floor: "cloud_cheap",
    maxTokens: 4096,
    cacheable: false,
  },
  {
    id: "brief.phrase",
    description: "Turning queued observations into a few readable sentences.",
    requires: [],
    privacy: "cloud_ok",
    latency: "background",
    verification: "human",
    maxTokens: 800,
    cacheable: false,
  },
  {
    id: "chat.summarize",
    description: "Compressing the earlier part of a conversation so it can be carried forward.",
    requires: [],
    // The material being summarized already reached a model on the turn it was
    // said, so summarizing it locally buys nothing and costs quality.
    privacy: "cloud_ok",
    latency: "background",
    // A human reads the downstream answers, which is where a bad summary shows
    // up. Shadowing a free-form summary against another model would compare two
    // valid paraphrases and learn nothing.
    verification: "human",
    maxTokens: 500,
    cacheable: false,
  },
  {
    id: "classify.sensitivity",
    description: "Deciding how sensitive an item is when the rules are unsure.",
    requires: ["json"],
    // Ironic otherwise: shipping an item to a third party to ask whether it
    // should be shipped to a third party.
    privacy: "local_only",
    latency: "batch",
    verification: "shadow",
    shadowRate: 0.02,
    maxTokens: 200,
    cacheable: true,
  },
  {
    id: "situation.summarize",
    description: "Saying in one sentence what a situation is about, from its members.",
    requires: [],
    // This was local_only and a 3B model wrote nonsense with it: a haircut
    // reminder became a trip to Puerto Rico, a taxi receipt became a trip to
    // the taxi office, and roughly every situation became "a trip". Reading six
    // fragments and saying what they have in common is a harder task than it
    // looks, and no prompt rescues a model that small from it.
    //
    // The privacy trade is smaller than it appears. Asking Harbor anything
    // already sends item content to the same tier under the same policy gate,
    // so a summary of things the chat would happily quote is not a new
    // disclosure. What it buys is the difference between a sentence worth
    // reading and one that makes the whole surface untrustworthy.
    privacy: "cloud_ok",
    // Named rather than inferred. Leaving it to capability matching would send
    // this back to the cheapest tier that technically satisfies "no
    // requirements", which is exactly where it started.
    floor: "cloud_cheap",
    latency: "batch",
    // Two models would write two valid sentences and agree on nothing, so a
    // shadow comparison teaches nothing here. The person reads this directly,
    // above the evidence it claims to summarise, which is the real check.
    verification: "human",
    maxTokens: 200,
    cacheable: true,
  },
  {
    id: "extract.structured",
    description: "Pulling structured records out of an item, for projections.",
    requires: ["json"],
    privacy: "cloud_ok",
    latency: "batch",
    verification: "schema",
    shadowRate: 0.02,
    maxTokens: 1500,
    cacheable: true,
  },
];

export function taskClass(id: string): TaskClass {
  const found = TASK_CLASSES.find((entry) => entry.id === id);

  if (found === undefined) {
    throw new Error(`Unknown task class: ${id}`);
  }

  return found;
}

/**
 * Prices, in micros per million tokens.
 *
 * Deliberately a table rather than a lookup: prices move, and a wrong number
 * here produces a misleading spend report rather than a broken system, so it
 * should be easy to correct without touching logic.
 */
export interface Price {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

const DEFAULT_PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5": { inputPerMillion: 15_000_000, outputPerMillion: 75_000_000 },
  "claude-sonnet-5": { inputPerMillion: 3_000_000, outputPerMillion: 15_000_000 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1_000_000, outputPerMillion: 5_000_000 },
};

export function priceFor(model: string): Price {
  for (const [name, price] of Object.entries(DEFAULT_PRICES)) {
    if (model.startsWith(name)) {
      return price;
    }
  }

  // Local models cost electricity, which Harbor does not meter.
  return { inputPerMillion: 0, outputPerMillion: 0 };
}

export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);

  return Math.round(
    (inputTokens * price.inputPerMillion) / 1_000_000 +
      (outputTokens * price.outputPerMillion) / 1_000_000,
  );
}

export function formatCost(micros: number): string {
  const dollars = micros / 1_000_000;

  if (dollars === 0) {
    return "free";
  }

  if (dollars < 0.01) {
    return `<$0.01`;
  }

  return `$${dollars.toFixed(2)}`;
}
