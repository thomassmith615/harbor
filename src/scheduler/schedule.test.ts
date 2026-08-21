/**
 * What a refused schedule must do.
 *
 * Found on a real store, not here, which is the uncomfortable part. Four daily
 * passes collided with one running pulse and every one of them advanced to the
 * next day:
 *
 *   commit   last Sat 11:08 AM  ok  skipped: pulse is running
 *   derive   last Sat 11:08 AM  ok  skipped: pulse is running
 *   extract  last Sat 11:08 AM  ok  skipped: pulse is running
 *   notice   last Sat 11:08 AM  ok  skipped: pulse is running
 *
 * They did not run that cycle at all, and it was recorded as `ok`, so the
 * schedule list showed four healthy tasks that had quietly done nothing. On an
 * appliance nobody looks at, that is a pass silently not happening for as long
 * as the collision keeps recurring.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { openTestStore, type TestStore } from "../fixtures/harness.js";
import { addSchedule, listSchedules, recordRefusal, recordRun } from "./schedule.js";
import { isRefusal } from "./runner.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";

const TZ = "America/New_York";

/**
 * The wall-clock time a timestamp lands on, in the schedule's own zone.
 *
 * Both advancement tests used to assert that the next run was more than an hour
 * away, which is true for a daily slot twenty-three hours a day and false for
 * the hour before it. The digest test failed between 06:00 and 07:00 Eastern
 * and the extract test between 03:30 and 04:30, so both passed in CI, passed
 * all day, and failed for whoever happened to run them early. A test that fails
 * for one hour a day is worse than one that always fails, because the first
 * time you see it you assume it is the change you just made.
 *
 * The clock arithmetic was standing in for the real claim, which is that the
 * task advanced to its own next slot. That is what these check now, and it is
 * true at every hour of the day.
 */
function localTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function only(store: TestStore) {
  const found = listSchedules(store.db)[0];

  assert.ok(found !== undefined);

  return found;
}

test("a refused schedule", async (t) => {
  await t.test("the notes runTask produces are recognised as refusals", () => {
    // Pins the two producers in runner.ts. If either wording changes, the
    // retry path silently stops engaging and the old bug comes straight back.
    assert.ok(isRefusal("skipped: pulse is running"));
    assert.ok(isRefusal("refused"));
    assert.ok(isRefusal("already running"));

    assert.ok(!isRefusal("started j_5f4714284bfc43f2"));
    assert.ok(!isRefusal("41180 items, 13307 embeddings"));
    assert.ok(!isRefusal("0 new or changed"));
  });

  await t.test("retries in minutes rather than forfeiting the day", () => {
    const store = openTestStore();

    try {
      addSchedule(store.db, {
        principalId: DEFAULT_PRINCIPAL,
        task: "commit",
        atHour: 3,
        atMinute: 30,
        timezone: TZ,
      });

      recordRefusal(store.db, only(store), TZ, "skipped: pulse is running");

      const after = only(store);

      assert.ok(after.nextRunAt !== null);

      const minutes = (after.nextRunAt - Date.now()) / 60_000;

      assert.ok(minutes > 0 && minutes < 30, `next run is ${String(minutes)} minutes away`);
    } finally {
      store.close();
    }
  });

  await t.test("does not claim the task ran", () => {
    // The staleness checks in `doctor` all key off last_run_at. A refusal that
    // sets it is a task reporting success for work it never did.
    const store = openTestStore();

    try {
      addSchedule(store.db, {
        principalId: DEFAULT_PRINCIPAL,
        task: "derive",
        atHour: 3,
        atMinute: 0,
        timezone: TZ,
      });

      recordRefusal(store.db, only(store), TZ, "skipped: pulse is running");

      const after = only(store);

      assert.equal(after.lastRunAt, null, "a refusal was recorded as a run");
      assert.equal(after.lastStatus, "skipped");
    } finally {
      store.close();
    }
  });

  await t.test("gives up once it is far past when it was due", () => {
    // Otherwise a permanently stuck job leaves the task retrying every five
    // minutes forever, which is a busy loop wearing a schedule as a hat.
    const store = openTestStore();

    try {
      addSchedule(store.db, {
        principalId: DEFAULT_PRINCIPAL,
        task: "extract",
        atHour: 4,
        atMinute: 30,
        timezone: TZ,
      });

      const stale = { ...only(store), nextRunAt: Date.now() - 6 * 3_600_000 };

      recordRefusal(store.db, stale, TZ, "skipped: pulse is running");

      const after = only(store);

      assert.ok(after.nextRunAt !== null && after.nextRunAt > Date.now());
      assert.equal(
        localTime(after.nextRunAt),
        "04:30",
        "a long-refused task should wait for its natural next slot",
      );
    } finally {
      store.close();
    }
  });

  await t.test("a real run still advances normally", () => {
    const store = openTestStore();

    try {
      addSchedule(store.db, {
        principalId: DEFAULT_PRINCIPAL,
        task: "digest",
        atHour: 7,
        atMinute: 0,
        timezone: TZ,
      });

      recordRun(store.db, only(store), TZ, "ok", "started j_abc");

      const after = only(store);

      assert.ok(after.lastRunAt !== null);
      assert.equal(after.lastStatus, "ok");
      assert.ok(after.nextRunAt !== null && after.nextRunAt > Date.now());
      assert.equal(localTime(after.nextRunAt), "07:00", "advanced to something other than its slot");
    } finally {
      store.close();
    }
  });
});
