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
 * Recurring reminders are one commitment, not one per occurrence.
 *
 * A daily reminder is a separate item per day, which is correct in the store
 * and wrong in a graph: "reading terminal rehearsal dinner" came back as a
 * seventeen-thing situation containing "rehearsal speech write ~5min" four
 * times. Every instance is real and the repetition carries no information, so
 * one instance stands for the set and the rest are excluded.
 *
 * The earliest is kept rather than the nearest, because it does not move as new
 * occurrences arrive and a situation that silently re-forms under a different
 * id every morning is worse than one that is slightly stale.
 */
const DUPLICATE_TASK_THRESHOLD = 2;

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
  readonly repeatedTasks: number;
  readonly templateShapes: number;
  readonly templateItems: number;
  readonly broadcastSenders: number;
  readonly broadcastItems: number;
  readonly total: number;
}

export class NoiseIndex {
  private readonly templates = new Set<string>();
  private readonly broadcasts = new Set<string>();
  private readonly repeats = new Set<string>();
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
      // No volume floor.
      //
      // The first version required three or more messages before silence
      // counted, reasoning that below that "you never replied" might just mean
      // you had nothing to say. That reasoning is about a person and this test
      // is about an address. Spam uses a fresh address every time, which is
      // exactly why a volume floor let it through: PCH sweepstakes, a Vegas
      // fall-break blast, and a terms-and-conditions notice all arrived once
      // and all formed situations. An address you have never written to is
      // broadcasting, whether it has said one thing or a hundred.
      const oneWay = !replied.has(address) || NO_REPLY.test(localPart(address));

      if (!oneWay) {
        continue;
      }

      this.broadcastSenders += 1;

      for (const id of ids) {
        this.broadcasts.add(id);
      }
    }

    const tasks = db
      .prepare(
        `SELECT id, stream_id, title FROM items
         WHERE deleted_at IS NULL AND kind = 'task' AND title IS NOT NULL
         ORDER BY occurred_at ASC`,
      )
      .all() as { id: string; stream_id: string; title: string }[];

    const byTitle = new Map<string, string[]>();

    for (const task of tasks) {
      const key = `${task.stream_id}|${task.title.toLowerCase().trim()}`;
      const seen = byTitle.get(key);

      if (seen === undefined) {
        byTitle.set(key, [task.id]);
      } else {
        seen.push(task.id);
      }
    }

    for (const ids of byTitle.values()) {
      if (ids.length < DUPLICATE_TASK_THRESHOLD) {
        continue;
      }

      // Ordered by time above, so index zero is the earliest.
      for (const id of ids.slice(1)) {
        this.repeats.add(id);
      }
    }
  }

  /** A recurring notification, or a repeat of a reminder. Not a graph node. */
  isTemplate(itemId: string): boolean {
    return this.templates.has(itemId) || this.repeats.has(itemId);
  }

  /** One-way mail. May be linked by reference or by a reminder, never by a word. */
  isBroadcast(itemId: string): boolean {
    return this.broadcasts.has(itemId) || this.templates.has(itemId);
  }

  /** One-way mail, for callers that filter in SQL. */
  get broadcastIds(): readonly string[] {
    return [...this.broadcasts];
  }

  /** Items that need no graph work at all. */
  get templateIds(): readonly string[] {
    return [...this.templates, ...this.repeats];
  }

  report(): NoiseReport {
    return {
      repeatedTasks: this.repeats.size,
      templateShapes: this.templateShapes,
      templateItems: this.templates.size,
      broadcastSenders: this.broadcastSenders,
      broadcastItems: this.broadcasts.size,
      total: new Set([...this.templates, ...this.broadcasts]).size,
    };
  }
}
