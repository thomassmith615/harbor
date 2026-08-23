/**
 * What a small local model actually returns, and what is allowed through.
 *
 * The model call cannot be tested without a model. What can be tested is the
 * gate in front of the database, and that gate is the whole safety argument for
 * letting a model write anything into a person's own store: a sentence that is
 * wrong in an obvious way should become no sentence, because the situation
 * reads fine without one and reads badly with a lie on top.
 *
 * Every case below is a real shape a 3B model produces.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { tidy } from "./name.js";

describe("cleaning up what the model said", () => {
  test("a plain sentence passes through", () => {
    const out = tidy("You are planning dinner at Coyote Crossing with friends.");

    assert.equal(out, "You are planning dinner at Coyote Crossing with friends.");
  });

  test("a chatty preface is removed", () => {
    // Small models cannot help themselves.
    for (const prefix of [
      "Sure! ",
      "Certainly, ",
      "Here is a summary: ",
      "Here's a one-sentence summary: ",
      "Summary: ",
    ]) {
      const out = tidy(prefix + "You are arranging a trip to Boston in September.");

      assert.equal(
        out,
        "You are arranging a trip to Boston in September.",
        `"${prefix}" survived`,
      );
    }
  });

  test("wrapping quotes are removed", () => {
    assert.equal(tidy('"You booked a table for Friday."'), "You booked a table for Friday.");
    assert.equal(tidy("\u201cYou booked a table for Friday.\u201d"), "You booked a table for Friday.");
  });

  test("a second sentence of unasked-for advice is dropped", () => {
    const out = tidy(
      "You are planning dinner at Coyote Crossing. You should confirm with everyone soon!",
    );

    assert.equal(out, "You are planning dinner at Coyote Crossing.");
  });

  test("a refusal becomes no summary", () => {
    // Better an unlabelled situation than one labelled with an apology.
    for (const refusal of [
      "I'm sorry, I cannot summarise personal messages.",
      "As an AI language model, I do not have access to that.",
      "I cannot determine what these messages are about.",
    ]) {
      assert.equal(tidy(refusal), null, `let through: ${refusal}`);
    }
  });

  test("talking about the task rather than the situation is rejected", () => {
    assert.equal(tidy("The user appears to be planning something."), null);
    assert.equal(tidy("These messages discuss a dinner reservation."), null);
  });

  test("something too short to mean anything is rejected", () => {
    assert.equal(tidy("Dinner."), null);
    assert.equal(tidy(""), null);
    assert.equal(tidy("   "), null);
  });

  test("an essay is rejected rather than truncated mid-thought", () => {
    // First-sentence extraction handles the common case; a single sentence of
    // 300 characters means the model ignored the instruction entirely, and
    // cutting it produces something that reads like a bug.
    assert.equal(tidy("You " + "and ".repeat(80) + "them"), null);
  });

  test("a sentence with no terminator is still usable", () => {
    assert.equal(
      tidy("You are planning dinner at Coyote Crossing with friends"),
      "You are planning dinner at Coyote Crossing with friends",
    );
  });
});

describe("the failures from the first real run", () => {
  // Every string here is something a model actually returned over one store of
  // fifty situations. None of them were caught by the first version of tidy.
  test("hedging about what it can see is rejected", () => {
    assert.equal(
      tidy(
        "These belong to you, but I don't see any explicit indication of the " +
          "specific thing being a plan.",
      ),
      null,
    );
  });

  test("appearing and seeming are rejected", () => {
    assert.equal(tidy("It appears it's about your upcoming trip to Philadelphia."), null);
    assert.equal(tidy("It seems you are planning dinner."), null);
  });

  test("listing what it was given is rejected", () => {
    assert.equal(tidy("These are items for the welcome party and the wedding."), null);
    assert.equal(tidy("Based on the text below, you have a dinner."), null);
  });

  test("a plain grounded sentence still passes", () => {
    // The filter has to stay narrow enough to let the good ones through, or
    // every situation is unlabelled and the feature is off.
    for (const good of [
      "You had dinner with friends at Coyote Crossing twice in July.",
      "You bought pretzels and had a reminder to pick them up.",
      "A dinner reservation and an unrelated reminder about laundry.",
      "You have a wedding rehearsal dinner at Reading Terminal on April 16th.",
    ]) {
      assert.equal(tidy(good), good, `rejected a good summary: ${good}`);
    }
  });
});
