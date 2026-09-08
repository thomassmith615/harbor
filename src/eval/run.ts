/**
 * Running a scenario through whatever Harbor currently does.
 *
 * Deliberately written against the outputs rather than the internals, so it
 * measures the two competing world models on the same footing and keeps working
 * across a rewrite. Harbor has two representations of "these things go
 * together" and they disagree:
 *
 *   `stories` are frames plus gathered members. Membership is judged against
 *   the frame's own anchors, so nothing is transitive.
 *
 *   `situations` are connected components of the relationship graph, which is
 *   single-linkage clustering and chains by construction. `gather.ts` opens with
 *   a long argument against exactly this and the pass that does it is still
 *   running.
 *
 * Both are scored, separately and combined, because the honest question is not
 * which is better in isolation but what a person actually sees, and today they
 * see both.
 */
import { derive } from "../derive/pipeline.js";
import { resolveEntities } from "../derive/entities.js";
import { anchorNodes, buildStories } from "../derive/stories.js";
import { relate } from "../derive/relate.js";
import { inferEvents } from "../events/infer.js";
import { seedScenario } from "../fixtures/coordination.js";
import { fixtureEmbedder, openTestStore } from "../fixtures/harness.js";
import { storyMembers, topStories } from "../store/stories.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import { score, summarize, type Predicted, type SuiteResult } from "./coordination.js";
import type { DB } from "../kernel/db.js";
import type { Scenario } from "../fixtures/coordination.js";

export type Model = "stories" | "situations" | "both" | "events";

/**
 * Observation ids behind a node.
 *
 * An episode is not an observation; it is a container for several, so a story
 * containing one episode is a claim about every message in it. Expanding rather
 * than treating the episode as a unit is what makes the metric comparable
 * across a design that segments conversations differently, and it is also the
 * honest reading: if Harbor says this conversation is part of the evening, it
 * has said that about each message in it.
 */
function observationsOf(db: DB, kind: string, id: string): readonly string[] {
  if (kind === "episode") {
    const rows = db
      .prepare(
        `SELECT i.external_id AS id FROM episode_items ei
         JOIN items i ON i.id = ei.item_id
         WHERE ei.episode_id = ?`,
      )
      .all(id) as { id: string }[];

    return rows.map((row) => row.id);
  }

  const row = db.prepare(`SELECT external_id AS id FROM items WHERE id = ?`).get(id) as
    | { id: string }
    | undefined;

  return row === undefined ? [] : [row.id];
}

function storyClusters(db: DB): Predicted {
  return topStories(db, DEFAULT_PRINCIPAL, { limit: 200 }).map((story) =>
    storyMembers(db, story.id).flatMap((member) =>
      observationsOf(db, member.ref.kind, member.ref.id),
    ),
  );
}

/**
 * The new model's clusters.
 *
 * An event's observations, expanded to the observation ids underneath, exactly
 * as for the other two. Read from the store rather than from the inference
 * pass's return value, because what is worth measuring is what a person would
 * be shown.
 */
function eventClusters(db: DB): Predicted {
  const rows = db.prepare(`SELECT id FROM events`).all() as { id: string }[];

  return rows.map((row) =>
    observationsOf2(db, row.id),
  );
}

function observationsOf2(db: DB, eventId: string): readonly string[] {
  const nodes = db
    .prepare(`SELECT node_kind AS kind, node_id AS id FROM event_observations WHERE event_id = ?`)
    .all(eventId) as { kind: string; id: string }[];

  return nodes.flatMap((node) => observationsOf(db, node.kind, node.id));
}

function situationClusters(db: DB): Predicted {
  const rows = db.prepare(`SELECT id FROM threads`).all() as { id: string }[];

  return rows.map((row) => {
    const nodes = db
      .prepare(`SELECT node_kind AS kind, node_id AS id FROM thread_nodes WHERE thread_id = ?`)
      .all(row.id) as { kind: string; id: string }[];

    return nodes.flatMap((node) => observationsOf(db, node.kind, node.id));
  });
}

export interface RunOptions {
  readonly model?: Model;
  /** Print what each scenario produced. Used by the CLI, not by the test. */
  readonly onNote?: ((message: string) => void) | undefined;
}

/**
 * Seeds one scenario into a fresh store and runs the full derive pipeline.
 *
 * A store per scenario, deliberately. Sharing one would let the noise index and
 * the term index see traffic from other scenarios, which changes what counts as
 * a rare word and makes each case's result depend on the order of the suite.
 */
export async function runScenario(
  scenario: Scenario,
  options: RunOptions = {},
): Promise<SuiteResult> {
  const store = openTestStore();

  try {
    seedScenario(store.db, scenario);

    await derive(store.db, fixtureEmbedder(), { timezone: scenario.timezone });
    resolveEntities(store.db, {});
    anchorNodes(store.db, { timezone: scenario.timezone });

    buildStories(store.db, {
      principalId: DEFAULT_PRINCIPAL,
      timezone: scenario.timezone,
    });

    relate(store.db, { principalId: DEFAULT_PRINCIPAL, timezone: scenario.timezone });

    inferEvents(store.db, {
      principalId: DEFAULT_PRINCIPAL,
      timezone: scenario.timezone,
    });

    const model = options.model ?? "both";

    const predicted: Predicted =
      model === "stories"
        ? storyClusters(store.db)
        : model === "situations"
          ? situationClusters(store.db)
          : model === "events"
            ? eventClusters(store.db)
            : [...storyClusters(store.db), ...situationClusters(store.db)];

    options.onNote?.(
      `${scenario.name}: ${String(storyClusters(store.db).length)} stories, ` +
        `${String(situationClusters(store.db).length)} situations`,
    );

    return { scenario: scenario.name, score: score(scenario.gold, predicted) };
  } finally {
    store.close();
  }
}

export async function runSuite(
  scenarios: readonly Scenario[],
  options: RunOptions = {},
): Promise<ReturnType<typeof summarize>> {
  const results: SuiteResult[] = [];

  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, options));
  }

  return summarize(results);
}
