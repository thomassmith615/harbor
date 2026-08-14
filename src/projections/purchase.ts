/**
 * Purchases.
 *
 * The first projection type, and the template for the ones after it. A type
 * declares four things: which items are worth reading, what the model is asked
 * for, how the answer is verified, and how it maps onto the columns people
 * aggregate over.
 *
 * The candidate predicate carries most of the weight. It is deterministic and
 * free, so it can be run over an entire mailbox to decide what the expensive
 * step even looks at, and its count is knowable before a single model call.
 * With a mailbox that is mostly marketing, that is the difference between
 * reading two hundred emails and reading thirty thousand.
 *
 * Verification here is arithmetic rather than quotation. A receipt states
 * numbers, and numbers can be checked against the text they supposedly came
 * from: an amount the extractor invented does not appear in the email, and a
 * total that does not match its own line items is wrong regardless of how
 * plausible it reads.
 */

export const PURCHASE_SCHEMA_VERSION = 1;

/**
 * Words that make an email look like a receipt.
 *
 * Two groups, and both must hit. Commerce language alone matches every
 * marketing blast ever sent; a currency amount alone matches bank alerts,
 * invoices, and half of Twitter. Requiring one of each is what keeps the
 * candidate set small enough to be worth reading.
 */
const RECEIPT_WORDS =
  /\b(receipt|order confirmation|your order|thanks for your order|invoice|payment received|purchase|transaction|order #|order no|shipped|delivered|subtotal)\b/i;

/**
 * A currency amount, in the shapes real receipts actually use.
 *
 * Bare decimals count. A first pass required a symbol or a currency code and
 * rejected an ordinary order confirmation, because receipts lay their amounts
 * out in a column where the symbol appears once at the top or not at all:
 * "Total    28.60" is the normal case, not the exception.
 *
 * That alone would match version numbers and percentages, which is why it is
 * never used on its own: an item has to carry receipt language as well, and the
 * marketing exclusion runs before either.
 */
const MONEY = /(?:[$£€]\s?\d[\d,]*\.\d{2}|\b\d[\d,]*\.\d{2}\b)/;

/**
 * Things that look commercial and are not a purchase.
 *
 * A promotional email says "order now" and quotes prices; a delivery
 * notification says "shipped" and quotes nothing. Both would otherwise pass the
 * two tests above and produce a purchase that never happened. Cheap to exclude
 * here, expensive to notice later in a spending total.
 */
const NOT_A_RECEIPT =
  /\b(unsubscribe to stop|shop now|limited time|% off|sale ends|deal of the|newsletter|price drop|back in stock|recommended for you|abandoned cart)\b/i;

export interface PurchaseCandidateInput {
  readonly title: string | null;
  readonly body: string | null;
  readonly author: string | null;
  /** Text pulled out of attachments, which is where PDF receipts hide. */
  readonly attachmentText: string | null;
}

export function looksLikePurchase(input: PurchaseCandidateInput): boolean {
  const text = `${input.title ?? ""}\n${input.body ?? ""}\n${input.attachmentText ?? ""}`;

  if (text.trim().length === 0) {
    return false;
  }

  // Marketing is checked first and wins ties. A promotional email that also
  // happens to say "receipt" is still marketing, and the cost of missing one
  // real receipt is much lower than the cost of a spending total that includes
  // things nobody bought.
  if (NOT_A_RECEIPT.test(text)) {
    return false;
  }

  return RECEIPT_WORDS.test(text) && MONEY.test(text);
}

export const PURCHASE_SYSTEM = `You extract a purchase from a receipt or order confirmation.

Rules:
- Only extract what the message states. Never infer a price, a date, or a merchant.
- total is the amount actually charged, including tax and shipping. If the message
  shows a subtotal and a total, use the total.
- Amounts are numbers in the currency's major unit: 8.99, not "$8.99" and not 899.
- currency is a three-letter code. Infer it from the symbol only ($ -> USD unless the
  message says otherwise).
- occurred is an ISO 8601 date, and only if the message states one. Otherwise null.
- items is the line items if the message lists them, otherwise an empty list.
- If this is not actually a purchase (a shipping notice with no amount, a promotion,
  a bank alert, a subscription reminder), return {"purchase": null}. That is a normal
  and frequent answer.

Respond with JSON only, no prose and no code fences:
{"purchase":{"merchant":"...","total":0.00,"currency":"USD","occurred":null,"reference":null,
"items":[{"description":"...","quantity":null,"unit":null,"amount":0.00}],"confidence":0.0}}`;

export interface ExtractedPurchase {
  readonly merchant: string | null;
  readonly totalCents: number | null;
  readonly currency: string | null;
  readonly occurred: number | null;
  readonly reference: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: number | null;
    readonly unit: string | null;
    readonly amountCents: number | null;
  }[];
  readonly confidence: number;
}

