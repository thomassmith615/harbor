/**
 * Redaction.
 *
 * Applied to items whose rule says `redacted`. The goal is not anonymity, which
 * is unachievable on free text; it is removing the parts a third party could
 * act on. A redacted bank email should still say a bank emailed you about a
 * statement, and should not carry the account number.
 *
 * Placeholders are typed and stable, so a model can still reason about the
 * shape of what it cannot see: "[card] on [date]" is a usable fact.
 */

export interface Redaction {
  readonly kind: string;
  readonly count: number;
}

export interface Redacted {
  readonly text: string;
  readonly redactions: readonly Redaction[];
  readonly total: number;
}

interface Rule {
  readonly kind: string;
  readonly pattern: RegExp;
  readonly placeholder: string;
}

const RULES: readonly Rule[] = [
  { kind: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, placeholder: "[private-key]" },
  { kind: "api_token", pattern: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, placeholder: "[api-token]" },
  { kind: "password", pattern: /\b(password|passwd|passphrase)(\s*[:=]\s*)\S+/gi, placeholder: "$1$2[password]" },
  { kind: "national_id", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, placeholder: "[national-id]" },
  { kind: "card", pattern: /\b(?:\d[ -]?){13,19}\b/g, placeholder: "[card-or-account]" },
  { kind: "account", pattern: /\b(account|acct|routing)(\s*(?:number|no\.?|#)?\s*[:#]?\s*)\*{0,4}\d{4,}/gi, placeholder: "$1$2[account]" },
  { kind: "phone", pattern: /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, placeholder: "[phone]" },
  { kind: "url_secret", pattern: /([?&](token|key|secret|password|auth|sig)=)[^&\s]+/gi, placeholder: "$1[redacted]" },
];

export function redact(text: string): Redacted {
  let output = text;
  const redactions: Redaction[] = [];

  for (const rule of RULES) {
    const matches = output.match(rule.pattern);

    if (matches === null || matches.length === 0) {
      continue;
    }

    output = output.replace(rule.pattern, rule.placeholder);
    redactions.push({ kind: rule.kind, count: matches.length });
  }

  return {
    text: output,
    redactions,
    total: redactions.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/** Bytes that would leave the machine, for the audit log. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
