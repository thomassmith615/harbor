/**
 * Restocking, and the things it must refuse to say.
 *
 * A wrong restocking prompt is worse than none: it is a machine telling you to
 * buy something you do not need, which is the fastest way to stop reading
 * anything it says.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { detectDuePurchases } from "./detectors-purchases.js";
import { openTestStore, type TestStore } from "../fixtures/harness.js";
import { seedFixture, PRINCIPAL } from "../fixtures/store.js";
import { saveProjection } from "../store/projections.js";
import { upsertItem } from "../store/items.js";
import { openObservations } from "../store/signals.js";

let store: TestStore;

const NOW = Date.UTC(2026, 7, 15);
const DAY = 86_400_000;

/**
 * A merchant bought on a given set of day-offsets before now.
 *
 * Real items behind every projection, because the table has a foreign key to
 * them and should: a purchase with no message behind it has no evidence, and
 * evidence on every claim is the property this whole layer rests on.
 */
function history(merchant: string, daysAgo: readonly number[], totalCents = 4_200): void {
  const stream = store.db.prepare(`SELECT id FROM streams LIMIT 1`).pluck().get() as string;
  const account = stream.slice(0, stream.lastIndexOf("/"));

  for (const [index, days] of daysAgo.entries()) {
    const { id } = upsertItem(store.db, {
      accountId: account,
      streamId: stream,
      externalId: `${merchant}-${String(index)}`,
      kind: "message",
      title: `Your order from ${merchant}`,
      occurredAt: NOW - days * DAY,
      raw: {},
    });

    saveProjection(store.db, {
      principalId: PRINCIPAL,
      itemId: id,
      type: "purchase",
      schemaVersion: 1,
      occurredAt: NOW - days * DAY,
      merchant,
      currency: "USD",
      totalCents,
      reference: null,
      payload: {},
      confidence: 0.9,
      model: null,
    });
  }
}

function titles(): readonly string[] {
  return openObservations(store.db, "purchase_due").map((entry) => entry.title);
}

before(() => {
  store = openTestStore();
  seedFixture(store.db);

  // Groceries every ten days, last bought twenty-five days ago. Overdue.
  history("Wegmans", [95, 85, 74, 65, 55, 45, 35, 25]);

  // The same rhythm, bought on time. Must stay quiet.
  history("Trader Joes", [40, 30, 20, 10, 2]);

  // No rhythm at all: a restaurant visited whenever. Must stay quiet.
  history("Flanigans", [90, 88, 60, 12, 9]);

  // Only three purchases. Not enough to claim a pattern.
  history("Bombas", [70, 40, 10]);

  detectDuePurchases(store.db, {
    principalId: PRINCIPAL,
    timezone: "UTC",
    now: NOW,
  });
});

after(() => {
  store.close();
});

describe("restocking", () => {
  test("a regular purchase that is overdue is worth saying", () => {
    const said = titles().find((title) => title.includes("Wegmans"));

    assert.ok(said !== undefined, `nothing said about Wegmans; got: ${titles().join(" | ")}`);
    assert.ok(said.includes("10 days"), `the usual interval reads wrong: ${said}`);
  });

  test("a regular purchase that is on time is not", () => {
    assert.equal(
      titles().some((title) => title.includes("Trader Joes")),
      false,
      "told to restock something bought last week",
    );
  });

  test("an irregular merchant never qualifies", () => {
    // The test that keeps a favourite restaurant out of a restocking list.
    // There is no rhythm, so there is nothing to be late for.
    assert.equal(
      titles().some((title) => title.includes("Flanigans")),
      false,
      "claimed a rhythm for a merchant that has none",
    );
  });

  test("three purchases are not a pattern", () => {
    assert.equal(
      titles().some((title) => title.includes("Bombas")),
      false,
      "claimed a rhythm from three points",
    );
  });

  test("saying it twice is saying it once", () => {
    const before = titles().length;

    detectDuePurchases(store.db, { principalId: PRINCIPAL, timezone: "UTC", now: NOW });

    assert.equal(titles().length, before, "a second pass repeated itself");
  });
});

describe("what a digest must not say", () => {
  test("an ordinary word is never a topic", async () => {
    // A real digest said "before has come up in 20 conversations recently" and
    // "pretty has come up in 16". Both cleared this file's own stopword list
    // and its own corpus-share ceiling, while failing the test the relationship
    // graph had been using for two milestones. Two definitions of distinctive
    // means one is wrong and nobody finds out until it says something absurd.
    const { TermIndex } = await import("./terms.js");
    const index = new TermIndex(store.db);

    for (const word of ["before", "pretty", "really", "something", "thing"]) {
      assert.equal(
        index.isDistinctive(word),
        false,
        `"${word}" would be offered as a topic`,
      );
    }
  });
});
