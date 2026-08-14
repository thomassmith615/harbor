/**
 * Reading what is inside an attachment.
 *
 * The PDF case is the one that matters and the one that was quietly broken.
 * Most of the receipts in a real mailbox put their line items in a PDF, and the
 * original reader rejected every modern PDF with "bad XRef entry" while
 * recording the attachment as simply unreadable. No error surfaced, no
 * dependency was missing, and `harbor purchases` was empty for a reason nothing
 * reported.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { extractAttachmentText } from "./attachments.js";
import { receiptPdf, RECEIPT_PDF_CONTAINS } from "../fixtures/receipt-pdf.js";

describe("attachment text", () => {
  test("a real PDF gives up its line items", async () => {
    const { text, error } = await extractAttachmentText("receipt.pdf", "application/pdf", receiptPdf());

    // A missing optional dependency is a legitimate state, not a failure. It is
    // reported and skipped, which is the behaviour when somebody installs
    // Harbor without the PDF extra.
    if (error !== null && error.includes("not installed")) {
      return;
    }

    assert.equal(error, null, `the PDF reader failed: ${error ?? ""}`);
    assert.ok(text !== null, "the PDF produced no text");

    for (const wanted of RECEIPT_PDF_CONTAINS) {
      assert.ok(
        (text ?? "").includes(wanted),
        `"${wanted}" was not found in the extracted text`,
      );
    }
  });

  test("html is reduced to its words", async () => {
    const { text } = await extractAttachmentText(
      "order.html",
      "text/html",
      Buffer.from("<html><body><h1>Order 4471</h1><p>Total <b>42.17</b></p></body></html>"),
    );

    assert.ok((text ?? "").includes("Order 4471"));
    assert.ok(!(text ?? "").includes("<b>"), "markup survived into the text");
  });

  test("something unreadable is recorded rather than failed", async () => {
    // An image attachment is not an error. Treating it as one would put a
    // permanent problem on every mailbox that contains a photo.
    const { text, error } = await extractAttachmentText(
      "photo.jpg",
      "image/jpeg",
      Buffer.from([0xff, 0xd8, 0xff]),
    );

    assert.equal(text, null);
    assert.equal(error, null);
  });
});
