/**
 * People named in text.
 *
 * The gap this closes is the one that makes the whole thing feel like separate
 * systems rather than one picture. Harbor knew who was *on* a message -- the
 * sender, the recipients, the chat participants -- and knew nothing about who a
 * message was *about*. So "going with Luther and Gute, need a fourth for
 * pickleball" contributed two people to the store's understanding of that
 * weekend: the two in the header. Luther, who was actually going, was a word.
 *
 * That is why a trip could have a conversation about arrival times sitting in
 * the same store, with the same person, three hours before the event, and never
 * find it. There was no path from the name in the sentence to the thread with
 * the man it names.
 *
 * The risk is obvious and is the reason this is a separate file with its own
 * rules: first names are not unique and many of them are ordinary words. A
 * store containing a Mark, a May and a Bill would relocate half the mailbox if
 * every occurrence counted. So a name form is only usable when it points at
 * exactly one person, is not an English word, and is long enough to be a name
 * rather than an abbreviation. Everything ambiguous is dropped rather than
 * guessed at, because a wrong person is worse than no person: it is the one
 * error that makes somebody distrust the whole surface.
 */
import type { DB } from "../kernel/db.js";

/**
 * First names that are also ordinary words, and would fire constantly.
 *
 * Not exhaustive and does not need to be. It covers the ones that appear in
 * running prose often enough to matter; anything rarer is caught by the
 * uniqueness rule or does no harm when it slips through once.
 */
const ALSO_WORDS = new Set([
  "may", "mark", "bill", "will", "grace", "hope", "faith", "rose", "art",
  "sunny", "summer", "autumn", "april", "june", "july", "august", "dawn",
  "wren", "jay", "drew", "chase", "hunter", "carter", "parker", "sonny",
  "frank", "rich", "randy", "curt", "brook", "brooke", "heather", "holly",
  "ivy", "jasmine", "lily", "daisy", "pearl", "ruby", "amber", "crystal",
  "angel", "christian", "prince", "king", "earl", "duke", "guy", "man",
  "miles", "wade", "ford", "reed", "rusty", "sky", "star", "storm", "gene",
  "hall", "young", "long", "short", "white", "black", "green", "brown",
  "gray", "grey", "moore", "price", "field", "banks", "rivers", "wood",
]);

export interface Mention {
  readonly entityId: string;
  readonly displayName: string;
  /** What was written. */
  readonly matched: string;
  /**
   * How sure. A full name is not in doubt; a lone surname mostly is not; a
   * lone first name is a guess even when it is unique, because the store only
   * knows the people it has met.
   */
  readonly confidence: number;
}

interface Form {
  readonly entityId: string;
  readonly displayName: string;
  readonly confidence: number;
}

/**
 * Every usable way to write the name of somebody this store knows.
 *
 * Built once per pass. The whole index is a few thousand entries at most, which
 * is small enough to hold and scan against, and the alternative -- a query per
 * candidate name per node -- is the thing that made the old graph slow.
 */
export class NameIndex {
  private readonly forms = new Map<string, Form>();
  private readonly pattern: RegExp | null;

  constructor(db: DB) {
    const people = db
      .prepare(
        `SELECT id, display_name FROM entities
         WHERE kind = 'person' AND merged_into IS NULL`,
      )
      .all() as { id: string; display_name: string }[];

    const aliases = db
      .prepare(
        `SELECT a.entity_id, a.alias FROM entity_aliases a
         JOIN entities e ON e.id = a.entity_id
         WHERE e.kind = 'person' AND e.merged_into IS NULL`,
      )
      .all() as { entity_id: string; alias: string }[];

    // Collected first, resolved second. A form claimed by two people is
    // ambiguous and unusable, and that cannot be known until every person has
    // been seen.
    const claims = new Map<string, { entityId: string; displayName: string; confidence: number }[]>();

    const claim = (form: string, entityId: string, displayName: string, confidence: number): void => {
      const normalized = form.trim().toLowerCase();

      // A handle is not a name. Anything with a digit or an @ in it came from
      // an address and is already matched properly by the entity layer.
      if (
        normalized.length < 3 ||
        /[\d@+]/.test(normalized) ||
        ALSO_WORDS.has(normalized)
      ) {
        return;
      }

      const held = claims.get(normalized);

      if (held === undefined) {
        claims.set(normalized, [{ entityId, displayName, confidence }]);
      } else {
        held.push({ entityId, displayName, confidence });
      }
    };

    for (const person of people) {
      const name = person.display_name.trim();

      if (name.length === 0) {
        continue;
      }

      claim(name, person.id, name, 0.85);

      const parts = name.split(/\s+/).filter((part) => /^[\p{L}'-]+$/u.test(part));

      if (parts.length >= 2) {
        const last = parts[parts.length - 1] ?? "";
        const first = parts[0] ?? "";

        // A surname is a strong handle on its own -- "texted Luther" -- and is
        // far less likely to collide than a given name.
        if (last.length >= 4) {
          claim(last, person.id, name, 0.7);
        }

        if (first.length >= 3) {
          claim(first, person.id, name, 0.55);
        }
      }
    }

    for (const alias of aliases) {
      const person = people.find((candidate) => candidate.id === alias.entity_id);

      if (person !== undefined) {
        claim(alias.alias, person.id, person.display_name, 0.75);
      }
    }

    for (const [form, held] of claims) {
      const first = held[0];

      if (first === undefined) {
        continue;
      }

      // Two people answering to one form makes it useless. Keeping the more
      // frequent one would be a coin toss dressed as a decision.
      if (held.some((other) => other.entityId !== first.entityId)) {
        continue;
      }

      this.forms.set(form, first);
    }

    this.pattern = this.build();
  }

  /**
   * One alternation over every known form, longest first.
   *
   * Longest first so "Jake Luther" wins over "Luther", which then reports the
   * full-name confidence rather than the surname's.
   */
  private build(): RegExp | null {
    const forms = [...this.forms.keys()].sort((a, b) => b.length - a.length);

    if (forms.length === 0) {
      return null;
    }

    const escaped = forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    return new RegExp(`(?<![\\p{L}'-])(${escaped.join("|")})(?![\\p{L}'-])`, "giu");
  }

  get size(): number {
    return this.forms.size;
  }

  /** Everybody a piece of text names. */
  mentions(text: string): readonly Mention[] {
    if (this.pattern === null || text.length === 0) {
      return [];
    }

    const found = new Map<string, Mention>();

    // Reset, because the pattern is global and shared across calls.
    this.pattern.lastIndex = 0;

    for (const match of text.matchAll(this.pattern)) {
      const form = this.forms.get((match[1] ?? "").toLowerCase());

      if (form === undefined) {
        continue;
      }

      const held = found.get(form.entityId);

      if (held === undefined || held.confidence < form.confidence) {
        found.set(form.entityId, {
          entityId: form.entityId,
          displayName: form.displayName,
          matched: match[1] ?? "",
          confidence: form.confidence,
        });
      }
    }

    return [...found.values()];
  }
}
