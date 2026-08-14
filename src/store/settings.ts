/**
 * A small key/value table for state that belongs to the install rather than to
 * any item: which embedding model built the current vector index, and whatever
 * comes next. Deliberately untyped and deliberately tiny. If something in here
 * grows structure, it wants its own table.
 */
import type { DB } from "../kernel/db.js";

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;

  return row === undefined ? null : row.value;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}
