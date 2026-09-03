/**
 * The iMessage connector.
 *
 * The most local source Harbor will ever have. No API, no OAuth, no network:
 * `~/Library/Messages/chat.db` is a SQLite database on the machine, and the
 * only permission involved is Full Disk Access for whatever runs Harbor.
 *
 * Three things make this genuinely different from the others.
 *
 * **It is undocumented.** The schema is Apple's internal one and it changes
 * between releases. Every column read here is defensive; a missing table is
 * reported as a clear failure rather than a crash.
 *
 * **It is only true on this Mac.** There is no server-side iMessage. If Harbor
 * moves to a Linux box, this connector goes dark, which is the strongest
 * argument in the whole project for connectors eventually running out of
 * process on the machine that has the data.
 *
 * **It is the best material the signals engine will ever get.** A dropped
 * thread in a text conversation is a far more common kind of forgotten thing
 * than an unanswered email, and until now Harbor could not see any of them.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// The same driver the store uses, deliberately.
//
// `chat.db` is Apple's file and is not encrypted, so this could open it with
// plain better-sqlite3. Shipping two native SQLite modules to read two SQLite
// files means two prebuild matrices to keep working on an appliance meant to
// run unattended, and it already broke once: the store driver was swapped for
// the cipher build and this import kept the old package alive as an invisible
// dependency until it was removed from package.json and everything stopped
// loading. One driver.
import Database from "better-sqlite3-multiple-ciphers";
import { UpstreamError } from "../../kernel/errors.js";
import { appleDate, extractText } from "./attributed.js";
import { plausibleTime } from "../../store/items.js";
import type { ItemUpsert } from "../../store/items.js";
import type { ReactionUpsert } from "../types.js";
import type { SelfHandle, SourceConnector, SyncBatch, SyncContext } from "../types.js";

export function chatDbPath(): string {
  return process.env["HARBOR_IMESSAGE_DB"] ?? join(homedir(), "Library", "Messages", "chat.db");
}

export function available(): boolean {
  return existsSync(chatDbPath());
}

/**
 * A cheap fingerprint of the live database, without opening it.
 *
 * The snapshot below copies `chat.db` plus its `-wal` and `-shm` sidecars in
 * full, every single time a sync runs. That was fine when a sync was something
 * a person typed. On the appliance it is a fifteen-minute pulse, so it is
 * roughly a hundred full copies a day of a multi-gigabyte file that usually has
 * not changed at all: hours of pointless I/O, and write amplification on the
 * SSD it is copying onto.
 *
 * mtime and size across all three files is enough. A message written and
 * another deleted in the same second leaving the byte count identical is the
 * theoretical miss, and the next pulse catches it, because the WAL will not
 * come back to exactly the same size twice.
 */
