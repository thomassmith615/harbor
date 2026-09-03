/**
 * Learning things about people who are not the user.
 *
 * `facts.ts` is restricted, in its own prompt, to the person labelled Me:
 * *never about anyone else in the conversation*. That restriction was right
 * when facts were the only place a standing claim could live, because a
 * free-text sentence about a third party has nowhere to attach and no way to be
 * retrieved except by reading it. It is the wrong restriction now that entities
 * can hold attributes, because the same claim attached to a person is
 * retrievable, checkable, and correctable one row at a time.
 *
 * Two sources, and they are not equally trustworthy, which is why `origin` is a
 * column rather than a constant.
 *
 * **Structured.** An address book entry, a vCard, a calendar attendee. Somebody
 * typed it deliberately into a system whose job is to hold it. This is the
 * strongest evidence available and it needs no model.
 *
 * **Stated.** A number in a signature, an address in a confirmation, an
 * employer in a introduction. Read by rule, with the words it came from stored
 * alongside, and only from patterns specific enough that a false positive is
 * rare rather than merely unlikely.
 *
 * There is deliberately no third source. Nothing here infers an attribute from
 * behaviour: that somebody emails from a company domain does not mean they work
 * there, that two people appear together often does not make them partners, and
 * a system that guesses those and states them as facts is unsettling when it is
 * right and damaging when it is wrong. The gap that leaves is real and is the
 * correct gap to leave.
 */
import { recordAttribute } from "../store/attributes.js";
import { normalizePhone } from "./nicknames.js";
import type { DB } from "../kernel/db.js";

export const ATTRIBUTE_VERSION = 1;

/**
 * A phone number in running text, in the shapes people actually write.
 *
 * Anchored on a lead-in word rather than matched bare. A bare number pattern
 * matches order numbers, tracking numbers, dates written with dashes, and the
 * bottom of every marketing email, and the cost of a wrong phone number
 * attached to a person is that Harbor confidently offers it when asked how to
 * reach them.
 */
const PHONE_STATED =
  /(?:call|text|reach|cell|mobile|number|phone)\b(?:\s+(?:me|him|her|us|them|my|his|is|on|at|the|new))*\s*:?\s*(\+?\d[\d\s().-]{8,17}\d)/gi;

/**
 * An employer, stated in the first person.
 *
 * Only ever read from the speaker's own words about themselves, and attributed
 * to that speaker. "I work at Vanguard" is evidence about the person who wrote
 * it; "she works at Vanguard" is a claim about somebody who is not identified
 * well enough to attach it to, and guessing which participant "she" refers to
 * is precisely the inference this file refuses to make.
 */
