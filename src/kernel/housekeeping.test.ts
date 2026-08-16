/**
 * Backup retention.
 *
 * The one function in Harbor whose worst case is unrecoverable: it deletes
 * somebody's copies of their digital history, and it runs at 4am with nobody
 * watching. So the policy is a pure function over names and timestamps, and it
 * is tested rather than observed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { selectForRemoval } from "./housekeeping.js";

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;

function backups(...agesInDays: number[]): readonly {
  path: string;
  name: string;
  at: number;
  bytes: number;
}[] {
  return agesInDays.map((age) => ({
    path: `/backups/harbor-${String(age)}.db`,
    name: `harbor-${String(age)}.db`,
    at: NOW - age * DAY,
    bytes: 1_000,
  }));
}

test("backup retention", async (t) => {
  await t.test("keeps everything when there is little", () => {
    assert.equal(selectForRemoval(backups(0, 1, 2), NOW).length, 0);
  });

  await t.test("keeps the last seven days whatever their spacing", () => {
    const doomed = selectForRemoval(backups(0, 1, 2, 3, 4, 5, 6), NOW);

    assert.equal(doomed.length, 0);
  });

  await t.test("several backups on the same day all count as recent", () => {
    // Somebody debugging runs four by hand in an afternoon. Those are the
    // interesting ones, and a policy that thinned them to one per day would
    // throw away the state they were trying to capture.
    const sameDay = [0, 0.1, 0.2, 0.3, 1, 2, 3].map((age) => ({
      path: `/backups/harbor-${String(age)}.db`,
      name: `harbor-${String(age)}.db`,
      at: NOW - age * DAY,
      bytes: 1_000,
    }));

    assert.equal(selectForRemoval(sameDay, NOW).length, 0);
  });

  await t.test("thins older ones to roughly one a week", () => {
    const doomed = selectForRemoval(backups(0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 15, 16, 40, 41), NOW);
    const names = new Set(doomed.map((entry) => entry.name));

    // Everything inside the daily window survives.
    for (const age of [0, 1, 2, 3, 4, 5, 6]) {
      assert.ok(!names.has(`harbor-${String(age)}.db`), `${String(age)}d should survive`);
    }

    // And something is actually removed, or the policy is not a policy.
    assert.ok(doomed.length > 0);
  });

  await t.test("never removes the newest, under any inputs", () => {
    // The invariant that matters more than the shape of the policy. Fuzzed
    // rather than reasoned about, because the cost of being wrong once is the
    // whole point of the file.
    for (let trial = 0; trial < 200; trial += 1) {
      const ages = Array.from({ length: 1 + (trial % 30) }, () => Math.random() * 400);
      const candidates = backups(...ages);
      const newest = [...candidates].sort((a, b) => b.at - a.at)[0];
      const doomed = selectForRemoval(candidates, NOW);

      assert.ok(
        !doomed.some((entry) => entry.path === newest?.path),
        "the newest backup was selected for removal",
      );
    }
  });

  await t.test("an empty directory removes nothing", () => {
    assert.equal(selectForRemoval([], NOW).length, 0);
  });

  await t.test("a single backup is never removed", () => {
    assert.equal(selectForRemoval(backups(900), NOW).length, 0);
  });
});
