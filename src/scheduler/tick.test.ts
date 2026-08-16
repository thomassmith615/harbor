/**
 * Does `tick` actually route a refusal to the retry path.
 *
 * `recordRefusal` has its own tests and they pass. What they do not prove is
 * that anything calls it, and that gap is not academic: the shell check written
 * to exercise this on a real store failed to produce a collision twice, because
 * a pulse on a caught-up store finishes in seconds and nothing was still
 * holding the lock when the conflicting task came due.
 *
 * A timing-dependent check that only passes when two things happen to overlap
 * is not a check. So the blocker is placed directly: a running job row, no
 * daemon, no waiting, no race.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { openTestStore } from "../fixtures/harness.js";
import { addSchedule, listSchedules } from "./schedule.js";
import { tick } from "./runner.js";
import { createLogger } from "../kernel/logger.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";

const TZ = "America/New_York";

/** A job that is running right now, so `blockedBy` has something to find. */
function holdLock(db: DB, task: string): void {
  db.prepare(
    `INSERT INTO jobs (id, principal_id, task, state, requested_by, created_at, started_at)
     VALUES ('j_test_blocker', ?, ?, 'running', 'test', ?, ?)`,
  ).run(DEFAULT_PRINCIPAL, task, Date.now(), Date.now());
}

function context() {
  return {
    principalId: DEFAULT_PRINCIPAL,
    timezone: TZ,
    logger: createLogger("silent"),
  };
}

test("tick and refusals", async (t) => {
  await t.test("a task blocked by a running job keeps its slot", async () => {
    const store = openTestStore();

    try {
      // classify conflicts with pulse, in both directions since the closure.
      holdLock(store.db, "pulse");

      addSchedule(store.db, {
        principalId: DEFAULT_PRINCIPAL,
        task: "classify",
        atHour: 3,
        atMinute: 0,
        timezone: TZ,
      });

      // Due now.
      store.db.prepare(`UPDATE schedules SET next_run_at = ? WHERE task = 'classify'`).run(
        Date.now() - 1_000,
      );

      const report = await tick(store.db, context());

      const after = listSchedules(store.db).find((entry) => entry.task === "classify");

      assert.ok(after !== undefined);

      // Not counted as a run: it did not run.
      assert.equal(after.lastRunAt, null, "a refusal was recorded as a run");
      assert.equal(after.lastStatus, "skipped");
      assert.equal(report.ran.length, 0);

      // And back shortly rather than tomorrow. This is the whole fix: before
      // it, `computeNextRun` pushed a daily task a full day forward and the
      // pass simply did not happen that cycle.
      assert.ok(after.nextRunAt !== null);

      const minutes = (after.nextRunAt - Date.now()) / 60_000;

      assert.ok(
        minutes > 0 && minutes < 30,
        `next run is ${String(Math.round(minutes))} minutes away, expected a short retry`,
      );
    } finally {
      store.close();
    }
  });

  await t.test("an unblocked task runs and advances normally", async () => {
    const store = openTestStore();

    try {
      addSchedule(store.db, {
        principalId: DEFAULT_PRINCIPAL,
        task: "classify",
        atHour: 3,
        atMinute: 0,
        timezone: TZ,
      });

      store.db.prepare(`UPDATE schedules SET next_run_at = ? WHERE task = 'classify'`).run(
        Date.now() - 1_000,
      );

      await tick(store.db, context());

      const after = listSchedules(store.db).find((entry) => entry.task === "classify");

      assert.ok(after !== undefined);
      assert.ok(after.lastRunAt !== null, "an unblocked task should record a run");
      assert.notEqual(after.lastStatus, "skipped");
    } finally {
      store.close();
    }
  });

  await t.test("a task that is not due is left alone", async () => {
    const store = openTestStore();

    try {
      holdLock(store.db, "pulse");

      addSchedule(store.db, {
        principalId: DEFAULT_PRINCIPAL,
        task: "classify",
        atHour: 3,
        atMinute: 0,
        timezone: TZ,
      });

      const before = listSchedules(store.db).find((entry) => entry.task === "classify");

      await tick(store.db, context());

      const after = listSchedules(store.db).find((entry) => entry.task === "classify");

      assert.equal(after?.nextRunAt, before?.nextRunAt);
      assert.equal(after?.lastStatus, null);
    } finally {
      store.close();
    }
  });
});