export interface PurchaseVerdict {
  readonly purchase: ExtractedPurchase | null;
  readonly rejected: string | null;
}

function toCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.round(value * 100);
}

/** Digits only, so "$1,284.50" and "1284.50" compare equal. */
function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, "");
}

/**
 * Checks an extracted purchase against the text it came from.
 *
 * Two tests, and both are about arithmetic rather than plausibility.
 *
 * The total has to appear in the source. A model reading a long receipt will
 * occasionally produce a number that is the sum of the wrong column, or simply a
 * number that reads like a price; if the digits are not in the email, Harbor did
 * not find that amount, it made it up.
 *
 * And line items, when present, have to roughly sum to the total. Tax and
 * shipping mean the match is never exact, so the tolerance is wide, but an
 * itemization that is off by a factor of two is a parse that went wrong.
 */
export function verifyPurchase(raw: unknown, sourceText: string): PurchaseVerdict {
  if (typeof raw !== "object" || raw === null) {
    return { purchase: null, rejected: "response was not an object" };
  }

  const record = (raw as { purchase?: unknown }).purchase;

  if (record === null || record === undefined) {
    return { purchase: null, rejected: null };
  }

  if (typeof record !== "object") {
    return { purchase: null, rejected: "purchase was not an object" };
  }

  const fields = record as Record<string, unknown>;
  const merchant = typeof fields["merchant"] === "string" ? fields["merchant"].trim() : null;
  const totalCents = toCents(fields["total"]);

  if (totalCents === null || totalCents === 0) {
    return { purchase: null, rejected: "no usable total" };
  }

  const haystack = digitsOf(sourceText);
  const needle = digitsOf((totalCents / 100).toFixed(2));

  if (!haystack.includes(needle)) {
    return {
      purchase: null,
      rejected: `total ${(totalCents / 100).toFixed(2)} does not appear in the message`,
    };
  }

  const rawLines = Array.isArray(fields["items"]) ? fields["items"] : [];
  const lines: ExtractedPurchase["lines"] = rawLines
    .filter((line): line is Record<string, unknown> => typeof line === "object" && line !== null)
    .map((line) => ({
      description: typeof line["description"] === "string" ? line["description"].trim() : "",
      quantity: typeof line["quantity"] === "number" ? line["quantity"] : null,
      unit: typeof line["unit"] === "string" ? line["unit"] : null,
      amountCents: toCents(line["amount"]),
    }))
    .filter((line) => line.description.length > 0);

  const lineSum = lines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0);

  // Only checked when the itemization is complete enough to mean something.
  // Tax, shipping, and discounts all live outside the line items, so the
  // tolerance is deliberately loose: this catches a parse that went wrong, not
  // a receipt that has a delivery fee.
  if (lines.length > 1 && lineSum > 0 && (lineSum > totalCents * 1.5 || lineSum < totalCents * 0.4)) {
    return {
      purchase: null,
      rejected: `line items sum to ${(lineSum / 100).toFixed(2)} against a total of ${(totalCents / 100).toFixed(2)}`,
    };
  }

  const occurredRaw = fields["occurred"];
  let occurred: number | null = null;

  if (typeof occurredRaw === "string" && occurredRaw.length > 0) {
    const parsed = Date.parse(occurredRaw);
    occurred = Number.isNaN(parsed) ? null : parsed;
  }

  const currency =
    typeof fields["currency"] === "string" && /^[A-Za-z]{3}$/.test(fields["currency"])
      ? fields["currency"].toUpperCase()
      : null;

  return {
    purchase: {
      merchant: merchant !== null && merchant.length > 0 ? merchant : null,
      totalCents,
      currency,
      occurred,
      reference: typeof fields["reference"] === "string" ? fields["reference"] : null,
      lines,
      confidence:
        typeof fields["confidence"] === "number"
          ? Math.min(1, Math.max(0, fields["confidence"]))
          : 0.6,
    },
    rejected: null,
  };
}
