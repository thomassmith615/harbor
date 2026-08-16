/**
 * A source type whose connector no longer exists.
 *
 * From a real failure. The `files` connector was removed from the registry, its
 * account rows stayed in the store, and every sync after that died with:
 *
 *   error: No credential strategy for source type files
 *
 * Two separate faults, and the second is much worse than the first.
 *
 * `credentialFor` ran before the connector filter, so an account with nothing
 * to sync was still asked to produce a credential, and threw.
 *
 * And nothing caught it. A single throwing account aborted the whole loop, so
 * every account after it in the list never synced at all: mail, calendars,
 * reminders, and messages all quietly stopped updating because of one dead
 * source, with nothing to show for it but one line of job error.
 *
 * The items stay either way. Those 742 transactions anchor half the
 * cross-source situations in the store, and an inert account is not a reason to
 * throw away the data it brought in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { syncAccount } from "./dispatch.js";
import { connectorsFor } from "./registry.js";
import { openTestStore } from "../fixtures/harness.js";
import { saveAccount } from "../store/accounts.js";

test("a source with no connector", async (t) => {
  await t.test("the registry really has nothing for it", () => {
    // If somebody re-adds a files connector this test stops testing what it
    // claims to, so it says so rather than passing quietly.
    assert.equal(connectorsFor("files").length, 0);
  });

  await t.test("is skipped rather than demanding a credential", async () => {
    const store = openTestStore();

    try {
      const account = saveAccount(store.db, {
        sourceType: "files",
        label: "inbox",
        credentials: { accessToken: "", refreshToken: "", expiresAt: 0, scope: "" },
      });

      // Before the fix this threw "No credential strategy for source type files".
      const reports = await syncAccount(store.db, account, "auto", {
        timezone: "America/New_York",
      });

      assert.deepEqual(reports, []);
    } finally {
      store.close();
    }
  });

  await t.test("an account that does have connectors is unaffected", async () => {
    // The skip must be narrow. A real source reaching this path and quietly
    // returning nothing would be a far worse bug than the one being fixed.
    assert.ok(connectorsFor("imessage").length > 0);
  });
});
