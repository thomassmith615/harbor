/**
 * Which of the four setup steps is missing.
 *
 * `remoteStatus` shells out to Tailscale and cannot be tested without it, but
 * the decision it feeds can, and the decision is the part that gets somebody
 * unstuck. Everything below is the mapping from state to the one command that
 * fixes it.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { remoteInstructions, type RemoteStatus } from "./remote.js";

const status = (over: Partial<RemoteStatus>): RemoteStatus => ({
  state: "served",
  host: "mac.tail1a2b3.ts.net",
  url: "https://mac.tail1a2b3.ts.net",
  servedPort: 8484,
  ...over,
});

function text(lines: readonly string[]): string {
  return lines.join("\n");
}

describe("what to do next", () => {
  test("nothing installed says how to install it", () => {
    const out = text(remoteInstructions(status({ state: "no-tailscale" }), 8484));

    assert.match(out, /brew install/);
    assert.doesNotMatch(out, /tailscale serve/, "step three, before step one exists");
  });

  test("installed but not connected says only that", () => {
    const out = text(remoteInstructions(status({ state: "logged-out" }), 8484));

    assert.match(out, /tailscale up/);
    assert.doesNotMatch(out, /brew install/, "told to reinstall something already installed");
  });

  test("connected but publishing nothing gives the serve command with the real port", () => {
    const out = text(
      remoteInstructions(status({ state: "not-served", servedPort: null }), 9999),
    );

    assert.match(out, /tailscale serve --bg 9999/);
    // The commonest reason that command fails, said where it will be read.
    assert.match(out, /HTTPS [Cc]ertificates/);
  });

  test("publishing the wrong port says which, rather than that it is broken", () => {
    const out = text(remoteInstructions(status({ servedPort: 3000 }), 8484));

    assert.match(out, /3000/);
    assert.match(out, /8484/);
    assert.match(out, /tailscale serve --bg 8484/);
  });

  test("all four steps done gives the URL and no instructions", () => {
    const out = text(remoteInstructions(status({}), 8484));

    assert.match(out, /https:\/\/mac\.tail1a2b3\.ts\.net/);
    assert.doesNotMatch(out, /brew install|tailscale up|tailscale serve/);
  });

  test("an unrecognised answer never claims it worked", () => {
    const out = text(
      remoteInstructions(
        status({ state: "unknown", host: null, url: null, servedPort: null }),
        8484,
      ),
    );

    assert.doesNotMatch(out, /https:\/\//, "offered a URL it does not have");
  });

  test("no step is ever skipped by claiming success without a served port", () => {
    // The failure that would matter: telling somebody to open a URL when
    // nothing is listening behind it. They would conclude Harbor is broken.
    for (const state of ["no-tailscale", "logged-out", "not-served", "unknown"] as const) {
      const out = text(
        remoteInstructions(status({ state, servedPort: null, url: null }), 8484),
      );

      assert.doesNotMatch(out, /Open https/, `${state} told them to open a URL`);
    }
  });
});
