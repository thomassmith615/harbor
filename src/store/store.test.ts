/**
 * The invariants everything else assumes.
 *
 * These are cheap and they are the ones whose failure is invisible. A store
 * that quietly stops clearing derived versions still answers questions; it just
 * answers them from stale derivations, and nothing in the output looks wrong.
 * Same for a gate that admits an item it should have withheld: the answer gets
 * better, which is exactly why nobody would report it.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { openTestStore, type TestStore } from "../fixtures/harness.js";
import { seedFixture } from "../fixtures/store.js";
import { upsertItem, itemId } from "./items.js";
import { recordSelfHandles, listSelfHandles } from "./entities.js";
import { ensureStream } from "./streams.js";
import { saveAccount } from "./accounts.js";
import { Gate } from "../policy/gate.js";
import { MIGRATIONS } from "./schema.js";

let store: TestStore;

before(() => {
  store = openTestStore();
});

after(() => {
  store.close();
});

describe("the schema", () => {
  test("every migration has run", () => {
    const version = store.db.pragma("user_version", { simple: true }) as number;

    assert.equal(
      version,
      MIGRATIONS.length,
      "a fresh database did not reach the current schema version",
    );
  });

  test("the graph tables are polymorphic", () => {
    // Migration 023 rebuilt these. If a later migration recreates the foreign
    // key to `items`, writing an episode id becomes a constraint failure at
    // runtime rather than a compile error, which is the worst possible place to
    // find out.
    const columns = store.db.pragma("table_info(relationships)") as { name: string }[];
    const names = columns.map((column) => column.name);

    for (const wanted of ["from_kind", "from_id", "to_kind", "to_id"]) {
      assert.ok(names.includes(wanted), `relationships has no ${wanted}`);
    }

    const keys = store.db.pragma("foreign_key_list(relationships)") as unknown[];

    assert.equal(keys.length, 0, "relationships carries a foreign key it cannot honour");
  });

  test("opening twice is a no-op", () => {
    const second = openTestStore();

    try {
      assert.equal(
        second.db.pragma("user_version", { simple: true }) as number,
        MIGRATIONS.length,
      );
    } finally {
      second.close();
    }
  });
});

describe("items", () => {
  test("re-ingesting unchanged content changes nothing", () => {
    const account = saveAccount(store.db, {
      sourceType: "test",
      label: "dedup",
      credentials: { accessToken: "x", refreshToken: "", expiresAt: 0, scope: "" },
    });

    const stream = ensureStream(store.db, account.id, "test-connector");

    const input = {
      accountId: account.id,
      streamId: stream.id,
      externalId: "one",
      kind: "message",
      title: "Hello",
      body: "Body",
      occurredAt: 1_700_000_000_000,
      raw: { a: 1 },
    };

    const first = upsertItem(store.db, input);
    const second = upsertItem(store.db, input);

    assert.equal(first.changed, true);
    assert.equal(second.changed, false, "re-ingesting the same content reported a change");
    assert.equal(first.id, second.id);
    assert.equal(first.id, itemId(account.id, "one"));
  });

  test("changed content clears every derived version", () => {
    const account = saveAccount(store.db, {
      sourceType: "test",
      label: "versions",
      credentials: { accessToken: "x", refreshToken: "", expiresAt: 0, scope: "" },
    });

    const stream = ensureStream(store.db, account.id, "test-connector");

    const base = {
      accountId: account.id,
      streamId: stream.id,
      externalId: "two",
      kind: "message",
      occurredAt: 1_700_000_000_000,
      raw: {},
    };

    const { id } = upsertItem(store.db, { ...base, body: "before" });

    // Read the version columns from the schema rather than listing them.
    //
    // Deliberately generic: the failure this guards against is a *future*
    // derivation adding its own version column and forgetting to clear it in
    // `upsertItem`. A hand-written list would pass forever while that happened,
    // and the symptom would be Harbor answering from derivations of text that
    // no longer exists. This assertion is the only thing that would notice.
    const columns = (store.db.pragma("table_info(items)") as { name: string }[])
      .map((column) => column.name)
      .filter((name) => name.endsWith("_version") && name !== "raw_encoding");

    assert.ok(columns.length >= 6, "no version columns found, so this test proves nothing");

    for (const column of columns) {
      store.db.prepare(`UPDATE items SET ${column} = 9 WHERE id = ?`).run(id);
    }

    upsertItem(store.db, { ...base, body: "after" });

    for (const column of columns) {
      const row = store.db
        .prepare(`SELECT ${column} AS value FROM items WHERE id = ?`)
        .get(id) as { value: number | null };

      assert.equal(
        row.value,
        null,
        `${column} survived a content change, so that derivation is now stale and nothing knows`,
      );
    }
  });

  test("raw is preserved", () => {
    const kept = store.db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE raw IS NULL OR raw = ''`)
      .get() as { n: number };

    assert.equal(kept.n, 0, "an item was stored without its source payload");
  });
});

describe("the gate", () => {
  test("a withheld item never reaches the renderer", () => {
    // The render callback is where a caller shapes its payload. If it runs for
    // a withheld item, a caller that forgot to check the flag leaks it, which
    // is the one failure mode a single chokepoint exists to prevent.
    const gate = new Gate([
      {
        id: "deny-all",
        priority: 1,
        matchKind: null,
        matchSensitivity: null,
        matchEntity: null,
        matchPattern: null,
        egress: "local_only",
        confirm: "never",
        note: null,
        builtin: false,
        enabled: true,
      },
    ]);

    let rendered = false;

    const outcome = gate.admit(
      { id: "x", kind: "message", sensitivity: "sensitive", entityIds: [], text: "secret" },
      (text) => {
        rendered = true;
        return text;
      },
    );

    assert.equal(outcome.value, null);
    assert.equal(outcome.withheld, true);
    assert.equal(rendered, false, "the renderer ran for an item policy withheld");
    assert.equal(gate.summary().bytesOut, 0, "a withheld item was counted as bytes that left");
  });

  test("an empty rule set withholds rather than admits", () => {
    // Fails closed. A store whose rules failed to seed should answer nothing,
    // not everything.
    const gate = new Gate([]);

    const outcome = gate.admit(
      { id: "x", kind: "message", sensitivity: "sensitive", entityIds: [], text: "secret" },
      (text) => text,
    );

    assert.equal(outcome.value, null, "an unconfigured gate admitted an item");
  });
});

describe("identity", () => {
  test("a connector can declare handles that belong to the user", () => {
    recordSelfHandles(store.db, "imessage", [
      { kind: "phone", value: "+15551234567" },
      { kind: "email", value: "me@example.test" },
    ]);

    // Idempotent: sync runs constantly and must not accumulate rows.
    recordSelfHandles(store.db, "imessage", [{ kind: "phone", value: "+15551234567" }]);

    const handles = listSelfHandles(store.db);

    assert.equal(handles.length, 2);
    assert.ok(handles.some((handle) => handle.kind === "phone"));
  });
});

describe("the fixture store itself", () => {
  test("seeds five sources and lands every item", () => {
    // A fixture that silently stopped seeding would make every graph test pass
    // by having nothing to link.
    const fresh = openTestStore();

    try {
      seedFixture(fresh.db);

      const items = (
        fresh.db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }
      ).n;
      const streams = (
        fresh.db.prepare(`SELECT COUNT(*) AS n FROM streams`).get() as { n: number }
      ).n;

      assert.equal(streams, 5);
      assert.ok(items >= 20, `only ${String(items)} fixture items landed`);
    } finally {
      fresh.close();
    }
  });
});
