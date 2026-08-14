/**
 * A throwaway Harbor, for tests.
 *
 * Deliberately opens the real database through the real `openDatabase`, rather
 * than building a schema by hand. Migrations, the policy seed, and the pragma
 * settings are all part of what is being tested: a test store assembled from
 * `CREATE TABLE` statements would pass while migration 023 was broken, which is
 * the exact class of failure this file exists to catch.
 *
 * `HARBOR_HOME` is the only lever needed. Each store gets its own directory and
 * removes it afterwards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, primeStoreKey } from "../kernel/db.js";
import type { DB } from "../kernel/db.js";
import type { Embedder } from "../derive/embed/index.js";

export interface TestStore {
  readonly db: DB;
  readonly home: string;
  close(): void;
}

export function openTestStore(): TestStore {
  const home = mkdtempSync(join(tmpdir(), "harbor-test-"));
  const previous = process.env["HARBOR_HOME"];

  process.env["HARBOR_HOME"] = home;

  // Embeddings are a network call to a local model server that will not be
  // running in a test. Retrieval falls back to keyword search, which is what
  // every assertion here actually depends on.
  const previousEmbed = process.env["HARBOR_EMBED"];
  process.env["HARBOR_EMBED"] = "none";

  // Same order as the real startup path: key first, then open.
  primeStoreKey(null);

  const { db } = openDatabase();

  return {
    db,
    home,
    close(): void {
      db.close();
      rmSync(home, { recursive: true, force: true });

      if (previous === undefined) {
        delete process.env["HARBOR_HOME"];
      } else {
        process.env["HARBOR_HOME"] = previous;
      }

      if (previousEmbed === undefined) {
        delete process.env["HARBOR_EMBED"];
      } else {
        process.env["HARBOR_EMBED"] = previousEmbed;
      }
    },
  };
}

/**
 * An embedder that needs nothing running.
 *
 * The derive pass takes an embedder rather than reaching for one, so a test can
 * supply this and still exercise the real pipeline in the real order:
 * segmentation, chunking, and the version columns all behave exactly as they do
 * in production. The vectors themselves are deterministic nonsense, which is
 * correct for these tests, because nothing here asserts anything about semantic
 * retrieval. A test that depended on real embeddings would be a test that
 * depended on a model server being installed, and it would be skipped forever.
 */
export function fixtureEmbedder(dims = 16): Embedder {
  return {
    id: "fixture",
    model: "fixture",
    dims,

    async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
      return texts.map((text) => {
        const vector = new Float32Array(dims);

        for (let index = 0; index < text.length; index += 1) {
          const slot = text.charCodeAt(index) % dims;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }

        let magnitude = 0;

        for (const value of vector) {
          magnitude += value * value;
        }

        magnitude = Math.sqrt(magnitude) || 1;

        for (let index = 0; index < dims; index += 1) {
          vector[index] = (vector[index] ?? 0) / magnitude;
        }

        return vector;
      });
    },
  };
}
