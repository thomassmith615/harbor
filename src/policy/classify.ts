/**
 * Sensitivity classification.
 *
 * Three levels, deliberately few. More would be a taxonomy nobody maintains.
 *
 *   normal      Ordinary correspondence.
 *   sensitive   Financial, medical, legal, credentials, anything with a number
 *               on it that a stranger could use.
 *   restricted  Contains a live secret: an API key, a password, a full card
 *               number. Never leaves the house, regardless of rules.
 *
 * Deterministic rules first, and for almost everything, only. Classifying
 * 17,000 messages with a model would cost more than every other operation
 * Harbor performs combined, and would be worse: a regex that finds an AWS key
 * prefix is more reliable than a model asked whether text "looks sensitive".
 *
 * A model tier exists for the ambiguous remainder and is off by default. That
 * ordering is the routing ladder applied to the classifier itself.
 */

export type Sensitivity = "normal" | "sensitive" | "restricted";

export const SENSITIVITY_ORDER: Readonly<Record<Sensitivity, number>> = {
  normal: 0,
  sensitive: 1,
  restricted: 2,
};

export function highest(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b] ? a : b;
}

/** Bump to reclassify everything. Independent of chunking and entities. */
export const CLASSIFIER_VERSION = 1;

interface Signal {
  readonly id: string;
  readonly level: Sensitivity;
  readonly pattern: RegExp;
  readonly why: string;
}

/**
 * Live-secret patterns.
 *
 * These are the ones where a false negative is unrecoverable: once a key has
 * been sent to a third party, no policy change takes it back. They are written
 * to over-trigger rather than under-trigger.
 */
const SECRET_SIGNALS: readonly Signal[] = [
  {
    id: "aws_key",
    level: "restricted",
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
    why: "AWS access key id",
  },
  {
    id: "private_key",
    level: "restricted",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    why: "private key block",
  },
  {
    id: "bearer_token",
    level: "restricted",
    pattern: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    why: "API token",
  },
  {
    id: "password_line",
    level: "restricted",
    pattern: /\b(password|passwd|passphrase)\s*[:=]\s*\S{6,}/i,
    why: "password in plain text",
  },
  {
    id: "card_number",
    level: "restricted",
    pattern: /\b(?:\d[ -]?){13,16}\b/,
    why: "possible card number",
  },
];

const SENSITIVE_SIGNALS: readonly Signal[] = [
  {
    id: "ssn",
    level: "sensitive",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    why: "national id number",
  },
  {
    id: "account_number",
    level: "sensitive",
    pattern: /\b(account|acct|routing)\s*(number|no\.?|#)?\s*[:#]?\s*\*{0,4}\d{4,}/i,
    why: "account number",
  },
  {
    id: "medical",
    level: "sensitive",
    pattern:
      /\b(diagnosis|prescription|lab results?|biopsy|mri|referral|medical record|patient portal|prior authorization)\b/i,
    why: "medical language",
  },
  {
    id: "legal",
    level: "sensitive",
    pattern:
      /\b(attorney[- ]client|privileged and confidential|settlement agreement|subpoena|litigation hold|retainer agreement)\b/i,
    why: "legal language",
  },
  {
    id: "financial",
    level: "sensitive",
    pattern:
      /\b(w-?2|1099|tax return|mortgage|loan application|brokerage|401\(?k\)?|wire transfer|beneficiary)\b/i,
    why: "financial language",
  },
  {
    id: "credentials",
    level: "sensitive",
    pattern: /\b(two[- ]factor|verification code|one[- ]time (code|passcode)|reset your password)\b/i,
    why: "authentication material",
  },
];

/** Senders whose entire correspondence is treated as sensitive by default. */
const SENSITIVE_SENDER = /@(.*\.)?(bank|chase|wellsfargo|fidelity|vanguard|schwab|irs|hrblock|turbotax|kaiser|aetna|cigna|unitedhealth|quest|labcorp|mychart)[a-z.]*\b/i;

export interface Classification {
  readonly sensitivity: Sensitivity;
  /** Why, in the user's terms. Shown by `harbor dev classify --explain`. */
  readonly reasons: readonly string[];
  /** True when deterministic rules were confident enough to skip a model. */
  readonly deterministic: boolean;
}

export interface ClassifyInput {
  readonly title: string | null;
  readonly body: string | null;
  readonly author: string | null;
  readonly kind: string;
}

/**
 * Deterministic pass.
 *
 * Runs against title and body. A card-number pattern is checked last and only
 * when other numeric context supports it, because a bare run of digits is far
 * more often an order number than a card.
 */
export function classify(input: ClassifyInput): Classification {
  const haystack = `${input.title ?? ""}\n${input.body ?? ""}`;
  const reasons: string[] = [];
  let level: Sensitivity = "normal";

  for (const signal of SECRET_SIGNALS) {
    if (signal.id === "card_number") {
      continue;
    }

    if (signal.pattern.test(haystack)) {
      level = highest(level, signal.level);
      reasons.push(signal.why);
    }
  }

  for (const signal of SENSITIVE_SIGNALS) {
    if (signal.pattern.test(haystack)) {
      level = highest(level, signal.level);
      reasons.push(signal.why);
    }
  }

  if (input.author !== null && SENSITIVE_SENDER.test(input.author)) {
    level = highest(level, "sensitive");
    reasons.push("sender is a financial or medical institution");
  }

  // Card numbers only count alongside payment language. On its own, a run of
  // digits is an order number, a tracking code, or a phone list.
  const cardSignal = SECRET_SIGNALS.find((signal) => signal.id === "card_number");

  if (
    cardSignal !== undefined &&
    cardSignal.pattern.test(haystack) &&
    /\b(card|visa|mastercard|amex|cvv|expiry|exp\.?\s*date|billing)\b/i.test(haystack) &&
    luhnSomewhere(haystack)
  ) {
    level = highest(level, "restricted");
    reasons.push("card number");
  }

  return {
    sensitivity: level,
    reasons,
    // Anything that matched is confident. Anything that matched nothing is
    // confidently normal, which is the common case and the whole saving.
    deterministic: true,
  };
}

/** A digit run that passes Luhn is a card number; one that does not is an id. */
function luhnSomewhere(text: string): boolean {
  for (const candidate of text.match(/(?:\d[ -]?){13,19}/g) ?? []) {
    const digits = candidate.replace(/\D/g, "");

    if (digits.length < 13 || digits.length > 19) {
      continue;
    }

    let sum = 0;
    let alternate = false;

    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let value = Number.parseInt(digits[index] ?? "0", 10);

      if (alternate) {
        value *= 2;
        if (value > 9) {
          value -= 9;
        }
      }

      sum += value;
      alternate = !alternate;
    }

    if (sum % 10 === 0) {
      return true;
    }
  }

  return false;
}
