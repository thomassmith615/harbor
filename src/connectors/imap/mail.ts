/**
 * Generic IMAP.
 *
 * The source that makes Harbor useful to people who do not use Gmail, which is
 * most people. One connector covers Comcast, Yahoo, Fastmail, AOL, iCloud Mail,
 * university and ISP accounts, and any corporate server that still speaks
 * password auth.
 *
 * Two dependencies, and they are the right call. `imapflow` implements a
 * stateful socket protocol with tagged commands and out-of-order untagged
 * responses; `mailparser` implements MIME, which is nested multiparts, transfer
 * encodings, charsets that lie, and thirty years of broken senders. Harbor has
 * hand-rolled OAuth, CalDAV, iCalendar, vCard, and an NSArchiver reader, and
 * every one of those produced auditable code. MIME would not have. It is the
 * one place where writing it myself would mean worse code rather than fewer
 * dependencies.
 *
 * Sync is by UID. UIDs are monotonic within a folder and never reused, so a
 * high-water mark per folder is the whole cursor. UIDVALIDITY is the escape
 * hatch: when the server changes it, every UID it ever issued is meaningless
 * and the folder has to be read again.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { UpstreamError } from "../../kernel/errors.js";
import { plausibleTime } from "../../store/items.js";
import type { ItemUpsert } from "../../store/items.js";
import type { SourceConnector, SyncBatch, SyncContext } from "../types.js";

/**
 * The credential, packed into the token field.
 *
 * The connector interface carries one opaque string, which is right for OAuth
 * and for Basic auth and needs a small amount of shape here. Encoding it as
 * JSON keeps host, port, user, and password in one place rather than widening
 * the interface for one source.
 */
export interface ImapCredential {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
}

export function packCredential(credential: ImapCredential): string {
  return Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
}

export function unpackCredential(token: string): ImapCredential {
  return JSON.parse(Buffer.from(token, "base64").toString("utf8")) as ImapCredential;
}

/** Folders that are noise in a searchable store. */
const SKIP = /^(\[Gmail\]\/)?(spam|junk|trash|deleted|bin|all mail|starred|important)$/i;

function interesting(path: string, specialUse: string | undefined): boolean {
  if (specialUse !== undefined && /\\(Junk|Trash|All|Flagged|Important)/i.test(specialUse)) {
    return false;
  }

  const leaf = path.split(/[/.]/).pop() ?? path;
  return !SKIP.test(leaf) && !SKIP.test(path);
}

/**
 * Folders whose contents are inbound by definition.
 *
 * Named explicitly so a spoofed sender in the inbox can never be promoted to
 * outbound by the fallback below.
 */
function inboxLike(path: string): boolean {
  return /\b(inbox|junk|spam|trash|deleted|archive)\b/i.test(path);
}

interface FolderCursor {
  /** Invalidated wholesale by the server when it changes. */
  readonly uidValidity: string;
  /** Highest UID read. UIDs are monotonic within a folder. */
  readonly lastUid: number;
}

function parseCursor(cursor: string | null): Record<string, FolderCursor> {
  if (cursor === null || cursor.length === 0) {
    return {};
  }

  try {
    return JSON.parse(cursor) as Record<string, FolderCursor>;
  } catch {
    return {};
  }
}

interface MaybeAddress {
  readonly address?: string | undefined;
  readonly name?: string | undefined;
}

function addressList(
  input: { value?: readonly MaybeAddress[] } | readonly unknown[] | undefined,
): readonly string[] {
  // `to` and `cc` are an object or an array of them depending on how many
  // headers the message carried, which is a mailparser detail worth absorbing
  // here rather than at every call site.
  const value: readonly MaybeAddress[] = Array.isArray(input)
    ? (input as { value?: readonly MaybeAddress[] }[]).flatMap((entry) => entry.value ?? [])
    : ((input as { value?: readonly MaybeAddress[] } | undefined)?.value ?? []);

  return value
    .map((entry) =>
      entry.name !== undefined && entry.name.length > 0 && entry.address !== undefined
        ? `${entry.name} <${entry.address}>`
        : (entry.address ?? entry.name ?? ""),
    )
    .filter((entry) => entry.length > 0);
}

