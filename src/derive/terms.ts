/**
 * Distinctive words, and how rare they are.
 *
 * This is the piece the relationship layer was missing, and the reason it could
 * not do the one thing Harbor exists for.
 *
 * Every linker Harbor shipped with keyed on hard identity: the same source
 * thread, the same confirmation code, the same person. Between a personal
 * calendar and a text thread there is none of that. A calendar entry you typed
 * yourself has no attendees, so it has no entities, so no generator ever
 * produced it as a candidate and `arranges` was unreachable code. What a text
 * about Saturday dinner and a calendar entry for Saturday dinner actually share
 * is *subject matter*, and nothing here could see it.
 *
 * The obvious fix is embeddings, and it is the wrong one. A cosine score is not
 * evidence anybody can check, and the deterministic-first stance is worth more
 * than the recall. Rare-term overlap gets most of the way there and produces an
 * evidence line a person can read: "both mention Brennans". Deterministic does
 * not have to mean identity-only, which is the assumption the code had drifted
 * into.
 *
 * Rarity is measured against the user's own store rather than against English.
 * "Wegmans" is a common word in a Philadelphia mailbox and a distinctive one in
 * most others, and the store is the only corpus whose statistics are actually
 * relevant.
 */
import type { DB } from "../kernel/db.js";

/**
 * Words too common to carry meaning, in any store.
 *
 * Kept deliberately short. Corpus frequency does most of the work, and a long
 * hand-written list is a place for someone to quietly delete a word that
 * mattered. These are here because they clear the length filter and would
 * otherwise be measured on every pass for no reason.
 */
const STOPWORDS = new Set([
  "about", "after", "again", "against", "all", "also", "and", "any", "are", "because",
  "been", "before", "being", "below", "between", "both", "but", "can", "cannot", "could",
  "did", "does", "doing", "down", "during", "each", "few", "for", "from", "further",
  "had", "has", "have", "having", "her", "here", "hers", "herself", "him", "himself",
  "his", "how", "into", "its", "itself", "just", "let", "like", "make", "many", "may",
  "might", "more", "most", "much", "must", "myself", "not", "now", "off", "once", "only",
  "other", "our", "ours", "ourselves", "out", "over", "own", "same", "should", "some",
  "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "too", "under", "until", "very", "was",
  "way", "well", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "will", "with", "would", "you", "your", "yours", "yourself",
  "seems", "seem", "still", "back", "even", "ever", "every", "another", "around",
  "since", "though", "thing", "things", "something", "anything", "nothing",
  "really", "actually", "maybe", "probably", "already", "instead", "rather",
  "little", "long", "next", "last", "first", "right", "left", "over", "under",
  // Message furniture. Present in enormous volume and never the reason two
  // things are related.
  "thanks", "thank", "please", "sent", "sorry", "hey", "hello", "regards", "best",
  "email", "message", "reply", "call", "text", "know", "good", "great", "yeah", "okay",
  "sure", "think", "want", "need", "going", "get", "got", "see", "look", "time", "day",
  "today", "tomorrow", "tonight", "week", "weekend", "morning", "afternoon", "evening",
]);

/** Shorter than this and a word is not distinctive whatever its frequency. */
const MIN_LENGTH = 4;

/** How many terms are taken from one node. Enough for a title, not a novel. */
const MAX_TERMS = 24;

/**
 * How much of a node's text is scanned for terms.
 *
 * The distinguishing words of a conversation are near its start, and a long
 * transcript that mentions everything matches everything.
 */
const SCAN_LIMIT = 1_500;

/**
 * The words worth measuring, in the order they appear.
 *
 * Order matters because the cap truncates: a title's words come before a body's
 * in the text a node hands over, and a title is where the distinguishing words
 * usually are.
 */
/**
 * Links, which are not words.
 *
 * From a real run: `amazonaws` was being treated as one of the most
 * distinctive words in the store, because it is in the tracking-pixel URL at
 * the bottom of thousands of marketing emails, and any two of those "shared a
 * rare word". A hostname says something about a mail provider's infrastructure
 * and nothing about what the mail is concerned with.
 *
 * This does lose some real signal: a merchant sometimes appears only in a link.
 * That is the right trade. A merchant that matters is in the sender or the
 * subject too, and a false edge between two unrelated receipts is worse than a
 * missing one between two related ones.
 */
