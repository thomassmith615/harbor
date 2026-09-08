/**
 * The photo cascade.
 *
 * Three things are worth testing here and the pixels are not among them. What
 * matters is that the cheap stages stop almost everything, that two screenshots
 * of one receipt become one document rather than two, and that a receipt found
 * in a photo and the same receipt found in a mail end up as one purchase rather
 * than a duplicate.
 *
 * OCR itself is not tested, and could not usefully be: it is a system framework
 * behind a subprocess, and a test that mocked it would be testing the mock. The
 * engine is an interface for exactly this reason, so everything above it can be
 * driven with text.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { classify, purchaseKey } from "../connectors/photos/classify.js";
import { containment, group, overlapLength } from "../connectors/photos/stitch.js";
import { triagePhotos } from "./photos.js";
import { saveAccount } from "../store/accounts.js";
import { ensureStream } from "../store/streams.js";
import { upsertItem } from "../store/items.js";
import { openTestStore, type TestStore } from "../fixtures/harness.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { Capture } from "../connectors/photos/stitch.js";
import type { OcrEngine } from "../connectors/photos/ocr.js";

const RECEIPT_TOP = [
  "MARCONI TAVERN",
  "123 Fayette St",
  "Conshohocken PA",
  "",
  "Order #A47120",
  "2 Burger            24.00",
  "1 Fries              6.50",
].join("\n");

const RECEIPT_BOTTOM = [
  "Order #A47120",
  "2 Burger            24.00",
  "1 Fries              6.50",
  "Subtotal            30.50",
  "Sales tax            2.44",
  "Tip                  6.00",
  "TOTAL              $38.94",
  "VISA ending 4417",
].join("\n");

describe("what a picture is, from its text", () => {
  test("a photograph of nothing costs nothing", () => {
    const verdict = classify("");

    assert.equal(verdict.kind, "none");
    assert.equal(verdict.worthExtracting, false);

    // The stage that stops most of a photo library, for free. If this ever
    // starts returning something extractable, the model bill is the symptom.
    assert.equal(classify("IMG_4471").kind, "none");
  });

  test("a receipt needs two independent signals, not one", () => {
    // "Total" on its own is a shopping list; a price on its own is a menu.
    assert.notEqual(classify("Milk\nEggs\nBread\nTotal 3 items to buy today").kind, "receipt");

    const verdict = classify(RECEIPT_BOTTOM);

    assert.equal(verdict.kind, "receipt");
    assert.equal(verdict.worthExtracting, true);
    assert.ok(verdict.signals.length >= 2);
  });

  test("what a rule already found is not asked of a model", () => {
    const verdict = classify(RECEIPT_BOTTOM);

    assert.equal(verdict.found.total, "38.94");
    assert.equal(verdict.found.reference, "A47120");

    // No merchant on this half: the shop's name is on the top of the receipt
    // and this is the bottom. Worth asserting rather than working around,
    // because it is the reason stitching happens before extraction.
    assert.equal(verdict.found.merchant, undefined);
    assert.equal(classify(RECEIPT_TOP).found.merchant, "MARCONI TAVERN");
  });

  test("a screenshot of a conversation is recognised and left alone", () => {
    const verdict = classify(
      "Dave Mullen\niMessage\nToday 8:14\nyeah I paid you back $40\nDelivered",
    );

    assert.equal(verdict.kind, "conversation");

    // Never extracted. Harbor has the person's own conversations already, and
    // treating a picture of somebody else's as theirs would put words in their
    // mouth in a store whose whole discipline is that claims can be checked.
    assert.equal(verdict.worthExtracting, false);
  });

  test("a page of text is stored and not extracted from", () => {
    const verdict = classify(
      "Chapter four. The rain had been falling since morning and the road out " +
        "of the valley was closed at both ends, which nobody had thought to mention.",
    );

    assert.equal(verdict.kind, "document");
    assert.equal(verdict.worthExtracting, false);
  });
});

describe("two screenshots of one receipt", () => {
  test("the overlap is found where it actually is", () => {
    const top = RECEIPT_TOP.split("\n").filter((line) => line.length > 0);
    const bottom = RECEIPT_BOTTOM.split("\n").filter((line) => line.length > 0);

    assert.equal(overlapLength(top, bottom), 3, "the three shared lines in the middle");
    assert.equal(overlapLength(bottom, top), 0, "and not the other way round");
  });

  test("they become one document with the total counted once", () => {
    const captures: Capture[] = [
      { id: "a", takenAt: 1_000_000, text: RECEIPT_TOP, isScreenshot: true },
      { id: "b", takenAt: 1_004_000, text: RECEIPT_BOTTOM, isScreenshot: true },
    ];

    const documents = group(captures);

    assert.equal(documents.length, 1);
    assert.equal(documents[0]?.how, "stitched");
    assert.deepEqual(documents[0]?.parts, ["a", "b"]);

    const text = documents[0]?.text ?? "";

    // The whole point. Concatenating them would list the burger twice and
    // could have the extractor read the subtotal as a second purchase.
    assert.equal(text.match(/Burger/g)?.length, 1);
    assert.ok(text.includes("MARCONI TAVERN"));
    assert.ok(text.includes("TOTAL              $38.94"));
  });

  test("the bottom captured first still stitches", () => {
    const documents = group([
      { id: "b", takenAt: 1_000_000, text: RECEIPT_BOTTOM, isScreenshot: true },
      { id: "a", takenAt: 1_003_000, text: RECEIPT_TOP, isScreenshot: true },
    ]);

    assert.equal(documents.length, 1);
    assert.ok((documents[0]?.text ?? "").startsWith("MARCONI TAVERN"));
  });

  test("the same screen captured twice keeps the better read", () => {
    const documents = group([
      { id: "a", takenAt: 1_000_000, text: RECEIPT_BOTTOM, isScreenshot: true },
      {
        id: "b",
        takenAt: 1_002_000,
        text: `${RECEIPT_BOTTOM}\nThank you for visiting`,
        isScreenshot: true,
      },
    ]);

    assert.equal(documents.length, 1);
    assert.equal(documents[0]?.how, "deduplicated");
    assert.ok((documents[0]?.text ?? "").includes("Thank you"));
  });
});

describe("what must not be stitched", () => {
  test("two receipts from the same shop on different days", () => {
    // Every similarity measure says these are one document: same header, same
    // address, same layout, most of the same words. What separates them is that
    // they were not captured as one act, which is why the chain is temporal
    // rather than a clustering over overlap.
    const documents = group([
      { id: "a", takenAt: 1_000_000, text: RECEIPT_BOTTOM, isScreenshot: true },
      {
        id: "b",
        takenAt: 1_000_000 + 3 * 86_400_000,
        text: RECEIPT_BOTTOM.replace("A47120", "A99001"),
        isScreenshot: true,
      },
    ]);

    assert.equal(documents.length, 2);
  });

  test("three receipts from the same shop do not chain into one", () => {
    const documents = group(
      [0, 1, 2].map((index) => ({
        id: `r${String(index)}`,
        takenAt: 1_000_000 + index * 600_000,
        text: RECEIPT_BOTTOM.replace("A47120", `A9900${String(index)}`),
        isScreenshot: true,
      })),
    );

    assert.equal(documents.length, 3, "similarity chained three separate visits into one");
  });

  test("photographs are never stitched, however alike", () => {
    const documents = group([
      { id: "a", takenAt: 1_000_000, text: RECEIPT_TOP, isScreenshot: false },
      { id: "b", takenAt: 1_002_000, text: RECEIPT_BOTTOM, isScreenshot: false },
    ]);

    assert.equal(documents.length, 2);
  });

  test("containment and sequence overlap are different questions", () => {
    const top = RECEIPT_TOP.split("\n").filter((line) => line.length > 0);
    const bottom = RECEIPT_BOTTOM.split("\n").filter((line) => line.length > 0);

    assert.ok(containment(top, bottom) > 0.3);
    assert.ok(containment(top, bottom) < 0.9, "not a duplicate, a continuation");
  });
});

describe("one purchase found twice", () => {
  test("a photographed receipt and a mailed one share a key", () => {
    // A reference on both is the strong case, and the event layer already
    // merges on a shared reference with no photo-specific code. This is the
    // fallback for paper receipts that carry no order number.
    const fromPhoto = purchaseKey("Marconi Tavern", "$38.94", "2026-08-27");
    const fromMail = purchaseKey("MARCONI TAVERN,", "38.94", "2026-08-27");

    assert.ok(fromPhoto !== null);
    assert.equal(fromPhoto, fromMail);
  });

  test("a different amount is a different purchase", () => {
    assert.notEqual(
      purchaseKey("Marconi Tavern", "38.94", "2026-08-27"),
      purchaseKey("Marconi Tavern", "41.20", "2026-08-27"),
    );
  });

  test("too little to be sure is null rather than a guess", () => {
    assert.equal(purchaseKey(undefined, "38.94", "2026-08-27"), null);
    assert.equal(purchaseKey("Ax", "38.94", "2026-08-27"), null);
  });
});

describe("the cascade, end to end", () => {
  let store: TestStore;

  const fakeOcr = (texts: Readonly<Record<string, string>>): OcrEngine => ({
    id: "fixture",
    read: (path) => texts[path] ?? null,
  });

  before(() => {
    store = openTestStore();

    const account = saveAccount(store.db, {
      sourceType: "apple",
      label: "Photos",
      credentials: { accessToken: "fixture", refreshToken: "", expiresAt: 0, scope: "" },
    });

    const stream = ensureStream(store.db, account.id, "apple-photos");

    const photos = [
      { id: "p1", file: "top.png", at: 1_000_000, screenshot: true },
      { id: "p2", file: "bottom.png", at: 1_004_000, screenshot: true },
      { id: "p3", file: "dog.jpg", at: 2_000_000, screenshot: false },
    ];

    for (const photo of photos) {
      upsertItem(store.db, {
        accountId: account.id,
        streamId: stream.id,
        externalId: photo.id,
        kind: "photo",
        threadId: null,
        title: photo.file,
        body: null,
        author: null,
        participants: [],
        occurredAt: photo.at,
        endsAt: null,
        state: null,
        raw: { filename: photo.file, screenshot: photo.screenshot },
      });
    }
  });

  after(() => {
    store.close();
  });

  test("only the images with text cost anything downstream", () => {
    const report = triagePhotos(store.db, {
      principalId: DEFAULT_PRINCIPAL,
      engine: fakeOcr({ "top.png": RECEIPT_TOP, "bottom.png": RECEIPT_BOTTOM, "dog.jpg": "" }),
      locate: (raw) => (typeof raw["filename"] === "string" ? raw["filename"] : null),
    });

    assert.equal(report.read, 3);
    assert.equal(report.withText, 2);
    assert.equal(report.byKind["none"], 1, "the dog stopped at the free stage");
    assert.equal(report.stitched, 1);
  });

  test("the stitched text lands on one item and not on both", () => {
    const bodies = store.db
      .prepare(`SELECT external_id AS id, body FROM items WHERE kind = 'photo' ORDER BY external_id`)
      .all() as { id: string; body: string | null }[];

    const first = bodies.find((row) => row.id === "p1");
    const second = bodies.find((row) => row.id === "p2");

    assert.ok((first?.body ?? "").includes("TOTAL"));

    // The second half carries no body, so the total is indexed once. Without
    // this a receipt split across two screenshots is counted twice by anything
    // that reads item bodies, which is everything.
    assert.equal(second?.body, null);
  });

  test("a second run reads nothing, because pixels do not change", () => {
    const report = triagePhotos(store.db, {
      principalId: DEFAULT_PRINCIPAL,
      engine: fakeOcr({}),
      locate: () => null,
    });

    assert.equal(report.read, 0);
    assert.equal(report.remaining, 0);
  });
});