/**
 * Which conversation a message belongs to.
 *
 * The first entry in References is the root of the thread, which is the correct
 * answer when it is there. It often is not, so the fallback is the subject with
 * reply and forward prefixes stripped, which is what mail clients have done for
 * decades and is right often enough to be worth doing.
 */
function threadOf(
  references: string | string[] | undefined,
  subject: string | undefined,
): string | null {
  const root = Array.isArray(references) ? references[0] : references;

  if (root !== undefined && root.length > 0) {
    return root;
  }

  const stripped = (subject ?? "").replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim();
  return stripped.length === 0 ? null : stripped;
}

// Smaller than it was. A page is the unit of cancellation and the unit of
// progress, and fifty messages keeps both responsive without meaningfully
// costing throughput on a protocol that pipelines anyway.
const PAGE = 50;

async function connect(credential: ImapCredential): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: credential.host,
    port: credential.port,
    secure: credential.secure,
    auth: { user: credential.user, pass: credential.pass },
    logger: false,
    // Some ISP servers present certificates that do not match their hostname.
    // Rejecting is right; failing with a readable message is the point.
    tls: { rejectUnauthorized: true },
  });

  try {
    await client.connect();
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);

    // imapflow reports a rejected login as "Command failed" with the server's
    // response tucked into a property, so the message alone is not enough to
    // tell a bad password from an unreachable host. Getting this wrong sends
    // someone to check their firewall when the answer is an app password.
    const detail = [
      message,
      String((cause as { response?: unknown }).response ?? ""),
      String((cause as { responseText?: unknown }).responseText ?? ""),
      String((cause as { authenticationFailed?: unknown }).authenticationFailed ?? ""),
    ].join(" ");

    const rejected =
      /authenticationfailed|invalid credentials|auth.*fail|login fail|bad password|\bNO\b/i.test(
        detail,
      ) || (cause as { authenticationFailed?: boolean }).authenticationFailed === true;

    throw new UpstreamError(
      rejected
        ? `${credential.host} rejected those credentials`
        : `Could not connect to ${credential.host}: ${message}`,
      {
        cause,
        hint: rejected
          ? "Most providers require an app-specific password rather than your account " +
            "password. Comcast, Yahoo, AOL, Fastmail, and iCloud all do."
          : `Check the host and port. Harbor tried ${credential.host}:${String(credential.port)}.`,
      },
    );
  }

  return client;
}

