/**
 * The substrate: what a vector means before anything searches on it.
 *
 * Two defects are pinned here, both of the kind that produce a working system
 * that is quietly worse than it should be, which is the kind least likely to be
 * noticed from the outside and most worth a test.
 *
 * Prefixes: an asymmetric embedding model expects an instruction on one side of
 * a pair and not the other, and Harbor sent neither for either embedder. Search
 * kept working. It just answered slightly wrong questions.
 *
 * Windows: a conversation was cut every two thousand characters regardless of
 * where a message ended, so one relevant sentence was averaged with two
 * thousand characters of unrelated chat before anything compared it to
 * anything.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { affixNote, affixesFor, applyAffix } from "./embed/affixes.js";
import { windowsFor } from "./windows.js";

describe("embedding prefixes", () => {
  test("nomic labels both sides differently", () => {
    const affixes = affixesFor("nomic-embed-text");

    assert.equal(affixes.query, "search_query: ");
    assert.equal(affixes.document, "search_document: ");
    assert.notEqual(affixes.query, affixes.document, "an asymmetric model has to differ");
  });

  test("bge instructs the query and leaves the document bare", () => {
    // The documented mistake with BGE is prefixing both sides. A passage
    // embedded with a query instruction lands somewhere the real passages are
    // not, so the index disagrees with itself.
    const affixes = affixesFor("Xenova/bge-small-en-v1.5");

    assert.ok(affixes.query.length > 0);
    assert.equal(affixes.document, "");
  });

  test("the same weights under different names get the same treatment", () => {
    for (const name of ["nomic-embed-text", "nomic-embed-text:v1.5", "nomic-embed-text-v1.5"]) {
      assert.equal(affixesFor(name).query, "search_query: ", name);
    }
  });

  test("an unknown model gets nothing, which is the old behaviour", () => {
    const affixes = affixesFor("some-model-nobody-has-heard-of");

    assert.equal(affixes.query, "");
    assert.equal(affixes.document, "");

    // A symmetric model given a prefix is worse off, so not knowing has to
    // leave the model where it was rather than guess.
    assert.match(affixNote("some-model-nobody-has-heard-of"), /no prefix/);
  });

  test("a symmetric model is recognised as wanting nothing", () => {
    assert.equal(affixesFor("text-embedding-3-small").query, "");
  });

  test("applying an empty prefix does not touch the input", () => {
    const texts = ["one", "two"];

    assert.equal(applyAffix("", texts), texts, "the same array, not a copy");
    assert.deepEqual(applyAffix("q: ", texts), ["q: one", "q: two"]);
  });
});

const TRANSCRIPT = [
  "Dave Mullen: who's going to the bar later",
  "Sam Ortiz: lol depends who else",
  "Nina Patel: my sister is in town but she can come",
  "Dave Mullen: anyone seen my charger btw",
  "Sam Ortiz: no",
  "Nina Patel: the game is on at 9 too",
  "Dave Mullen: im in",
  "Sam Ortiz: same",
  "Nina Patel: ok cool",
  "Dave Mullen: 8ish?",
  "Me: yeah I'm going",
  "Nina Patel: nice",
].join("\n");

const INPUT = {
  title: "Bar Crew",
  transcript: TRANSCRIPT,
  participants: ["Dave Mullen", "Sam Ortiz", "Nina Patel"],
  startsAt: Date.UTC(2026, 7, 27, 21, 45),
  timezone: "America/New_York",
};

describe("conversation windows", () => {
  test("every window says whose conversation it is and when", () => {
    const windows = windowsFor(INPUT);

    assert.ok(windows.length > 0);

    for (const window of windows) {
      // Not the first window only. A window from the middle of a thread used
      // to embed as anonymous prose: "yeah I'm going", with no indication of
      // who said it or to whom.
      assert.match(window.text, /^\[Bar Crew/, "header missing");
      assert.match(window.text, /Dave Mullen/);
      assert.match(window.text, /Aug 27, 2026/);
    }
  });

  test("windows break between messages, never inside one", () => {
    for (const window of windowsFor({ ...INPUT, transcript: [TRANSCRIPT, TRANSCRIPT, TRANSCRIPT, TRANSCRIPT].join("\n") })) {
      for (const line of window.body.split("\n")) {
        assert.ok(
          TRANSCRIPT.includes(line),
          `"${line}" is not a whole line from the transcript`,
        );
      }
    }
  });

  test("consecutive windows overlap, so an exchange is never halved", () => {
    const windows = windowsFor({ ...INPUT, transcript: [TRANSCRIPT, TRANSCRIPT, TRANSCRIPT].join("\n") });

    assert.ok(windows.length >= 2, "the fixture has to actually split");

    const first = windows[0]?.body.split("\n") ?? [];
    const second = windows[1]?.body.split("\n") ?? [];

    assert.ok(
      second.some((line) => first.includes(line)),
      "a question in one window and its answer in the next used to be two " +
        "embeddings that each made incomplete sense",
    );
  });

  test("a short conversation stays one window", () => {
    const windows = windowsFor({ ...INPUT, transcript: "Dave Mullen: hey" });

    assert.equal(windows.length, 1);
  });

  test("an empty transcript produces nothing, not a bare header", () => {
    assert.equal(windowsFor({ ...INPUT, transcript: "   \n  \n" }).length, 0);
  });

  test("a very long conversation is capped at both ends", () => {
    const long = Array.from({ length: 400 }, (_unused, index) =>
      `Dave Mullen: message number ${String(index)} about something or other`,
    ).join("\n");

    const windows = windowsFor({ ...INPUT, transcript: long });

    assert.ok(windows.length <= 12);

    // The end of an argument is usually the part worth finding, so the cap
    // takes both ends rather than the first n.
    const last = windows[windows.length - 1]?.body ?? "";

    assert.match(last, /message number 39\d/);
  });

  test("no window exceeds what a model will take", () => {
    for (const window of windowsFor({ ...INPUT, transcript: Array.from({ length: 6 }, () => TRANSCRIPT).join("\n") })) {
      assert.ok(window.text.length <= 2_000, `window of ${String(window.text.length)} chars`);
    }
  });
});
