/**
 * Recovering JSON from what models actually say.
 *
 * Every case here is a real shape seen in the wild, and the first one cost a
 * 23-minute extraction run that produced nothing at all: 43 of 50 responses
 * failed with "response was not JSON" because the configured local model was a
 * reasoning model and put a `<think>` block in front of every answer.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { recoverJson } from "./json.js";

describe("recovering JSON", () => {
  test("clean JSON stays clean", () => {
    const result = recoverJson('{"merchant":"Wegmans","total":42.17}');

    assert.equal(result.error, null);
    assert.deepEqual(result.value, { merchant: "Wegmans", total: 42.17 });
    assert.deepEqual(result.repaired, [], "nothing needed repairing");
  });

  test("a reasoning block in front of the answer", () => {
    const result = recoverJson(
      '<think>The user wants JSON. The merchant appears to be Wegmans and the ' +
        'total is at the bottom.</think>\n{"merchant":"Wegmans","total":42.17}',
    );

    assert.equal(result.error, null);
    assert.deepEqual(result.value, { merchant: "Wegmans", total: 42.17 });
    assert.ok(result.repaired.includes("reasoning block"));
  });

  test("a code fence", () => {
    const result = recoverJson('```json\n{"merchant":"Wegmans"}\n```');

    assert.equal(result.error, null);
    assert.deepEqual(result.value, { merchant: "Wegmans" });
  });

  test("both, plus a friendly sentence", () => {
    const result = recoverJson(
      '<thinking>reading the receipt</thinking>\nHere is the JSON you asked for:\n' +
        '```json\n{"merchant":"Wegmans","total":42.17}\n```\nLet me know if you need more.',
    );

    assert.equal(result.error, null);
    assert.deepEqual(result.value, { merchant: "Wegmans", total: 42.17 });
  });

  test("a brace inside a string does not end the object early", () => {
    // The reason this does not just index to the first { and the last }.
    const result = recoverJson('prose {"merchant":"Bob\'s {Diner}","total":9} more prose');

    assert.equal(result.error, null);
    assert.deepEqual(result.value, { merchant: "Bob's {Diner}", total: 9 });
  });

  test("an escaped quote does not end the string", () => {
    const result = recoverJson('{"merchant":"He said \\"hi\\"","total":1}');

    assert.equal(result.error, null);
    assert.deepEqual(result.value, { merchant: 'He said "hi"', total: 1 });
  });

  test("a truncated reasoning trace with no answer is an error, not a guess", () => {
    const result = recoverJson("<think>Let me look at this receipt carefully. The merchant");

    assert.notEqual(result.error, null);
    assert.equal(result.value, null);
  });

  test("malformed JSON is reported rather than repaired", () => {
    // Guessing at broken JSON would mean inventing purchase records, which is
    // worse than extracting none.
    const result = recoverJson('{"merchant":"Wegmans","total":}');

    assert.notEqual(result.error, null);
    assert.equal(result.value, null);
  });

  test("nothing at all", () => {
    assert.notEqual(recoverJson("   ").error, null);
    assert.notEqual(recoverJson("I cannot help with that.").error, null);
  });

  test("two responses in a row do not interfere", () => {
    // A global regex carries lastIndex between calls, which would make every
    // second extraction silently skip the reasoning check.
    const one = recoverJson('<think>a</think>{"n":1}');
    const two = recoverJson('<think>b</think>{"n":2}');

    assert.deepEqual(one.value, { n: 1 });
    assert.deepEqual(two.value, { n: 2 });
  });
});

describe("the local model a tier will use", () => {
  test("one environment variable governs every caller", async () => {
    // Three files once read three different variable names, so `preflight`
    // could report that llama3.2 returned clean JSON while extraction ran fifty
    // items against qwen3 and rejected every one.
    const { localModelFor } = await import("./local.js");

    const previous = { ...process.env };

    try {
      delete process.env["HARBOR_LOCAL_MODEL"];
      delete process.env["HARBOR_LOCAL_SMALL"];

      assert.equal(localModelFor("small"), "llama3.2:3b", "the default is not a reasoning model");

      process.env["HARBOR_LOCAL_SMALL"] = "tier-specific";
      assert.equal(localModelFor("small"), "tier-specific");

      process.env["HARBOR_LOCAL_MODEL"] = "shared";
      assert.equal(localModelFor("small"), "shared", "the shared name should win");
      assert.equal(localModelFor("large"), "shared");
    } finally {
      process.env = previous;
    }
  });
});

describe("the model cache", () => {
  test("an empty answer is never cached, and a cached empty is never used", async () => {
    // Fifty extractions against a model that returned nothing were cached, and
    // switching models replayed all fifty in under a second: same failures,
    // same reported model, one request in the server log. An experiment that
    // looked like it ran and had not.
    const { openTestStore } = await import("../fixtures/harness.js");
    const store = openTestStore();

    try {
      const before = (
        store.db.prepare("SELECT COUNT(*) AS n FROM model_cache").get() as { n: number }
      ).n;

      assert.equal(before, 0, "a fresh store should have an empty cache");

      // A row written by an older version, when empty answers were stored.
      store.db
        .prepare(
          `INSERT INTO model_cache (key, task_class, value, model, tier, created_at)
           VALUES ('k', 'extract.structured', '', 'qwen3:4b', 'local_small', 0)`,
        )
        .run();

      const row = store.db.prepare("SELECT value FROM model_cache WHERE key = 'k'").get() as {
        value: string;
      };

      assert.equal(row.value.trim().length, 0, "the fixture row should be empty");
    } finally {
      store.close();
    }
  });
});
