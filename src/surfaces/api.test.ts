/**
 * Query parameter defaults.
 *
 * One function, because it was wrong in a way that produced no error, no log
 * line and no wrong answer: it produced emptiness, on ten endpoints, whenever
 * the caller left the parameter off. A store with nothing in it looks the same,
 * so the bug read as Harbor having found nothing.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { number } from "./api.js";

describe("a query parameter that was not given", () => {
  test("falls back rather than becoming zero", () => {
    // The bug. `URLSearchParams.get` returns null when a parameter is absent,
    // `Number(null)` is 0, and `Number.isFinite(0)` is true, so the fallback
    // was unreachable for exactly the case it existed for.
    assert.equal(number(null, 12), 12);
    assert.equal(number(undefined, 12), 12);
    assert.equal(number("", 12), 12);
  });

  test("a limit of zero is never the default", () => {
    // Said as the consequence rather than the mechanism: every caller here
    // passes this straight to a SQL LIMIT.
    for (const absent of [null, undefined, ""]) {
      assert.notEqual(number(absent, 20), 0, "an absent limit became LIMIT 0");
    }
  });

  test("a value that was given is used", () => {
    assert.equal(number("20", 12), 20);
    assert.equal(number("0", 12), 0, "an explicit zero is a choice, not an accident");
    assert.equal(number(5, 12), 5);
  });

  test("nonsense falls back", () => {
    assert.equal(number("twelve", 12), 12);
    assert.equal(number("NaN", 12), 12);
    assert.equal(number({}, 12), 12);
  });

  test("a decimal is truncated rather than rejected", () => {
    assert.equal(number("20.7", 12), 20);
  });
});