export function liveFingerprint(): string | null {
  const source = chatDbPath();

  if (!existsSync(source)) {
    return null;
  }

  const parts: string[] = [];

  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${source}${suffix}`;

    try {
      const stat = statSync(path);
      parts.push(`${suffix}:${String(stat.size)}:${String(Math.floor(stat.mtimeMs))}`);
    } catch {
      parts.push(`${suffix}:absent`);
    }
  }

  return parts.join("|");
}

interface Snapshot {
  readonly db: Database.Database;
  close(): void;
}

/**
 * Opens a copy, not the live database.
 *
 * Messages.app holds `chat.db` open in WAL mode and writes to it constantly.
 * Reading it in place risks lock contention with the thing the user is actively
 * texting from, and opening read-only against a WAL database fails when the
 * sidecar files are not also readable. Copying all three gives a consistent
 * snapshot including recent messages still in the write-ahead log.
 */
function snapshot(): Snapshot {
  const source = chatDbPath();

  if (!existsSync(source)) {
    throw new UpstreamError(`No iMessage database at ${source}`, {
      hint:
        "iMessage only exists on macOS, and Harbor has to run on the Mac that has it. " +
        "If the file is there, grant Full Disk Access to your terminal or to the Harbor " +
        "service in System Settings, Privacy and Security.",
    });
  }

  const directory = mkdtempSync(join(tmpdir(), "harbor-imessage-"));
  const target = join(directory, "chat.db");

  try {
    copyFileSync(source, target);

    // The sidecars hold anything not yet checkpointed, which on an active Mac
    // is the last few hours of conversation.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${source}${suffix}`)) {
        copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
      }
    }
  } catch (cause: unknown) {
    rmSync(directory, { recursive: true, force: true });

    throw new UpstreamError("Could not read the iMessage database", {
      cause,
      hint:
        "This is almost always Full Disk Access. System Settings, Privacy and Security, " +
        "Full Disk Access, and add whatever runs Harbor.",
    });
  }

  // Read-write on the copy so SQLite can replay the WAL. The copy is discarded.
  const db = new Database(target);

  return {
    db,
    close(): void {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

interface MessageRow {
  readonly rowid: number;
  readonly guid: string;
  readonly text: string | null;
  readonly attributed: Buffer | null;
  readonly date: number | null;
  readonly is_from_me: number;
  readonly service: string | null;
  readonly handle: string | null;
  readonly chat_guid: string | null;
  readonly chat_name: string | null;
  readonly chat_identifier: string | null;
  readonly is_group: number;
  readonly participants: string | null;
  readonly has_attachments: number;
  readonly item_type: number;
}

/**
 * `item_type` 0 is a real message. Everything else is a join, a leave or a
 * rename, which are noise in a store meant to answer questions.
 *
 * Tapbacks used to be filtered here too, by `associated_message_guid IS NULL`,
 * on the same grounds. That was half right. A tapback is not a message and it
 * is not noise either: liking the text that asked who is coming is how a large
 * share of people answer it, and filtering it at the connector meant that
 * answer was not merely unread but unrecoverable, because no pass downstream
 * can find what was never written.
 *
 * They are read separately, by REACTIONS below, and stored beside the message
 * they annotate rather than as messages of their own.
 */
const QUERY = `
  SELECT
    m.ROWID              AS rowid,
    m.guid               AS guid,
    m.text               AS text,
    m.attributedBody     AS attributed,
    m.date               AS date,
    m.is_from_me         AS is_from_me,
    m.service            AS service,
    m.cache_has_attachments AS has_attachments,
    COALESCE(m.item_type, 0) AS item_type,
    h.id                 AS handle,
    c.guid               AS chat_guid,
    c.display_name       AS chat_name,
    c.chat_identifier    AS chat_identifier,
    CASE WHEN c.style = 43 THEN 1 ELSE 0 END AS is_group,
    (
      SELECT GROUP_CONCAT(h2.id, ', ')
      FROM chat_handle_join chj
      JOIN handle h2 ON h2.ROWID = chj.handle_id
      WHERE chj.chat_id = c.ROWID
    ) AS participants
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE m.ROWID > @cursor
    AND COALESCE(m.item_type, 0) = 0
    AND m.associated_message_guid IS NULL
  ORDER BY m.ROWID
  LIMIT @limit
`;

/**
 * Tapbacks in the same row range.
 *
 * `associated_message_type` is 2000 through 2005 for adding a reaction and
 * 3000 through 3005 for removing one. Only the additions are read: a removal
 * says a reaction that Harbor may never have seen is gone, and the store's
 * answer to that is the same either way, which is to hold the latest reaction
 * per person per message and let a later sync overwrite it.
 *
 * `associated_message_guid` is the target, prefixed in most versions with
 * `p:0/` or `bp:` depending on whether the reaction is on a message or on part
 * of one. The prefix is stripped rather than matched on, because it has
 * changed across macOS releases and the guid after it has not.
 */
const REACTIONS = `
  SELECT
    m.ROWID                     AS rowid,
    m.guid                      AS guid,
    m.date                      AS date,
    m.is_from_me                AS is_from_me,
    m.associated_message_guid   AS target,
    m.associated_message_type   AS reaction_type,
    h.id                        AS handle
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > @cursor AND m.ROWID <= @ceiling
    AND m.associated_message_guid IS NOT NULL
    AND m.associated_message_type BETWEEN 2000 AND 2005
  ORDER BY m.ROWID
`;

interface ReactionRow {
  readonly rowid: number;
  readonly date: number | null;
  readonly is_from_me: number;
  readonly target: string;
  readonly reaction_type: number;
  readonly handle: string | null;
}

const REACTION_KINDS: Readonly<Record<number, ReactionUpsert["kind"]>> = {
  2000: "love",
  2001: "like",
  2002: "dislike",
  2003: "laugh",
  2004: "emphasize",
  2005: "question",
};

function targetGuid(raw: string): string {
  const slash = raw.lastIndexOf("/");

  return slash === -1 ? raw : raw.slice(slash + 1);
}

function toReaction(row: ReactionRow): ReactionUpsert | null {
  const kind = REACTION_KINDS[row.reaction_type];
  const at = appleDate(row.date);

  if (kind === undefined || at === null) {
    return null;
  }

  return {
    targetExternalId: targetGuid(row.target),
    // Null is the user, the same convention `author` uses on an item.
    author: row.is_from_me === 1 ? null : row.handle,
    kind,
    occurredAt: plausibleTime(at, Date.now()),
  };
}

/** How far back an initial ingest reaches. Null means everything. */
const BACKFILL_YEARS = Number.parseInt(process.env["HARBOR_IMESSAGE_YEARS"] ?? "5", 10);

function conversationTitle(row: MessageRow): string {
  if (row.chat_name !== null && row.chat_name.trim().length > 0) {
    return row.chat_name;
  }

  if (row.is_group === 1) {
    const people = (row.participants ?? "").split(", ").filter((entry) => entry.length > 0);
    return people.length === 0 ? "Group message" : `Group: ${people.slice(0, 4).join(", ")}`;
  }

  return row.chat_identifier ?? row.handle ?? "Message";
}

function toItem(context: SyncContext, row: MessageRow): ItemUpsert | null {
  const rawOccurred = appleDate(row.date);

  if (rawOccurred === null) {
    return null;
  }

  // A text cannot be from the future, and one that claims to be becomes the
  // "last contact" for that person permanently.
  const occurredAt = plausibleTime(rawOccurred, Date.now());

  const body = row.text ?? extractText(row.attributed);

  // A message with no text is an attachment, a reaction we filtered, or an
  // encoding we could not read. Nothing to search, so nothing to store.
  if (body === null || body.trim().length === 0) {
    return null;
  }

  const outbound = row.is_from_me === 1;
  const participants = (row.participants ?? row.handle ?? "")
    .split(", ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    accountId: context.accountId,
    streamId: context.streamId,
    externalId: row.guid,
    kind: "message",
    direction: outbound ? "outbound" : "inbound",
    // The chat, so a whole exchange is one thread and the unclosed-loop
    // detector can reason about it the way it does with mail.
    threadId: row.chat_guid,
    title: conversationTitle(row),
    body,
    snippet: body.slice(0, 200),
    author: outbound ? null : row.handle,
    participants,
    occurredAt,
    endsAt: null,
    sourceUpdatedAt: null,
    uri: null,
    raw: {
      rowid: row.rowid,
      guid: row.guid,
      service: row.service,
      chatGuid: row.chat_guid,
      isGroup: row.is_group === 1,
      hasAttachments: row.has_attachments === 1,
      // Deliberately not the attributedBody blob: it is large, binary, and
      // everything useful in it is already extracted.
    },
  };
}

const PAGE = 2_000;

/**
 * The cursor, which is a row id and the fingerprint of the file it was read
 * from.
 *
 * Legacy cursors are a bare row id and parse to a null fingerprint, which
 * simply means the first run after upgrading does not skip. Nothing has to be
 * reset. The framework treats this as opaque, which is exactly what the
 * connector contract promises, so the format is ours to extend.
 */
function parseCursor(cursor: string | null): {
  readonly rowid: number;
  readonly fingerprint: string | null;
} {
  if (cursor === null) {
    return { rowid: 0, fingerprint: null };
  }

  const hash = cursor.indexOf("#");

  if (hash < 0) {
    return { rowid: Number.parseInt(cursor, 10) || 0, fingerprint: null };
  }

  return {
    rowid: Number.parseInt(cursor.slice(0, hash), 10) || 0,
    fingerprint: cursor.slice(hash + 1),
  };
}

async function* walk(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch> {
  const resume = parseCursor(cursor);

  // Read the fingerprint before the copy, never after. If chat.db changes while
  // we are reading it, recording the older fingerprint means the next pulse
  // reads again, and reading twice is the cheap mistake.
  const fingerprint = liveFingerprint();

  // Nothing has been written to chat.db since the last pass, so there is
  // nothing to copy and nothing to read.
  //
  // Provably equivalent to running: with a non-null cursor this walk ignores
  // the window entirely and resumes from a row id, and row ids are monotonic,
  // so an unchanged file cannot contain a row above the one we stopped at.
  // What it saves is the copy, which is the whole file plus its WAL, taken
  // ninety-six times a day on a fifteen-minute pulse.
  if (
    cursor !== null &&
    resume.fingerprint !== null &&
    fingerprint !== null &&
    resume.fingerprint === fingerprint
  ) {
    return;
  }

  const snap = snapshot();
  const stamp = (at: number): string =>
    fingerprint === null ? String(at) : `${String(at)}#${fingerprint}`;

  try {
    const total = snap.db.prepare(`SELECT COUNT(*) AS n FROM message`).get() as { n: number };

    let rowid = resume.rowid;

    const requestedFloor = context.window?.since ?? null;
    const ceiling = context.window?.until ?? null;

    // Row ids are chronological, so a date bound becomes a rowid bound and the
    // scan starts at the right place rather than reading a decade to discard it.
    if (cursor === null) {
      const floor =
        requestedFloor ??
        (Number.isFinite(BACKFILL_YEARS) && BACKFILL_YEARS > 0
          ? Date.now() - BACKFILL_YEARS * 365 * 86_400_000
          : null);

      const oldest = floor === null ? { rowid: null } : snap.db
        .prepare(
          `SELECT MIN(ROWID) AS rowid FROM message
           WHERE (CASE WHEN date > 100000000000 THEN date / 1000000000 ELSE date END)
                 + 978307200 > @floorSeconds`,
        )
        .get({ floorSeconds: Math.floor(floor / 1000) }) as { rowid: number | null };

      if (oldest.rowid !== null) {
        rowid = oldest.rowid - 1;
      }
    }

    let seen = 0;

    for (;;) {
      if (context.shouldStop?.() === true) {
        return;
      }

      const rows = snap.db.prepare(QUERY).all({ cursor: rowid, limit: PAGE }) as MessageRow[];

      if (rows.length === 0) {
        // An empty batch, purely to record the fingerprint. Without this the
        // cursor only ever gains one on a page that had rows, so a store that
        // is already caught up never learns it can skip and copies the file
        // forever.
        yield { upserts: [], cursor: stamp(rowid), progress: { total: total.n } };

        return;
      }

      const upserts: ItemUpsert[] = [];
      let pastCeiling = false;
      let unreadable = 0;

      // The row range this page covers, before the loop moves the cursor.
      const from = rowid;

      for (const row of rows) {
        const item = toItem(context, row);

        // Counted, so a page that reads nothing says so instead of looking like
        // a page with nothing to read.
        if (item === null && row.text === null && row.attributed !== null) {
          unreadable += 1;
        }

        if (item !== null) {
          if (ceiling !== null && item.occurredAt >= ceiling) {
            // Chronological, so the first item past the ceiling means the rest
            // are too.
            pastCeiling = true;
            break;
          }

          upserts.push(item);
        }

        rowid = Math.max(rowid, row.rowid);
      }

      seen += rows.length;

      // Reactions over the same range, read after the messages so that the two
      // queries cannot disagree about where the page ended.
      const reactions: ReactionUpsert[] = [];

      for (const row of snap.db
        .prepare(REACTIONS)
        .all({ cursor: from, ceiling: rowid }) as ReactionRow[]) {
        const reaction = toReaction(row);

        if (reaction !== null) {
          reactions.push(reaction);
        }
      }

      yield {
        upserts,
        reactions,
        // The cursor is a row id, which is monotonic and never reused. Simpler
        // and more reliable than anything the networked sources offer. The
        // fingerprint rides along so the next pass can tell whether the file
        // moved at all.
        cursor: stamp(rowid),
        progress: { total: total.n },
        ...(unreadable > 0
          ? {
              note:
                `${String(unreadable)} of ${String(rows.length)} messages had text ` +
                "Harbor could not read; run `harbor dev imessage check`",
            }
          : {}),
      };

      if (pastCeiling || rows.length < PAGE) {
        return;
      }
    }
  } finally {
    snap.close();
  }
}

/**
 * The addresses and phone numbers this Mac sends from.
 *
 * `chat.account_login` carries them in Apple's own prefixed form: `E:` for an
 * address, `P:` for a phone number. Harbor had no way to learn either, and the
 * consequence was larger than it sounds. An outbound text has no author (it is
 * from you, so Apple stores no handle), and the self entity was built entirely
 * from the addresses on connected mail accounts. So your phone number was never
 * an identity anchor, the messages you sent were attributed to nobody, and
 * "have I replied to them" was unanswerable for the source where most replying
 * actually happens.
 *
 * Read at sync time and recorded once. Nothing here parses further than the
 * prefix: what a handle means is Apple's business, and matching it against a
 * contact card is entity resolution's.
 */
export function readSelfHandles(): readonly SelfHandle[] {
  if (!available()) {
    return [];
  }

  const snap = snapshot();

  try {
    const rows = snap.db
      .prepare(
        `SELECT DISTINCT account_login AS login FROM chat
         WHERE account_login IS NOT NULL AND account_login <> ''`,
      )
      .all() as { login: string }[];

    const found: SelfHandle[] = [];

    for (const row of rows) {
      const login = row.login.trim();

      if (login.startsWith("E:") && login.includes("@")) {
        found.push({ kind: "email", value: login.slice(2).toLowerCase() });
        continue;
      }

      if (login.startsWith("P:")) {
        found.push({ kind: "phone", value: login.slice(2) });
      }
    }

    return found;
  } catch {
    // An older or newer chat.db without the column is not a reason to fail a
    // sync. The self entity is simply weaker, and `harbor doctor` says so.
    return [];
  } finally {
    snap.close();
  }
}

export const imessageConnector: SourceConnector = {
  id: "imessage",
  sourceType: "imessage",
  label: "iMessage",
  scopes: [],
  kinds: ["message"],

  selfHandles(): readonly SelfHandle[] {
    return readSelfHandles();
  },

  async watermark(): Promise<string | null> {
    // The cursor is produced by the walk itself and there is no separate
    // watermark to capture: row ids only ever go up.
    return null;
  },

  async *backfill(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor);
  },

  async *incremental(context: SyncContext, cursor: string): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor);
  },
};