async function* walk(
  context: SyncContext,
  cursor: string | null,
  incremental: boolean,
): AsyncGenerator<SyncBatch> {
  const credential = unpackCredential(context.token);
  const known = parseCursor(cursor);
  const next: Record<string, FolderCursor> = { ...known };

  const client = await connect(credential);

  try {
    const folders = (await client.list()).filter(
      (folder) => !folder.flags.has("\\Noselect") && interesting(folder.path, folder.specialUse),
    );

    for (const folder of folders) {
      if (context.shouldStop?.() === true) {
        break;
      }

      const lock = await client.getMailboxLock(folder.path);

      try {
        const mailbox = client.mailbox;

        if (mailbox === false || mailbox.exists === 0) {
          continue;
        }

        const uidValidity = String(mailbox.uidValidity);
        const previous = known[folder.path];

        // A changed UIDVALIDITY means every UID the server ever gave us refers
        // to something else now. The only correct response is to forget and
        // re-read; upserts are content-hashed, so this is cheap in storage even
        // when it is expensive in bandwidth.
        const invalidated = previous !== undefined && previous.uidValidity !== uidValidity;

        let from = invalidated || previous === undefined ? 0 : previous.lastUid;

        if (invalidated) {
          yield {
            upserts: [],
            cursor: JSON.stringify(next),
            progress: { total: null },
            note: `${folder.path}: server reset its UIDs, re-reading`,
          };
        }

        // Incremental is the same walk with a high-water mark, which is why
        // there is one code path rather than two.
        const range = `${String(from + 1)}:*`;

        // The recent pass now means something for IMAP. Every other connector
        // honours `context.window` (Gmail turns it into after:/before:,
        // iMessage into a SQL floor), and this one ignored it, so `recent` and
        // `backfill` were the same operation: a full UID enumeration from 1.
        // A mailbox with a decade of history took the full backfill before
        // Harbor was usable at all, which is exactly what the two-phase design
        // exists to avoid.
        //
        // SINCE filters on the server's internal date rather than the Date
        // header. That is deliberate and correct here: a message that arrived
        // last week is recent even if somebody's clock claims 2001.
        const since = context.window?.since ?? null;

        const criteria =
          since === null
            ? { uid: range }
            : { uid: range, since: new Date(since) };

        const uids = await client.search(criteria, { uid: true });

        const wanted = (uids === false ? [] : uids).filter((uid) => uid > from);

        if (wanted.length === 0) {
          next[folder.path] = { uidValidity, lastUid: from };
          continue;
        }

        for (let index = 0; index < wanted.length; index += PAGE) {
          if (context.shouldStop?.() === true) {
            next[folder.path] = { uidValidity, lastUid: from };
            yield { upserts: [], cursor: JSON.stringify(next), progress: { total: wanted.length } };
            return;
          }

          const slice = wanted.slice(index, index + PAGE);
          const upserts: ItemUpsert[] = [];
          let unparseable = 0;

          for await (const message of client.fetch(
            slice.join(","),
            { uid: true, source: true, flags: true, internalDate: true },
            { uid: true },
          )) {
            // Inside the page too. Two hundred messages is long enough that
            // waiting for the page to finish is a visible stall.
            if (context.shouldStop?.() === true) {
              break;
            }

            if (message.source === undefined) {
              continue;
            }

            // One unparseable message must not end a backfill.
            //
            // "Failed to parse HTML" killed a run at message 400 of 37,000.
            // Thirty years of broken senders is exactly what a mailbox
            // contains, and the correct response to one of them is to skip it
            // and keep the other 36,999.
            let parsed: Awaited<ReturnType<typeof simpleParser>>;

            try {
              parsed = await simpleParser(message.source);
            } catch {
              unparseable += 1;
              from = Math.max(from, message.uid);
              continue;
            }

            const sent = parsed.date;
            const received = message.internalDate;

            const occurredAt = plausibleTime(
              sent instanceof Date
                ? sent.getTime()
                : received instanceof Date
                  ? received.getTime()
                  : null,
              Date.now(),
            );

            const from_ = addressList(parsed.from)[0] ?? null;
            const to = addressList(parsed.to);
            const cc = addressList(parsed.cc);

            // Which folder it is in, not who the message claims to be from.
            //
            // Spam spoofs the recipient's own address as the sender constantly,
            // and trusting the From header meant inbound spam was recorded as
            // sent mail. That is not cosmetic: entity resolution builds the
            // self entity from addresses seen on outbound mail, and a polluted
            // self entity quietly degrades every linker that excludes "you" from
            // counting as a shared person.
            //
            // The header is kept as a fallback for servers that do not name
            // their Sent folder in any recognizable way.
            const sentFolder = /\bsent\b/i.test(folder.path) || folder.specialUse === "\\Sent";

            const outbound =
              sentFolder ||
              (!inboxLike(folder.path) &&
                from_ !== null &&
                from_.toLowerCase().includes(credential.user.toLowerCase()));

            // HTML-only mail is common and is not optional to handle: stripping
            // tags is crude and beats storing nothing. `parsed.html` is false
            // rather than undefined when absent, which is a mailparser quirk.
            const html = typeof parsed.html === "string" ? parsed.html : null;

            const body =
              parsed.text ?? (html === null ? null : html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

            // The parser already holds the bytes, so text is extracted now
            // rather than through a second pass that would have to re-fetch the
            // message to reach content Harbor briefly had and threw away.
            const attachments = parsed.attachments.map((attachment) => ({
              filename: attachment.filename ?? null,
              mime: attachment.contentType ?? null,
              content: attachment.content ?? null,
              sizeBytes: attachment.size ?? attachment.content?.length ?? 0,
            }));

            upserts.push({
              accountId: context.accountId,
              streamId: context.streamId,
              // The Message-ID, not the UID: a message that appears in two
              // folders is one message, and UIDs are per folder.
              externalId: parsed.messageId ?? `${folder.path}#${String(message.uid)}`,
              kind: "message",
              direction: outbound ? "outbound" : "inbound",
              // References give a real thread; failing that, the normalized
              // subject is the traditional fallback and is usually right.
              threadId: threadOf(parsed.references, parsed.subject),
              ...(attachments.length === 0 ? {} : { attachments }),
              title: parsed.subject ?? "(no subject)",
              body: body === null ? null : body.slice(0, 40_000),
              snippet: (body ?? "").slice(0, 300),
              author: from_,
              participants: [...to, ...cc],
              occurredAt,
              endsAt: null,
              sourceUpdatedAt: null,
              uri: null,
              raw: {
                folder: folder.path,
                uid: message.uid,
                messageId: parsed.messageId,
                flags: [...(message.flags ?? [])],
                attachments: parsed.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  contentType: attachment.contentType,
                  size: attachment.size,
                })),
              },
            });

            from = Math.max(from, message.uid);
          }

          next[folder.path] = { uidValidity, lastUid: from };

          yield {
            upserts,
            cursor: JSON.stringify(next),
            // A real mailbox is tens of thousands of messages, so a bare count
            // is not enough to tell whether this is going to take a minute or
            // an hour.
            progress: { total: wanted.length },
            note:
              `${folder.path}: ${String(index + slice.length)} of ${String(wanted.length)}` +
              (unparseable > 0 ? ` (${String(unparseable)} unreadable)` : ""),
          };
        }

        next[folder.path] = { uidValidity, lastUid: from };
      } finally {
        lock.release();
      }
    }

    yield { upserts: [], cursor: JSON.stringify(next), progress: { total: null } };
  } finally {
    // Logout rather than close: servers hold connection slots, and a few of them
    // count strictly.
    await client.logout().catch(() => undefined);
  }

  void incremental;
}