const EMPLOYER_STATED = /\bI\s+(?:work|am|'m)\s+(?:at|for|with)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/g;

const ROLE_STATED =
  /\bI(?:'m| am)\s+(?:an?\s+)?((?:senior|lead|principal|staff|junior)?\s*[a-z]+(?:\s+[a-z]+)?\s*(?:engineer|developer|designer|manager|director|analyst|nurse|teacher|lawyer|accountant|consultant))\b/gi;

export interface AttributeReport {
  readonly nodesRead: number;
  readonly written: number;
  readonly byKind: Readonly<Record<string, number>>;
}

interface Candidate {
  readonly kind: string;
  readonly value: string;
  readonly quote: string;
  readonly confidence: number;
}

/**
 * What a piece of text states about whoever wrote it.
 *
 * First person only, and that is the whole safety argument. Attributing a
 * stated attribute to the author is a claim the text supports; attributing it
 * to a participant named nearby is a guess dressed as one.
 */
export function statedAttributes(text: string): readonly Candidate[] {
  const found: Candidate[] = [];

  for (const match of text.matchAll(PHONE_STATED)) {
    const normalized = normalizePhone(match[1] ?? "");

    if (normalized === null) {
      continue;
    }

    found.push({
      kind: "phone",
      value: match[1]?.trim() ?? "",
      quote: match[0].trim(),
      confidence: 0.7,
    });
  }

  for (const match of text.matchAll(EMPLOYER_STATED)) {
    const employer = (match[1] ?? "").trim();

    // A single capitalised word after "I work at" is as often the start of a
    // sentence as a company. Two tokens, or one long enough to be a name.
    if (employer.split(/\s+/).length >= 2 || employer.length >= 6) {
      found.push({ kind: "employer", value: employer, quote: match[0].trim(), confidence: 0.65 });
    }
  }

  for (const match of text.matchAll(ROLE_STATED)) {
    found.push({
      kind: "role",
      value: (match[1] ?? "").trim().toLowerCase(),
      quote: match[0].trim(),
      confidence: 0.6,
    });
  }

  return found;
}

/**
 * Reads stated attributes out of items whose author is known.
 *
 * Bounded to items with a resolved author, because an attribute with nobody to
 * attach it to is not worth extracting, and because the author is the only
 * participant the first-person rule above can safely mean.
 */
export function extractAttributes(
  db: DB,
  options: { readonly limit?: number; readonly since?: number } = {},
): AttributeReport {
  const rows = db
    .prepare(
      `SELECT id, body, title, occurred_at, direction
       FROM items
       WHERE deleted_at IS NULL
         AND direction = 'inbound'
         AND body IS NOT NULL
         AND occurred_at >= @since
       ORDER BY occurred_at DESC
       LIMIT @limit`,
    )
    .all({ limit: options.limit ?? 2_000, since: options.since ?? 0 }) as {
    id: string;
    body: string | null;
    title: string | null;
    occurred_at: number;
  }[];

  const byKind: Record<string, number> = {};
  let written = 0;

  for (const row of rows) {
    const text = `${row.title ?? ""}\n${row.body ?? ""}`;
    const candidates = statedAttributes(text);

    if (candidates.length === 0) {
      continue;
    }

    // The author, and only the author. `entitiesOfNode` returns everybody on
    // the item, so the role matters: a first-person claim in a message belongs
    // to whoever sent it, not to everybody who received it.
    const author = authorOf(db, row.id);

    if (author === null) {
      continue;
    }

    for (const candidate of candidates) {
      recordAttribute(db, {
        entityId: author,
        kind: candidate.kind,
        value: candidate.value,
        confidence: candidate.confidence,
        origin: "stated",
        sourceKind: "item",
        sourceId: row.id,
        quote: candidate.quote,
        observedAt: row.occurred_at,
      });

      byKind[candidate.kind] = (byKind[candidate.kind] ?? 0) + 1;
      written += 1;
    }
  }

  return { nodesRead: rows.length, written, byKind };
}

function authorOf(db: DB, itemId: string): string | null {
  const row = db
    .prepare(
      `SELECT entity_id AS id FROM item_entities
       WHERE item_id = ? AND role = 'author' LIMIT 1`,
    )
    .get(itemId) as { id: string } | undefined;

  return row?.id ?? null;
}

/**
 * Promotes phone identifiers to attributes.
 *
 * A number Harbor already knows as an identifier is a number it can answer with,
 * and until now the two lived in different tables for no reason a reader would
 * guess: `identifiers` is how a node reaches a person, `entity_attributes` is
 * what is known about them, and a phone number is honestly both.
 */
export function promoteIdentifiers(db: DB): number {
  const rows = db
    .prepare(
      `SELECT entity_id, value, normalized, confidence, last_seen
       FROM identifiers WHERE kind IN ('phone', 'email')`,
    )
    .all() as {
    entity_id: string;
    value: string;
    normalized: string;
    confidence: number;
    last_seen: number | null;
  }[];

  let written = 0;

  for (const row of rows) {
    recordAttribute(db, {
      entityId: row.entity_id,
      kind: row.normalized.startsWith("+") || /^\d/.test(row.normalized) ? "phone" : "email",
      value: row.value,
      normalized: row.normalized,
      confidence: row.confidence,
      origin: "source",
      observedAt: row.last_seen ?? Date.now(),
    });

    written += 1;
  }

  return written;
}