export interface ExtractionReport {
  readonly sampled: number;
  readonly plainText: number;
  readonly fromAttributed: number;
  readonly unreadable: number;
  /** A hex sample of a blob that could not be read, for diagnosing the format. */
  readonly sample: string | null;
}

/**
 * How well text extraction is working on this Mac.
 *
 * `attributedBody` is an undocumented archive format that changes between macOS
 * releases, and when extraction fails the connector still reports success while
 * storing almost nothing. That happened: sixteen thousand messages scanned,
 * twelve stored. A silent failure needs a way to be seen, so this samples real
 * rows and says plainly how many came out.
 */
export function checkExtraction(limit = 400): ExtractionReport {
  const snap = snapshot();

  try {
    const rows = snap.db
      .prepare(
        `SELECT text, attributedBody FROM message
         WHERE COALESCE(item_type, 0) = 0 AND associated_message_guid IS NULL
         ORDER BY ROWID DESC LIMIT ?`,
      )
      .all(limit) as { text: string | null; attributedBody: Buffer | null }[];

    let plainText = 0;
    let fromAttributed = 0;
    let unreadable = 0;
    let sample: string | null = null;

    for (const row of rows) {
      if (row.text !== null && row.text.trim().length > 0) {
        plainText += 1;
        continue;
      }

      if (row.attributedBody === null) {
        // No text and no body: an attachment or a reaction. Not a failure.
        continue;
      }

      const text = extractText(row.attributedBody);

      if (text !== null && text.trim().length > 0) {
        fromAttributed += 1;
        continue;
      }

      unreadable += 1;

      if (sample === null) {
        // First 300 bytes only. Enough to show the archive header and the
        // layout around the first marker without carrying message content.
        sample = row.attributedBody.subarray(0, 300).toString("hex");
      }
    }

    return { sampled: rows.length, plainText, fromAttributed, unreadable, sample };
  } finally {
    snap.close();
  }
}

