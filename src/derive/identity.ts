import { looksLikePhone, normalizePhone } from "./nicknames.js";
/**
 * Parsing and normalizing the strings sources hand us as people.
 *
 * This is unglamorous and it is where entity resolution actually succeeds or
 * fails. `Dana Whitfield <dana@northlightco.com>`, `"Whitfield, Dana"
 * <DANA@NorthlightCo.com>`, `=?UTF-8?Q?Jos=C3=A9?= <jose@x.com>`, and a bare
 * `dana@northlightco.com` all have to land on one identifier, and no amount of
 * clever clustering downstream recovers from getting this layer wrong.
 */

export interface ParsedAddress {
  /** Lowercased, normalized address. Null when the string had no address at all. */
  readonly email: string | null;
  /** E.164, when the handle was a phone number. iMessage handles usually are. */
  readonly phone: string | null;
  /** Display name as written, with encoding and quoting removed. */
  readonly name: string | null;
  /** The original string, kept so `value` can show what the source actually said. */
  readonly raw: string;
}

/**
 * Decodes RFC 2047 encoded words, which Gmail returns for any non-ASCII
 * display name. Without this, a meaningful fraction of contacts are stored as
 * `=?UTF-8?B?...?=` and never match anything.
 */
export function decodeEncodedWords(input: string): string {
  return input.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, _charset: string, encoding: string, payload: string) => {
      try {
        if (encoding.toUpperCase() === "B") {
          return Buffer.from(payload, "base64").toString("utf8");
        }

        // Q encoding: underscores are spaces, =XX is a hex byte.
        const bytes: number[] = [];

        for (let index = 0; index < payload.length; index += 1) {
          const char = payload[index];

          if (char === "_") {
            bytes.push(0x20);
          } else if (char === "=" && index + 2 < payload.length) {
            bytes.push(Number.parseInt(payload.slice(index + 1, index + 3), 16));
            index += 2;
          } else {
            bytes.push(payload.charCodeAt(index));
          }
        }

        return Buffer.from(bytes).toString("utf8");
      } catch {
        return match;
      }
    },
  );
}

/**
 * Canonical form of an address.
 *
 * Plus-addressing is stripped everywhere: `you+receipts@x.com` is you. Dots are
 * stripped for Google domains only, where they are provably insignificant.
 * Doing that universally would merge genuinely different people on providers
 * that treat dots as meaningful.
 */
export function normalizeEmail(address: string): string {
  const trimmed = address.trim().toLowerCase().replace(/^<|>$/g, "");
  const at = trimmed.lastIndexOf("@");

  if (at <= 0) {
    return trimmed;
  }

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = local.indexOf("+");
  if (plus > 0) {
    local = local.slice(0, plus);
  }

  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    return `${local}@gmail.com`;
  }

  return `${local}@${domain}`;
}

/** Canonical form of a display name, for grouping only. Never used to merge. */
export function normalizeName(name: string): string {
  let cleaned = decodeEncodedWords(name)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // "Whitfield, Dana" is the same human as "Dana Whitfield".
  const comma = cleaned.indexOf(",");
  if (comma > 0 && cleaned.indexOf("@") === -1 && cleaned.split(",").length === 2) {
    const [last, first] = cleaned.split(",");
    cleaned = `${(first ?? "").trim()} ${(last ?? "").trim()}`.trim();
  }

  return cleaned.toLowerCase();
}

const ADDRESS_PATTERN = /<([^>]+)>\s*$/;
const BARE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parses one address string.
 *
 * Calendar attendees arrive as plain addresses; mail headers arrive as
 * `Name <address>` in several dialects. Both land here.
 */
export function parseAddress(input: string): ParsedAddress {
  const raw = input.trim();

  if (raw.length === 0) {
    return { email: null, phone: null, name: null, raw };
  }

  // iMessage hands over +15551234567, which is an identity and is not an
  // address. Without this it fell through to the name branch, did not look like
  // a name either, and was dropped, so every text thread built its own entity.
  if (looksLikePhone(raw)) {
    return { email: null, phone: normalizePhone(raw), name: null, raw };
  }

  const decoded = decodeEncodedWords(raw);
  const angled = ADDRESS_PATTERN.exec(decoded);

  if (angled !== null) {
    const address = angled[1] ?? "";
    const name = decoded.slice(0, angled.index).trim().replace(/^["']|["']$/g, "");

    return {
      email: BARE_EMAIL.test(address.trim()) ? normalizeEmail(address) : null,
      phone: looksLikePhone(address) ? normalizePhone(address) : null,
      name: name.length === 0 ? null : name,
      raw,
    };
  }

  const bare = decoded.trim();

  if (BARE_EMAIL.test(bare)) {
    return { email: normalizeEmail(bare), phone: null, name: null, raw };
  }

  // A name with no address. Useful as a label, never as an identity anchor.
  return { email: null, phone: null, name: bare.length === 0 ? null : bare, raw };
}

/** Splits a header value that may hold several comma-separated addresses. */
export function parseAddressList(values: readonly string[]): readonly ParsedAddress[] {
  const parsed: ParsedAddress[] = [];

  for (const value of values) {
    for (const piece of splitOnCommasOutsideQuotes(value)) {
      const address = parseAddress(piece);
      if (address.email !== null || address.name !== null) {
        parsed.push(address);
      }
    }
  }

  return parsed;
}

/** `"Whitfield, Dana" <d@x.com>, bob@y.com` is two addresses, not three. */
function splitOnCommasOutsideQuotes(value: string): readonly string[] {
  const pieces: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "<") {
      inAngle = true;
    } else if (char === ">") {
      inAngle = false;
    }

    if (char === "," && !inQuotes && !inAngle) {
      pieces.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    pieces.push(current);
  }

  return pieces;
}

/**
 * A display name worth keeping.
 *
 * Rejects the ones that are really addresses, automation labels, or noise, so
 * an entity does not end up called "noreply" or "no-reply@shop.example.com".
 */
export function isUsefulName(name: string): boolean {
  // A phone number is an identity, not a name.
  //
  // Letting one through created a second entity for every iMessage handle: one
  // anchored on the phone identifier holding the actual messages, and a
  // shadow anchored on a name identifier holding nothing. On a real store the
  // shadow had been "seen" seventy thousand times.
  if (looksLikePhone(name)) {
    return false;
  }

  const cleaned = name.trim();

  if (cleaned.length < 2 || cleaned.length > 80) {
    return false;
  }

  if (BARE_EMAIL.test(cleaned)) {
    return false;
  }

  if (/^(no-?reply|do-?not-?reply|postmaster|mailer-daemon|notifications?|info|support|admin|team)$/i.test(cleaned)) {
    return false;
  }

  return true;
}

/** Rough guess at whether an address belongs to a person or a system. */
export function looksAutomated(email: string): boolean {
  const local = email.slice(0, Math.max(0, email.lastIndexOf("@")));

  return /^(no-?reply|do-?not-?reply|donotreply|bounce|mailer|postmaster|notifications?|alerts?|updates?|news|newsletter|noreply)/i.test(
    local,
  );
}
