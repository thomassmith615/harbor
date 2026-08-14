/**
 * Mail that is not something that happened to you.
 *
 * Two kinds, both deterministic, both computed once per pass.
 *
 * **Templates.** A sender and subject shape that recurs. "You paid Christopher
 * Hand $10.55" repeated weekly is one arrangement, not twenty events, and
 * chaining the instances together produced the top-ranked situation on the
 * first real run: every statement in it true, the whole worthless.
 *
 * **Broadcasts.** Mail from an address you have never written to. Recruiter
 * blasts, ticket promotions, document-signing notices, payment receipts. These
 * defeat template detection because their subjects genuinely differ: Venmo
 * sends "paid you $60.00", "wants to be friends", and "requests $614.00", so no
 * single shape recurs five times, and they linked to each other anyway on the
 * strength of a shared surname.
 *
 * The distinction that matters: a broadcast is excluded from *content* linking
 * only. `shares_reference` still works, because a confirmation code in a
 * booking email is real evidence no matter who sent it, and `tracks` still
 * works, because a reminder covering an appointment email is exactly the
 * cross-source connection Harbor is for. What a broadcast may not do is be
 * joined to something else because the two happen to share a word. That linker
 * needs the item to be about something, and a marketing email is about nothing.
 *
 * Nothing here is hidden or deleted. Broadcasts stay searchable, still feed the
 * purchase projection, and still answer questions. They stop being nodes in a
 * graph whose only job is noticing that two different things are one thing.
 */
import { CONVERSATIONAL_CONNECTORS } from "../store/nodes.js";
import type { DB } from "../kernel/db.js";

/**
 * How many times a subject shape must recur before it is a template.
 *
 * Five. On a real mailbox that catches payment notifications, statement
 * availability, and shipping updates, and leaves an ordinary exchange alone.
 */
const RECURRENCE_THRESHOLD = 5;

/**
 * How much one-way mail a sender must send before silence means broadcast.
 *
 * Three. Below that, "you never replied" is more likely to mean you had nothing
 * to say than that nobody was talking to you.
 */
const BROADCAST_THRESHOLD = 3;

/** Senders that announce themselves. Cheap, and catches the first message. */
const NO_REPLY =
  /^(no-?reply|do-?not-?reply|notifications?|notify|mailer|bounce|automated|alerts?|inmail-hit-reply|updates?|news|newsletter|info|support|billing|receipts?|orders?)[+.-]?/i;

/**
 * A subject with its variable parts removed.
 *
 * Numbers, money, and dates are exactly what differs between two instances of
 * one template, so they are what has to go. "You paid Christopher Hand $10.55"
 * and "$12.00" collapse to one shape; "Dinner Saturday?" collapses to itself.
 */
export function titleShape(title: string | null): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[$£€]?\d[\d,.:/-]*/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function localPart(author: string): string {
  const match = /<?([^<>@\s]+)@/.exec(author);

  return match?.[1] ?? "";
}

export interface NoiseReport {
  readonly templateShapes: number;
  readonly templateItems: number;
  readonly broadcastSenders: number;
  readonly broadcastItems: number;
  readonly total: number;
}

export class NoiseIndex {
  private readonly templates = new Set<string>();
  private readonly broadcasts = new Set<string>();
  private templateShapes = 0;
  private broadcastSenders = 0;

  constructor(db: DB) {
    const conversational = CONVERSATIONAL_CONNECTORS.map((id) => `'${id}'`).join(", ");

    // Conversational streams are excluded, and leaving them in was a bug worth
    // naming: an iMessage's title is the handle it came from, so every thread
    // collapsed to one shape and an entire chat looked like a template. It
    // inflated the reported count to 13,294 while retiring 563, and worse, it
    // dropped individual texts before they could be lifted to their episode.
    const rows = db
      .prepare(
        `SELECT i.id, i.author, i.title, i.direction FROM items i
         JOIN streams s ON s.id = i.stream_id
         WHERE i.deleted_at IS NULL AND i.kind = 'message'
           AND s.connector_id NOT IN (${conversational})
           AND i.author IS NOT NULL`,
      )
      .all() as {
      id: string;
      author: string;
      title: string | null;
      direction: string | null;
    }[];

    // Who you have actually written to. One query, and the whole broadcast test
    // rests on it: a correspondent is somebody you answered.
    const replied = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT LOWER(TRIM(value)) AS address FROM items i
             JOIN json_each(i.participants) ON 1 = 1
             WHERE i.direction = 'outbound' AND i.deleted_at IS NULL
               AND i.participants IS NOT NULL`,
          )
          .all() as { address: string }[]
      ).map((row) => row.address),
    );

    const shapes = new Map<string, string[]>();
    const senders = new Map<string, string[]>();

    for (const row of rows) {
      if (row.direction === "outbound") {
        continue;
      }

      const address = (/<([^<>]+)>/.exec(row.author)?.[1] ?? row.author).toLowerCase().trim();

      const shape = titleShape(row.title);

      if (shape.length >= 3) {
        const key = `${address}|${shape}`;
        const seen = shapes.get(key);

        if (seen === undefined) {
          shapes.set(key, [row.id]);
        } else {
          seen.push(row.id);
        }
      }

      const bySender = senders.get(address);

      if (bySender === undefined) {
        senders.set(address, [row.id]);
      } else {
        bySender.push(row.id);
      }
    }

    for (const ids of shapes.values()) {
      if (ids.length < RECURRENCE_THRESHOLD) {
        continue;
      }

      this.templateShapes += 1;

      for (const id of ids) {
        this.templates.add(id);
      }
    }

    for (const [address, ids] of senders) {
      const announced = NO_REPLY.test(localPart(address));
      const oneWay = !replied.has(address) && ids.length >= BROADCAST_THRESHOLD;

      if (!announced && !oneWay) {
        continue;
      }

      this.broadcastSenders += 1;

      for (const id of ids) {
        this.broadcasts.add(id);
      }
    }
  }

  /** A recurring notification. Not a graph node at all. */
  isTemplate(itemId: string): boolean {
    return this.templates.has(itemId);
  }

  /** One-way mail. May be linked by reference or by a reminder, never by a word. */
  isBroadcast(itemId: string): boolean {
    return this.broadcasts.has(itemId) || this.templates.has(itemId);
  }

  /** Items that need no graph work at all. */
  get templateIds(): readonly string[] {
    return [...this.templates];
  }

  report(): NoiseReport {
    return {
      templateShapes: this.templateShapes,
      templateItems: this.templates.size,
      broadcastSenders: this.broadcastSenders,
      broadcastItems: this.broadcasts.size,
      total: new Set([...this.templates, ...this.broadcasts]).size,
    };
  }
}