export interface ChatSummary {
  readonly name: string;
  readonly identifier: string;
  readonly isGroup: boolean;
  readonly messages: number;
  readonly lastAt: number | null;
}

/** Used by `harbor auth imessage` to prove access before anything is ingested. */
export function inspect(): { readonly total: number; readonly chats: readonly ChatSummary[] } {
  const snap = snapshot();

  try {
    const total = snap.db.prepare(`SELECT COUNT(*) AS n FROM message`).get() as { n: number };

    const rows = snap.db
      .prepare(
        `SELECT
           COALESCE(NULLIF(c.display_name, ''), c.chat_identifier) AS name,
           c.chat_identifier AS identifier,
           CASE WHEN c.style = 43 THEN 1 ELSE 0 END AS isGroup,
           COUNT(m.ROWID) AS messages,
           MAX(m.date) AS lastAt
         FROM chat c
         JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         JOIN message m ON m.ROWID = cmj.message_id
         GROUP BY c.ROWID
         ORDER BY messages DESC
         LIMIT 15`,
      )
      .all() as {
      name: string | null;
      identifier: string;
      isGroup: number;
      messages: number;
      lastAt: number | null;
    }[];

    return {
      total: total.n,
      chats: rows.map((row) => ({
        name: row.name ?? row.identifier,
        identifier: row.identifier,
        isGroup: row.isGroup === 1,
        messages: row.messages,
        lastAt: appleDate(row.lastAt),
      })),
    };
  } finally {
    snap.close();
  }
}