const LINKS = /\bhttps?:\/\/\S+|\b[\w.-]+\.(?:com|net|org|io|co|us|edu|gov|dev|app|link|email)\b/gi;

export function contentTerms(text: string): readonly string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  const scannable = text.slice(0, SCAN_LIMIT).toLowerCase().replace(LINKS, " ");

  for (const raw of scannable.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_LENGTH || STOPWORDS.has(raw)) {
      continue;
    }

    // A bare number is a date, a price, or a quantity, and matching on one
    // connects a receipt to every other receipt with the same total. Numbers
    // that matter are identifiers, and those are the reference index's job.
    if (!/\p{L}/u.test(raw)) {
      continue;
    }

    if (seen.has(raw)) {
      continue;
    }

    seen.add(raw);
    terms.push(raw);

    if (terms.length >= MAX_TERMS) {
      break;
    }
  }

  return terms;
}

/**
 * How many items and episodes contain a term.
 *
 * Bounded rather than exact. An exact count walks the whole posting list, and
 * the only question being asked is "is this term rare", so counting stops as
 * soon as the answer is no. On a quarter of a million items that is the
 * difference between a pass that finishes and one that does not.
 */
/**
 * The solo-word bar, as a function of the rarity ceiling.
 *
 * Deliberately unchanged after the "logan" incident, which is worth recording
 * because tightening this was the obvious fix and it was wrong. "Wildwood"
 * appears in nineteen things and is a good solo link; "logan" appeared in three
 * and was a bad one. Frequency cannot separate them, and a bar tight enough to
 * reject one rejects the other. What separates them is that one is a place and
 * the other is a person's name, which is a question about the word rather than
 * about how often it occurs.
 *
 * Pure and exported so the bar can be pinned by a test without building a
 * forty-thousand-document store.
 */
export function soloCeilingFor(rarityCeiling: number): number {
  return Math.max(3, Math.round(rarityCeiling / 6));
}

/**
 * The shortest word allowed to carry an edge by itself.
 *
 * A four-character fragment linked a laundry reminder to a restaurant
 * transaction twenty-five days apart, because a truncated reminder said "dece"
 * and so did something else. Short strings are rare for uninteresting reasons:
 * abbreviations, truncations, typos, and codes that mean nothing. Being rare is
 * the only test they pass, and it is the only test that was being applied.
 *
 * Solo evidence only. Two shared short words are still two words.
 */
export function longEnoughAlone(word: string): boolean {
  return word.length >= 6;
}

export class TermIndex {
  private readonly cache = new Map<string, number>();
  private names: Set<string> | null = null;
  private readonly ceiling: number;
  private readonly corpus: number;

