/**
 * The classification pass.
 *
 * Same shape as every other derivation: versioned, incremental, re-runnable,
 * driven off a column the item upsert clears when content changes.
 *
 * Entirely deterministic, and that is the interesting part. Classifying 17,000
 * messages with a model would cost more than every other operation Harbor
 * performs put together, and would be less reliable: a regex that finds an AWS
 * key prefix beats a model asked whether text "looks sensitive". The model tier
 * declared on `classify.sensitivity` exists for a future ambiguous remainder,
 * and running this pass never reaches it.
 */
import { classify, CLASSIFIER_VERSION } from "../policy/classify.js";
import type { DB } from "../kernel/db.js";
import type { Sensitivity } from "../policy/classify.js";

export { CLASSIFIER_VERSION } from "../policy/classify.js";

const BATCH = 1000;

export interface ClassifyOptions {
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface ClassifyReport {
  readonly examined: number;
  readonly normal: number;
  readonly sensitive: number;
  readonly restricted: number;
  readonly version: number;
  readonly remaining: number;
  readonly durationMs: number;
}

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly author: string | null;
}

export function countUnclassified(db: DB, version: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items
       WHERE deleted_at IS NULL
         AND (classified_version IS NULL OR classified_version <> ?)`,
    )
    .get(version) as { n: number };

  return row.n;
}

export function classifyItems(db: DB, options: ClassifyOptions = {}): ClassifyReport {
  const started = Date.now();

  const total = Math.min(
    countUnclassified(db, CLASSIFIER_VERSION),
    options.limit ?? Number.MAX_SAFE_INTEGER,
  );

  const counts: Record<Sensitivity, number> = { normal: 0, sensitive: 0, restricted: 0 };
  let examined = 0;

  const update = db.prepare(
    `UPDATE items SET sensitivity = ?, classified_version = ? WHERE id = ?`,
  );

  while (examined < total) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const rows = db
      .prepare(
        `SELECT id, kind, title, body, author FROM items
         WHERE deleted_at IS NULL
           AND (classified_version IS NULL OR classified_version <> ?)
         ORDER BY occurred_at DESC
         LIMIT ?`,
      )
      .all(CLASSIFIER_VERSION, Math.min(BATCH, total - examined)) as Row[];

    if (rows.length === 0) {
      break;
    }

    const write = db.transaction(() => {
      for (const row of rows) {
        const result = classify({
          title: row.title,
          body: row.body,
          author: row.author,
          kind: row.kind,
        });

        counts[result.sensitivity] += 1;
        update.run(result.sensitivity, CLASSIFIER_VERSION, row.id);
      }
    });

    write();

    examined += rows.length;
    options.onProgress?.(examined, total);
  }

  return {
    examined,
    normal: counts.normal,
    sensitive: counts.sensitive,
    restricted: counts.restricted,
    version: CLASSIFIER_VERSION,
    remaining: countUnclassified(db, CLASSIFIER_VERSION),
    durationMs: Date.now() - started,
  };
}

export interface SensitivityBreakdown {
  readonly sensitivity: string;
  readonly count: number;
}

export function sensitivityBreakdown(db: DB): readonly SensitivityBreakdown[] {
  return db
    .prepare(
      `SELECT COALESCE(sensitivity, 'unclassified') AS sensitivity, COUNT(*) AS count
       FROM items WHERE deleted_at IS NULL
       GROUP BY sensitivity ORDER BY count DESC`,
    )
    .all() as SensitivityBreakdown[];
}