export const imapConnector: SourceConnector = {
  id: "imap",
  sourceType: "imap",
  label: "Email (IMAP)",
  scopes: [],
  kinds: ["message"],

  async watermark(): Promise<string | null> {
    // The cursor is per folder and produced by the walk. There is no single
    // watermark to capture up front.
    return null;
  },

  async *backfill(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor, false);
  },

  async *incremental(context: SyncContext, cursor: string): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor, true);
  },
};

export interface ImapProbe {
  readonly folders: readonly { readonly path: string; readonly messages: number }[];
  readonly total: number;
}

/** Used by `harbor auth imap` to prove the credentials before anything is stored. */
export async function probe(credential: ImapCredential): Promise<ImapProbe> {
  const client = await connect(credential);

  try {
    const folders = (await client.list()).filter(
      (folder) => !folder.flags.has("\\Noselect") && interesting(folder.path, folder.specialUse),
    );

    const found: { path: string; messages: number }[] = [];
    let total = 0;

    for (const folder of folders.slice(0, 25)) {
      const status = await client.status(folder.path, { messages: true });
      const messages = status.messages ?? 0;

      found.push({ path: folder.path, messages });
      total += messages;
    }

    return { folders: found.sort((a, b) => b.messages - a.messages), total };
  } finally {
    await client.logout().catch(() => undefined);
  }
}
