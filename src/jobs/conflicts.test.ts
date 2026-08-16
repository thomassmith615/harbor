/**
 * The conflict table, and what it must never do again.
 *
 * `blockedBy` reads one side of the table. For twenty pairs only one side was
 * written down, and the most damaging of those let a fifteen-minute pulse start
 * while a relate pass was mid-flight. Pulse runs relate internally, so that is
 * two relate passes writing the same edge and situation tables at once.
 *
 * The symmetry assertion is the guard: it fails the moment somebody adds a task
 * and declares its conflicts from one side, which is exactly how the table
 * drifted the first time.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CONFLICTS, JOB_TASKS, undeclaredPairs } from "./runner.js";

test("job conflicts", async (t) => {
  await t.test("every conflict is symmetric", () => {
    for (const task of JOB_TASKS) {
      for (const other of CONFLICTS[task]) {
        assert.ok(
          CONFLICTS[other].includes(task),
          `${task} conflicts with ${other}, but ${other} does not conflict with ${task}`,
        );
      }
    }
  });

  await t.test("a pulse may not start while relate is running", () => {
    // The specific bug. Pulse runs relate as one of its steps, so this pair
    // being one-directional meant concurrent relate passes on the appliance.
    assert.ok(CONFLICTS.pulse.includes("relate"));
    assert.ok(CONFLICTS.relate.includes("pulse"));
  });

  await t.test("the passes that write derived tables exclude the ingest that feeds them", () => {
    for (const pass of ["classify", "derive", "resolve", "relate", "commit"] as const) {
      assert.ok(CONFLICTS[pass].includes("pulse"), `${pass} should exclude pulse`);
      assert.ok(CONFLICTS.pulse.includes(pass), `pulse should exclude ${pass}`);
    }
  });

  await t.test("backup stays safe alongside everything else", () => {
    // The one task that reads a consistent snapshot and blocks nothing. If the
    // closure ever drags this into conflict with the passes, the appliance
    // stops backing itself up on any busy night, which is the night it matters.
    assert.deepEqual([...CONFLICTS.backup], ["backup"]);
  });

  await t.test("every task conflicts with itself", () => {
    for (const task of JOB_TASKS) {
      assert.ok(CONFLICTS[task].includes(task), `${task} should not run twice at once`);
    }
  });

  await t.test("the closure is actually doing work", () => {
    // Documents that the declarations really are one-sided, so that if somebody
    // later tidies the table by hand this test tells them the closure is now
    // redundant rather than silently guarding nothing.
    assert.ok(undeclaredPairs().length > 0);
  });
});
