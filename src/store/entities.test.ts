/**
 * Handles becoming names, everywhere a person reads them.
 *
 * This existed and was private to the file that first needed it, so `harbor
 * situations` printed "Isabella Forté" while the chat answering "who have I
 * texted today" printed a table of phone numbers. The resolution knew the
 * answer and the layer a person actually reads never asked.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { openTestStore, type TestStore } from "../fixtures/harness.js";
import { nameForHandle, nameHandles, nameTranscript } from "./entities.js";

let store: TestStore;
const PHONE = "+15551230001";
const OTHER = "+15551230009";

before(() => {
  store = openTestStore();

  for (const [id, name, handle] of [
    ["e_isabella", "Isabella Forté", PHONE],
    ["e_joey", "Joey Dugery", OTHER],
  ] as const) {
    store.db
      .prepare(
        `INSERT INTO entities (id, kind, display_name, created_at, updated_at)
         VALUES (?, 'person', ?, 0, 0)`,
      )
      .run(id, name);

    store.db
      .prepare(
        `INSERT INTO identifiers (id, entity_id, kind, value, normalized, confidence)
         VALUES (?, ?, 'handle', ?, ?, 1)`,
      )
      .run(`i_${id}`, id, handle, handle);
  }
});

after(() => {
  store.close();
});

describe("naming a handle", () => {
  test("a known number becomes a name", () => {
    assert.equal(nameForHandle(store.db, PHONE), "Isabella Forté");
  });

  test("a name identifier is used when the display name is a handle", () => {
    // The common case, and the one the first version missed. An entity created
    // from a message is named after the handle it came from; the real name
    // arrives later from a contact card and lands as an identifier. Giving up
    // on a handle-shaped display name skipped exactly the entity that most
    // needed naming.
    store.db
      .prepare(
        `INSERT INTO entities (id, kind, display_name, created_at, updated_at)
         VALUES ('e_fromtext', 'person', '+15551230022', 0, 0)`,
      )
      .run();

    store.db
      .prepare(
        `INSERT INTO identifiers (id, entity_id, kind, value, normalized, confidence)
         VALUES ('i_ft_h', 'e_fromtext', 'handle', '+15551230022', '+15551230022', 1),
                ('i_ft_n', 'e_fromtext', 'name', 'Sam Gutekunst', 'sam gutekunst', 1)`,
      )
      .run();

    assert.equal(nameForHandle(store.db, "+15551230022"), "Sam Gutekunst");
  });

  test("an unknown number stays a number", () => {
    // Never invent. A handle with nobody behind it is still information.
    assert.equal(nameForHandle(store.db, "+15559998888"), null);
  });

  test("something that is not a handle is left alone", () => {
    assert.equal(nameForHandle(store.db, "Wegmans"), null);
  });

  test("a group title names everyone it can", () => {
    assert.equal(
      nameHandles(store.db, `${PHONE}, ${OTHER}`),
      "Isabella Forté, Joey Dugery",
    );
  });

  test("a title mixing known and unknown keeps what it cannot resolve", () => {
    assert.equal(
      nameHandles(store.db, `${PHONE}, +15559998888`),
      "Isabella Forté, +15559998888",
    );
  });
});

describe("naming a transcript", () => {
  test("speaker labels become names", () => {
    // The labels are written at derive time, when a message knows only the
    // handle it came from. Resolving at read time means a later merge or rename
    // shows up without re-deriving anything.
    const transcript = [
      `${PHONE}: are we still on for saturday`,
      "Me: yes, 7pm",
      `${OTHER}: bringing the tart`,
    ].join("\n");

    const named = nameTranscript(store.db, transcript);

    assert.ok(named.includes("Isabella Forté: are we still on"), named);
    assert.ok(named.includes("Joey Dugery: bringing the tart"), named);
    assert.ok(named.includes("Me: yes, 7pm"), "the user's own label was changed");
  });

  test("a number inside a message is not a speaker", () => {
    // Only a label at the start of a line, or "call me on +1555..." becomes a
    // name mid-sentence and the transcript stops being what was said.
    const named = nameTranscript(store.db, `Me: call me on ${PHONE} later`);

    assert.equal(named, `Me: call me on ${PHONE} later`);
  });
});
