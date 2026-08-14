/**
 * Mail that is a template rather than an event.
 *
 * From a real run, a situation Harbor was proud of:
 *
 *     You paid Christopher Hand $10.55
 *       20 things across 2 sources, Feb 18 to Apr 22
 *         You paid Christopher Hand $10.55
 *         Christopher Hand requests $10.55
 *         You paid Christopher Hand $10.55
 *         ...
 *
 * Every statement in it is true and the whole is worthless. It is one weekly
 * Venmo transaction, and Harbor chained the notifications into a component
 * because they genuinely do share rare words: a name, and each other.
 *
 * The store already has this idea for references. A confirmation code appearing
 * in forty items is a template rather than an identifier, so the reference
 * index refuses to link on it. The same reasoning applies one level up: an item
 * whose sender and subject shape recur weekly is a *notification*, not
 * something that happened, and connecting one instance to another says only
 * that the sender has a template.
 *
 * Detection is deliberately dumb, because the alternative is a classifier whose
 * mistakes nobody can audit. Strip the numbers out of a subject line, group by
 * sender, and anything recurring past a threshold is a template. "You paid
 * Christopher Hand $10.55" and "You paid Christopher Hand $12.00" collapse to
 * the same shape; "Dinner Saturday?" collapses to itself and stays a subject.
 *
 * Templates are not hidden and not deleted. They stay searchable, they still
 * feed the purchase projection, and `harbor find` returns them. They simply
 * stop being nodes in a graph whose entire job is noticing that two different
 * things are about one thing.
 */
import type { DB } from "../kernel/db.js";

/**
 * How many times a shape must recur before it is a template.
 *
 * Five, which on a real mailbox catches payment notifications, statement
 * availability, shipping updates, and job-board mail, and leaves an ordinary
 * back-and-forth alone. A person does not send you the same subject line five
 * times unless something is generating it.
 */
const RECURRENCE_THRESHOLD = 5;

/**
 * A subject with its variable parts removed.
 *
 * Numbers, money, dates, and order ids are exactly what differs between two
 * instances of one template, so they are what has to go.
 */
export function titleShape(title: string | null): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[$£€]?\d[\d,.:/-]*/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TemplateReport {
  readonly shapes: number;
  readonly items: number;
}

/**
 * Every item that is one instance of a recurring notification.
 *
 * Computed in one pass over items that have a sender, which is a few thousand
 * rows even on a large mailbox: conversations and calendar entries are excluded
 * because neither has the shape of a template and both are the things worth
 * linking.
 */
export class TemplateIndex {
  private readonly members = new Set<string>();
  private shapeCount = 0;

  constructor(db: DB) {
    const rows = db
      .prepare(
        `SELECT id, author, title FROM items
         WHERE deleted_at IS NULL AND kind = 'message'
           AND author IS NOT NULL AND title IS NOT NULL`,
      )
      .all() as { id: string; author: string; title: string }[];

    const groups = new Map<string, string[]>();

    for (const row of rows) {
      const shape = titleShape(row.title);

      if (shape.length < 3) {
        continue;
      }

      const key = `${row.author.toLowerCase()}|${shape}`;
      const existing = groups.get(key);

      if (existing === undefined) {
        groups.set(key, [row.id]);
      } else {
        existing.push(row.id);
      }
    }

    for (const ids of groups.values()) {
      if (ids.length < RECURRENCE_THRESHOLD) {
        continue;
      }

      this.shapeCount += 1;

      for (const id of ids) {
        this.members.add(id);
      }
    }
  }

  has(itemId: string): boolean {
    return this.members.has(itemId);
  }

  get ids(): readonly string[] {
    return [...this.members];
  }

  report(): TemplateReport {
    return { shapes: this.shapeCount, items: this.members.size };
  }
}
