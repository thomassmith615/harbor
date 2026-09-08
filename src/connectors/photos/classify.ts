/**
 * What a picture is, decided from its text and nothing else.
 *
 * ## The cost argument, which is the whole design
 *
 * A photo library is tens of thousands of images. Sending them to a vision
 * model is the obvious way to understand them and it is not affordable, not
 * once, and certainly not on every sync. So nothing here ever looks at pixels
 * with a model. The cascade is:
 *
 *   **Metadata.** Free. When it was taken, whether it is a screenshot, how big
 *   it is. Every asset gets this.
 *
 *   **OCR.** Local, no API, roughly a tenth of a second per image on a Mac. Run
 *   once per asset ever and cached, because the pixels do not change.
 *
 *   **This file.** Free. Reads the OCR text and decides what kind of document
 *   it is. A photograph of a dog produces no text and stops here, which is
 *   most of a photo library.
 *
 *   **Structured extraction.** A model call, on the small remainder that looks
 *   like a receipt or a booking. This is the only place money is spent and it
 *   is reached by perhaps one image in a hundred.
 *
 * The important property is that the expensive stage is gated by a free stage
 * that can be inspected and argued with, rather than by a cheap model whose
 * decisions cannot be. If the gate is wrong you can read why.
 *
 * ## Why keywords rather than a classifier
 *
 * A trained classifier would be better at this and needs labelled photos from
 * the person's own library to train on, which do not exist and cannot be
 * obtained without the model call this exists to avoid. The keyword scoring
 * below is worse and it is legible: when a photograph of a menu is treated as a
 * receipt, the reason is a line you can find.
 *
 * The scores are counts of independent signals rather than weights. A receipt
 * has a total, a payment method, a date and a merchant, and needing several of
 * them is what stops a shopping list with the word "total" on it from being a
 * receipt.
 */

export type DocumentKind =
  | "receipt"
  | "booking"
  | "ticket"
  | "conversation"
  | "document"
  | "none";

export interface Classification {
  readonly kind: DocumentKind;
  /** How many independent signals fired. Not a probability. */
  readonly signals: readonly string[];
  /** Whether this is worth spending a model call on. */
  readonly worthExtracting: boolean;
  /** Values found by rule, which the extractor does not need to be asked for. */
  readonly found: {
    readonly total?: string;
    readonly currency?: string;
    readonly reference?: string;
    readonly merchant?: string;
  };
}

/** Below this much text an image is a picture of something, not a document. */
const MIN_TEXT_CHARS = 40;

const MONEY = /(?:^|\s)(?:[$£€]|USD|GBP|EUR)\s?(\d{1,3}(?:[,\d]{0,8})(?:\.\d{2}))\b/i;
const TOTAL_LINE = /\b(?:total|amount due|balance due|grand total|order total|you paid|charged)\b/i;
const PAYMENT = /\b(?:visa|mastercard|amex|discover|debit|credit|apple\s?pay|cash|card ending|xxxx|\*{4})\b/i;
const TAX = /\b(?:subtotal|sales tax|vat|tip|gratuity|service charge)\b/i;

