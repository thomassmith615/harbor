/**
 * Entities that hold more than a name.
 *
 * Three things are pinned here and they all exist for the same reason, which is
 * the graph rather than the display. Every linker judges on a shared word, a
 * shared person, or a shared identifier, so two nodes about the same bar under
 * two different names had nothing in common that any rule could see. The fix is
 * not a looser rule. It is to give the store more kinds of thing that can be
 * identical.
 *
 * A place is now an entity, so "Great American Pub" is a key rather than a
 * string. A person can now hold a phone number, an employer or an address, with
 * the words it was read from. And a name can be reached by how it sounds rather
 * than only by how it is spelled.
 *
 * The forbidden half matters as much as the working half, and most of these
 * assertions are on that side: a place entity created from a phrase that is not
 * a name is a magnet that silently collects unrelated evenings, and there is no
 * cheap way to notice it afterwards.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import {
  findPlace,
  isCommonNounVenue,
  isNameableVenue,
  observePlace,
  addPlaceAlias,
} from "../store/places.js";
import {
  attributesFor,
  holdersOfAttribute,
  normalizeAttribute,
  recordAttribute,
} from "../store/attributes.js";
import { createEntity } from "../store/entities.js";
import { metaphone, near, similarity } from "./phonetics.js";
import { statedAttributes } from "./attributes.js";
import { candidates, worthRewriting } from "./propositions.js";
import { openTestStore, type TestStore } from "../fixtures/harness.js";

let store: TestStore;

before(() => {
  store = openTestStore();
});

after(() => {
  store.close();
});

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

describe("places as entities", () => {
  test("a proper name becomes a place", () => {
    const place = observePlace(store.db, {
      phrase: "Great American Pub",
      address: "123 Fayette St, Conshohocken PA",
      observedAt: NOW,
    });

    assert.ok(place !== null);
    assert.equal(place.kind, "place");

    // And the address it was stated with, attached to the place rather than
    // floating as a topic anchor on whichever node happened to carry it.
    const address = attributesFor(store.db, place.id, "address");

    assert.equal(address.length, 1);
    assert.match(address[0]?.value ?? "", /Fayette/);
  });

  test("a shorter name reaches the same place", () => {
    // The whole point. Two nodes saying different things about one venue now
    // hold the same key, and a join on a primary key replaces a fuzzy match on
    // a string neither of them shares.
    const found = findPlace(store.db, "Great American");

    assert.ok(found !== null);
    assert.match(found.entity.displayName, /Great American Pub/);
  });

  test("a common noun is never a place", () => {
    assert.ok(isCommonNounVenue("the bar"));
    assert.ok(isCommonNounVenue("the office"));
    assert.ok(!isNameableVenue("the bar"));

    // Left unresolved forever, deliberately. A single entity called "the bar"
    // would accumulate every unrelated evening in the store and then assert
    // they were all at the same venue.
    assert.equal(observePlace(store.db, { phrase: "the bar", observedAt: NOW }), null);
  });

  test("and cannot be smuggled in as an alias either", () => {
    const place = findPlace(store.db, "Great American Pub");

    assert.ok(place !== null);
    assert.equal(addPlaceAlias(store.db, place.entity.id, "the bar", NOW), false);
  });

  test("names that merely share a word are different places", () => {
    observePlace(store.db, { phrase: "American Legion Hall", observedAt: NOW });

    const found = findPlace(store.db, "American Legion Hall");

    assert.ok(found !== null);
    assert.notEqual(
      found.entity.displayName,
      "Great American Pub",
      "one shared token is a coincidence, not a venue",
    );
  });
});

describe("what is known about a person", () => {
  test("an attribute carries the words it was read from", () => {
    const dave = createEntity(store.db, "person", "Dave Mullen", "test:dave");

    recordAttribute(store.db, {
      entityId: dave.id,
      kind: "phone",
      value: "(610) 555-0182",
      confidence: 0.7,
      origin: "stated",
      sourceKind: "item",
      sourceId: "i1",
      quote: "call me on (610) 555-0182",
      observedAt: NOW,
    });

    const held = attributesFor(store.db, dave.id, "phone");

    assert.equal(held.length, 1);
    assert.equal(held[0]?.quote, "call me on (610) 555-0182");
    assert.equal(held[0]?.origin, "stated");
  });

  test("seeing it again is evidence, not a duplicate", () => {
    const dave = createEntity(store.db, "person", "Dave Mullen", "test:dave");

    recordAttribute(store.db, {
      entityId: dave.id,
      // Written differently on purpose: normalization is what makes this the
      // same claim rather than a second one.
      kind: "phone",
      value: "610-555-0182",
      confidence: 0.6,
      origin: "stated",
      quote: "610-555-0182 is my cell",
      observedAt: NOW + 86_400_000,
    });

    const held = attributesFor(store.db, dave.id, "phone");

    assert.equal(held.length, 1, "one claim, seen twice");
    assert.equal(held[0]?.occurrences, 2);
    assert.equal(held[0]?.confidence, 0.7, "a weaker restatement does not weaken it");
    assert.equal(
      held[0]?.quote,
      "call me on (610) 555-0182",
      "the first quote is the better evidence and is kept",
    );
  });

  test("a value reaches the person who holds it", () => {
    const holders = holdersOfAttribute(store.db, "phone", "+1 610 555 0182");

    assert.equal(holders.length, 1);
  });

  test("two numbers are two attributes, because people have two numbers", () => {
    const dave = createEntity(store.db, "person", "Dave Mullen", "test:dave");

    recordAttribute(store.db, {
      entityId: dave.id,
      kind: "phone",
      value: "610-555-9999",
      confidence: 0.7,
      origin: "source",
      observedAt: NOW,
    });

    assert.equal(attributesFor(store.db, dave.id, "phone").length, 2);
  });

  test("addresses normalize past the ways people abbreviate them", () => {
    assert.equal(
      normalizeAttribute("address", "123 Fayette Street"),
      normalizeAttribute("address", "123 Fayette St."),
    );
  });
});

describe("reading attributes out of what people wrote", () => {
  test("a number with a lead-in is a number", () => {
    const found = statedAttributes("hey, call me on 610-555-0182 when you land");

    assert.equal(found.length, 1);
    assert.equal(found[0]?.kind, "phone");
    assert.match(found[0]?.quote ?? "", /call me on/);
  });

  test("an order number is not", () => {
    // A bare digit pattern matches order numbers, tracking numbers and dates,
    // and a wrong number attached to a person is a number Harbor will
    // confidently offer when asked how to reach them.
    assert.equal(statedAttributes("Your order 3025550182 has shipped").length, 0);
  });

  test("only first-person claims are read", () => {
    assert.ok(statedAttributes("I work at Vanguard Group").some((a) => a.kind === "employer"));

    // "she works at Vanguard" is a claim about somebody not identified well
    // enough to attach it to, and guessing which participant is meant is the
    // inference this refuses to make.
    assert.equal(
      statedAttributes("she works at Vanguard Group").filter((a) => a.kind === "employer").length,
      0,
    );
  });
});

describe("names that are not spelled the same", () => {
  test("sounds-alike spellings share a key", () => {
    for (const [a, b] of [
      ["Caitlin", "Kaitlyn"],
      ["Sean", "Shawn"],
      ["Meyer", "Maier"],
      ["Philip", "Fillip"],
    ]) {
      const left = metaphone(a ?? "");
      const right = metaphone(b ?? "");

      assert.ok(
        left.some((key) => right.includes(key)),
        `${a ?? ""} and ${b ?? ""} should sound alike: ${left.join("/")} vs ${right.join("/")}`,
      );
    }
  });

  test("a typo is caught by distance rather than by sound", () => {
    assert.ok(similarity("Micheal", "Michael") > 0.9);
    assert.ok(near("Stephan", "Stephen"));
  });

  test("different names stay different", () => {
    // The failure that matters. In vector space "Dave" sits as close to "Dan"
    // as to "David", which is why this layer is phonetic and not semantic.
    assert.ok(!near("Dave", "Dan"));
    assert.ok(!near("Sam", "Pam"));
    assert.ok(!near("Nina", "Nick"));
  });

  test("a shared prefix counts for more than a shared ending", () => {
    assert.ok(similarity("Mullen", "Mullins") > similarity("Mullen", "Bullen"));
  });
});

describe("messages that mean nothing alone", () => {
  test("the short and empty ones are the ones worth rewriting", () => {
    assert.ok(worthRewriting("yeah I'm going"));
    assert.ok(worthRewriting("same"));
    assert.ok(worthRewriting("ok cool"));
  });

  test("a message that already carries a noun is left alone", () => {
    // It would cost a forward pass and add a chance of getting it wrong, to
    // make findable something that already was.
    assert.ok(!worthRewriting("Great American Pub at 8"));
    assert.ok(!worthRewriting("call me on 610-555-0182"));
    assert.ok(
      !worthRewriting(
        "the rendering bug is still open and the vendor has not replied about the patch",
      ),
    );
  });

  test("candidates come back with their line numbers", () => {
    const transcript = [
      "Dave Mullen: who's going to the bar later",
      "Sam Ortiz: same",
      "Me: yeah I'm going",
    ].join("\n");

    const found = candidates(transcript);

    assert.deepEqual(
      found.map((entry) => entry.ordinal),
      [1, 2],
      "the proposal has content of its own; the two answers do not",
    );
  });
});
