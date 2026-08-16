/**
 * Who said it.
 *
 * From a real failure. Asked what somebody liked, Harbor answered from things
 * the *user* had said to them, and separately decided the user was spending a
 * weekend with someone he had merely texted about a hot tub. Both come from the
 * same place: a transcript reaches the model labelled `with: ["Isabella"]`, and
 * the whole payload then reads as hers.
 *
 * The labels were always in the text. What was missing was any way to ask for
 * one speaker's own words, and an unambiguous name for the user's own lines:
 * "Me" is whoever is talking.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { asYou, quotesBy, quotesFor, speakersIn } from "./tools.js";

const TRANSCRIPT = [
  "Me: heading to the poconos this weekend, airbnb with sam",
  "Isabella Forté: omg nice, is there a hot tub",
  "Me: yeah and the weather looks perfect",
  "Isabella Forté: jealous. i love a hot tub",
  "Me: dress dece for coyote crossing after",
].join("\n");

test("speaker attribution", async (t) => {
  await t.test("the user's own lines are unambiguously theirs", () => {
    const named = asYou(TRANSCRIPT);

    assert.ok(named.includes("You: heading to the poconos"));
    assert.ok(!named.includes("Me:"));
  });

  await t.test("a label is only rewritten at the start of a line", () => {
    // "Me" inside somebody's sentence is not a speaker label, and rewriting it
    // would put words in the user's mouth, which is the exact failure mode.
    const tricky = asYou("Isabella Forté: tell Me: when you land");

    assert.equal(tricky, "Isabella Forté: tell Me: when you land");
  });

  await t.test("quotes returns only what that person said", () => {
    const quotes = quotesBy(asYou(TRANSCRIPT), "Isabella Forté");

    assert.deepEqual(quotes, ["omg nice, is there a hot tub", "jealous. i love a hot tub"]);
  });

  await t.test("the thing the user said is never attributed to them", () => {
    // The specific bug. "the weather looks perfect" and the Poconos trip are
    // the user's, and asking what Isabella said must not return either.
    const quotes = quotesBy(asYou(TRANSCRIPT), "Isabella Forté").join(" ");

    assert.ok(!quotes.includes("poconos"));
    assert.ok(!quotes.includes("weather"));
    assert.ok(!quotes.includes("dress dece"));
  });

  await t.test("the user's own quotes are reachable too", () => {
    const quotes = quotesBy(asYou(TRANSCRIPT), "You");

    assert.equal(quotes.length, 3);
    assert.ok(quotes[0]?.includes("poconos"));
  });

  await t.test("a display name carrying a surname still matches its label", () => {
    // Name resolution and the entity's display name do not always agree on how
    // much of a name to use, and a miss here silently returns no quotes, which
    // reads as "they never said anything" rather than as a bug.
    assert.equal(quotesBy("Isabella: hi there", "Isabella Forté").length, 1);
    assert.equal(quotesBy("Isabella Forté: hi there", "Isabella").length, 1);
  });

  await t.test("a different person matches nothing", () => {
    assert.equal(quotesBy(asYou(TRANSCRIPT), "Sam Gutekunst").length, 0);
  });

  await t.test("lines without a speaker label are skipped, not guessed at", () => {
    assert.deepEqual(quotesBy("...\nYou: real line", "You"), ["real line"]);
  });

  await t.test("a speaker who matched nothing is not reported as having said nothing", () => {
    // The difference that matters. An empty array alone cannot distinguish
    // "they said nothing" from "that name is not a label in here", and a model
    // reading one will confidently report the other.
    const miss = quotesFor(asYou(TRANSCRIPT), "Sam Gutekunst");

    assert.deepEqual(miss["quotes"], []);
    assert.ok(typeof miss["said_by_note"] === "string");
    assert.ok(String(miss["said_by_note"]).includes("Isabella Forté"));
  });

  await t.test("a speaker who did match carries no note", () => {
    const hit = quotesFor(asYou(TRANSCRIPT), "Isabella Forté");

    assert.equal(hit["said_by_note"], undefined);
    assert.equal((hit["quotes"] as string[]).length, 2);
  });

  await t.test("the speakers in a transcript are listed for a retry", () => {
    assert.deepEqual([...speakersIn(asYou(TRANSCRIPT))], ["You", "Isabella Forté"]);
  });

  await t.test("a long line without a label is not mistaken for a speaker", () => {
    // ": " turns up inside ordinary sentences. A speaker label is short.
    assert.deepEqual(
      [...speakersIn("You: here is the thing I meant: the whole point of it")],
      ["You"],
    );
  });
});