const REFERENCE =
  /\b(?:order|confirmation|conf|reservation|booking|ticket|receipt|invoice|transaction)\s*(?:#|no\.?|number|id|code)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,19})\b/i;

const BOOKING = /\b(?:reservation|booked|check-?in|check-?out|party of|table for|gate|seat|boarding)\b/i;
const TICKET = /\b(?:admit one|general admission|doors open|row\s+\w+\s+seat|e-?ticket|barcode)\b/i;

/**
 * A screenshot of a chat.
 *
 * Worth recognising and worth *not* extracting from. Harbor already has the
 * conversation if it is the person's own; if it is somebody else's chat
 * forwarded as a picture, treating its contents as the person's own messages
 * would put words in their mouth. Classified so it can be labelled and left
 * alone.
 */
const CONVERSATION = /\b(?:imessage|whatsapp|delivered|read receipt|typing|sent \d|today \d{1,2}:\d{2})\b/i;

const MERCHANT_LINE = /^([A-Z][A-Za-z'&.,\- ]{2,40})$/;

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);

  return match?.[1]?.trim();
}

/**
 * A merchant name, guessed from the top of a receipt.
 *
 * The first line that reads like a name rather than an address or a number.
 * Weak, and deliberately reported as `found` rather than asserted: it is here
 * so the extractor has somewhere to start and so a receipt with an obvious
 * merchant does not need a model call at all.
 */
function merchantOf(lines: readonly string[]): string | undefined {
  for (const line of lines.slice(0, 5)) {
    const trimmed = line.trim();

    if (trimmed.length < 3 || /\d{3}/.test(trimmed)) {
      continue;
    }

    const match = MERCHANT_LINE.exec(trimmed);

    if (match !== null) {
      return match[1]?.trim();
    }
  }

  return undefined;
}

export function classify(text: string): Classification {
  const trimmed = text.trim();

  if (trimmed.length < MIN_TEXT_CHARS) {
    // The overwhelming majority of a photo library lands here, for nothing.
    return { kind: "none", signals: [], worthExtracting: false, found: {} };
  }

  const lines = trimmed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

  const signals: string[] = [];

  const money = firstMatch(trimmed, MONEY);
  const reference = firstMatch(trimmed, REFERENCE);

  if (TOTAL_LINE.test(trimmed)) {
    signals.push("names a total");
  }

  if (money !== undefined) {
    signals.push(`shows an amount (${money})`);
  }

  if (PAYMENT.test(trimmed)) {
    signals.push("names a payment method");
  }

  if (TAX.test(trimmed)) {
    signals.push("itemised with tax or tip");
  }

  if (reference !== undefined) {
    signals.push(`carries a reference (${reference})`);
  }

  const merchant = merchantOf(lines);

  const found: Classification["found"] = {
    ...(money === undefined ? {} : { total: money }),
    ...(reference === undefined ? {} : { reference }),
    ...(merchant === undefined ? {} : { merchant }),
  };

  // A conversation screenshot is recognised before anything else, because chat
  // about a purchase contains amounts and would otherwise read as a receipt.
  if (CONVERSATION.test(trimmed) && !TOTAL_LINE.test(trimmed)) {
    return {
      kind: "conversation",
      signals: ["looks like a screenshot of a conversation"],
      // Never. Harbor has the person's own conversations already, and treating
      // a picture of somebody else's as their own would put words in their
      // mouth in a store whose whole discipline is that claims can be checked.
      worthExtracting: false,
      found,
    };
  }

  const receiptSignals = [TOTAL_LINE.test(trimmed), money !== undefined, PAYMENT.test(trimmed), TAX.test(trimmed)]
    .filter(Boolean).length;

  // Two independent signals, not one. "Total" appears on a shopping list and a
  // price appears on a menu; a document with both is a receipt far more often
  // than not, and requiring two is what keeps the model call rare.
  if (receiptSignals >= 2) {
    return { kind: "receipt", signals, worthExtracting: true, found };
  }

  if (TICKET.test(trimmed) && reference !== undefined) {
    return { kind: "ticket", signals: [...signals, "reads like a ticket"], worthExtracting: true, found };
  }

  if (BOOKING.test(trimmed) && (reference !== undefined || money !== undefined)) {
    return { kind: "booking", signals: [...signals, "reads like a booking"], worthExtracting: true, found };
  }

  // Text, but nothing that identifies it. Kept as a document so it is
  // searchable, and never sent to a model: a photograph of a page of a book is
  // exactly this, and there is nothing to extract from it.
  return {
    kind: "document",
    signals: [`${String(lines.length)} lines of text`],
    worthExtracting: false,
    found,
  };
}

/**
 * A stable key for a purchase, so the same one found twice is found once.
 *
 * The cross-source case the whole photo pipeline has to get right: a receipt
 * photographed in a shop and the same receipt mailed by the shop are one
 * purchase. Harbor already knows how to merge two observations that carry the
 * same reference, so where a reference exists the answer is to emit it as an
 * anchor and let the event layer do what it already does.
 *
 * This is the fallback for receipts with no reference on them, which is most
 * paper ones: merchant plus amount plus day is specific enough that two
 * matching records are the same purchase, and coarse enough to survive OCR
 * disagreeing with an email about the merchant's punctuation.
 */
export function purchaseKey(
  merchant: string | undefined,
  total: string | undefined,
  day: string | undefined,
): string | null {
  if (merchant === undefined || total === undefined || day === undefined) {
    return null;
  }

  const name = merchant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 12);

  if (name.length < 3) {
    return null;
  }

  return `purchase:${name}:${total.replace(/[^\d.]/g, "")}:${day}`;
}