  constructor(private readonly db: DB) {
    // Conversational messages are excluded from the corpus for the same reason
    // they are excluded from the graph: an episode stands for them. Counting
    // both meant an eighty-message thread that said "steak" once per message
    // counted as eighty-one documents containing "steak", and on a real store
    // that inflation is what made ordinary words look common and distinctive
    // words look ordinary.
    const items = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM items i
           JOIN streams s ON s.id = i.stream_id
           WHERE i.deleted_at IS NULL AND s.connector_id NOT IN ('imessage')`,
        )
        .get() as { n: number }
    ).n;
    const episodes = (db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number }).n;

    this.corpus = Math.max(1, items + episodes);

    // Half a percent, capped at 120.
    //
    // Two percent was the first guess and it was far too loose. On a real store
    // of 7,163 documents it made anything under 143 appearances "distinctive",
    // which is how `seems`, `native`, and `martin` ended up as evidence and how
    // 91% of the graph came from one weak linker. A word that appears in one
    // document in two hundred is unusual; one in fifty is just vocabulary.
    //
    // The floor of 5 is what makes a nearly empty store and the test fixtures
    // work at all, and it is the only part of this that is arbitrary.
    this.ceiling = Math.min(120, Math.max(5, Math.round(this.corpus * 0.005)));
  }

  get corpusSize(): number {
    return this.corpus;
  }

  get rarityCeiling(): number {
    return this.ceiling;
  }

  /**
   * Whether a word is somebody's name, according to your own address book.
   *
   * The discriminator that frequency could not supply. "Wildwood" appears in
   * nineteen things and links a shore conversation to a shore calendar entry
   * correctly; "logan" appeared in three and joined a flight to Boston Logan, a
   * group chat about a person called Logan, and a cold text from an estate
   * agent called Logan. Both are rare. Only one is a name.
   *
   * A name is the worst possible solo evidence precisely because it is a good
   * identifier: it points at a person, several people share it, and the same
   * letters turn up in airports, streets and companies. So a name may still be
   * one of two shared words, and may never be the only one.
   *
   * Read from the entities this store already resolved rather than from a list
   * of common names, because the question is not "is this a name somewhere" but
   * "is this a name here". Built once, on first use: most passes never ask.
   */
  isPersonName(word: string): boolean {
    if (this.names === null) {
      this.names = new Set<string>();

      const rows = this.db
        .prepare(
          `SELECT e.display_name AS name FROM entities e
           WHERE e.kind = 'person' AND e.merged_into IS NULL
           UNION
           SELECT i.value AS name FROM identifiers i WHERE i.kind = 'name'`,
        )
        .all() as { name: string | null }[];

      for (const row of rows) {
        // Each part separately: "Isabella Forté" makes both "isabella" and
        // "forté" names, and a first name on its own is exactly the ambiguous
        // case this exists for.
        for (const part of (row.name ?? "").split(/[^\p{L}]+/u)) {
          if (part.length >= 3) {
            this.names.add(part.toLowerCase());
          }
        }
      }
    }

    return this.names.has(word.toLowerCase());
  }

  /** Document frequency, counted no further than it needs to be. */
  frequency(term: string): number {
    const cached = this.cache.get(term);

    if (cached !== undefined) {
      return cached;
    }

    const limit = this.ceiling + 1;
    const match = `"${term.replace(/"/g, "")}"`;

    const items = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT f.item_id FROM items_fts f
             JOIN items i ON i.id = f.item_id
             JOIN streams s ON s.id = i.stream_id
             WHERE items_fts MATCH ? AND i.deleted_at IS NULL
               AND s.connector_id NOT IN ('imessage')
             LIMIT ?
           )`,
        )
        .get(match, limit) as { n: number }
    ).n;

    let total = items;

    if (total <= this.ceiling) {
      total += (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH ? LIMIT ?
             )`,
          )
          .get(match, limit - total) as { n: number }
      ).n;
    }

    this.cache.set(term, total);

    return total;
  }

  /**
   * Rare enough that sharing it alone is evidence, with no second word needed.
   *
   * This used to be a hardcoded 3 while the ceiling above scaled to 500, so on
   * a real store anything between 4 and 500 appearances required a partner
   * word. "Wildwood" appeared in 19 things out of 40,000 and was rejected,
   * which is precisely the shore-town question Harbor is supposed to answer.
   *
   * A twentieth of the ceiling, floored at 3 so a small store still works.
   */
  get soloCeiling(): number {
    return soloCeilingFor(this.ceiling);
  }

  /** Rare enough that two things sharing it are probably about one thing. */
  isDistinctive(term: string): boolean {
    const frequency = this.frequency(term);

    return frequency > 0 && frequency <= this.ceiling;
  }

  /** Distinctive terms only, cheapest filter first. */
  distinctive(text: string): readonly string[] {
    return contentTerms(text).filter((term) => this.isDistinctive(term));
  }

  /**
   * How surprising a shared term is.
   *
   * Plain inverse document frequency. Used to weigh a match rather than to rank
   * anything, so the absolute scale does not matter; what matters is that a
   * word in three items counts for much more than a word in three hundred.
   */
  weight(term: string): number {
    return Math.log(this.corpus / Math.max(1, this.frequency(term)));
  }
}
