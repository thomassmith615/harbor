/**
 * The Gmail connector.
 *
 * An API client plus a SourceConnector. It fetches and emits; it does not rank,
 * summarize, or decide what matters. Everything it cannot express in the item
 * columns is preserved in `raw`, so a better parser tomorrow does not require
 * re-downloading a mailbox.
 */
import { UpstreamError } from "../../kernel/errors.js";
import { CursorExpiredError } from "../types.js";
import { plausibleTime } from "../../store/items.js";
import type { Direction, ItemUpsert } from "../../store/items.js";
import type { SourceConnector, SyncBatch, SyncContext } from "../types.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

export interface GmailHeader {
  readonly name: string;
  readonly value: string;
}

export interface GmailPart {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly GmailHeader[];
  readonly body?: { readonly size?: number; readonly data?: string; readonly attachmentId?: string };
  readonly parts?: readonly GmailPart[];
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly historyId?: string;
  readonly internalDate?: string;
  readonly payload?: GmailPart;
}

export interface GmailProfile {
  readonly emailAddress: string;
  readonly messagesTotal: number;
  readonly historyId: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 7;

/**
 * Gmail signals rate limiting with 403, not 429.
 *
 * This cost a 17,000 message backfill at item 14,500. A 403 was treated as a
 * hard authorization failure and the run died, when the body plainly said
 * "Quota exceeded for quota metric 'Queries'". The status code alone is not
 * enough to tell a permission problem from a speed limit; the reason string is.
 */
const QUOTA_REASONS = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|Quota exceeded/i;

/**
 * Backs off when Gmail complains, and stays backed off.
 *
 * Retrying the one failed request is not enough: the limit is per user per
 * minute, so the next fifty requests will fail too. This slows the whole
 * connector for a while, then recovers.
 */
let throttleUntil = 0;
let throttleStep = 0;

async function waitForQuota(): Promise<void> {
  const remaining = throttleUntil - Date.now();

  if (remaining > 0) {
    await sleep(remaining);
  }
}

function throttle(): number {
  throttleStep = Math.min(throttleStep + 1, 6);
  // Gmail's per-user window is a minute, so waiting seconds is optimistic and
  // waiting minutes is correct.
  const wait = Math.min(2 ** throttleStep * 1_000, 60_000) + Math.random() * 2_000;
  throttleUntil = Date.now() + wait;
  return wait;
}

function easeThrottle(): void {
  if (throttleStep > 0 && Date.now() > throttleUntil) {
    throttleStep -= 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Google error bodies are multi-kilobyte JSON documents that push the useful
 * hint off the screen. Pull out the message and drop the rest.
 */
function summarize(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message.length > 300 ? `${message.slice(0, 300)}...` : message;
    }
  } catch {
    // Not JSON. Fall through.
  }

  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

/**
 * Retries on rate limits and transient upstream failures.
 *
 * A backfill makes tens of thousands of these calls, so a single 429 must not
 * end the run. Exponential with jitter; the jitter matters because concurrent
 * workers would otherwise retry in lockstep and re-trigger the same limit.
 */
async function call<T>(token: string, path: string, scheme = "Bearer"): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Every request waits out a live throttle, not just the one that hit it.
    await waitForQuota();

    let response: Response;

    try {
      response = await fetch(`${API}${path}`, { headers: { authorization: `${scheme} ${token}` } });
    } catch (cause: unknown) {
      lastError = cause;
      if (attempt === MAX_ATTEMPTS) {
        break;
      }
      await sleep(2 ** attempt * 250 + Math.random() * 250);
      continue;
    }

    if (response.ok) {
      easeThrottle();
      return (await response.json()) as T;
    }

    const body = await response.text();

    if (response.status === 404 && path.startsWith("/history")) {
      throw new CursorExpiredError("Gmail");
    }

    // A 403 that mentions quota is a speed limit, not a permission problem.
    if (response.status === 403 && QUOTA_REASONS.test(body) && attempt < MAX_ATTEMPTS) {
      throttle();
      continue;
    }

    if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
      throttle();
      continue;
    }

    throw new UpstreamError(
      `Gmail API ${path} returned ${String(response.status)}: ${summarize(body)}`,
      {
      status: response.status,
      hint:
        response.status === 403 && QUOTA_REASONS.test(body)
          ? "Gmail rate limited us for longer than Harbor waited. Run the backfill again; " +
            "it resumes where it stopped. A lower --concurrency makes this less likely."
          : response.status === 403
            ? "Check that the Gmail API is enabled for this Google Cloud project."
            : response.status === 401
              ? "Credentials were rejected. Re-run `harbor auth google`."
              : response.status === 429
                ? "Gmail rate limited us repeatedly. Try again with a lower --concurrency."
                : undefined,
    });
  }

  throw new UpstreamError(`Gmail API ${path} failed after ${String(MAX_ATTEMPTS)} attempts`, {
    cause: lastError,
  });
}

export async function fetchProfile(token: string): Promise<GmailProfile> {
  return await call<GmailProfile>(token, "/profile");
}

export interface MessagePage {
  readonly ids: readonly string[];
  readonly nextPageToken: string | null;
}

/**
 * Gmail's search syntax, for bounding a listing by date.
 *
 * `after:` and `before:` are evaluated by Google, so a ninety day window is one
 * query rather than a decade of downloads filtered locally. This is why Gmail
 * was the only unbounded source and no longer is.
 */
function dateQuery(window: { since: number | null; until: number | null } | undefined): string | null {
  if (window === undefined) {
    return null;
  }

  const stamp = (ms: number): string => {
    const date = new Date(ms);
    return `${String(date.getUTCFullYear())}/${String(date.getUTCMonth() + 1)}/${String(date.getUTCDate())}`;
  };

  const parts: string[] = [];

  if (window.since !== null) {
    parts.push(`after:${stamp(window.since)}`);
  }
  if (window.until !== null) {
    parts.push(`before:${stamp(window.until)}`);
  }

  return parts.length === 0 ? null : parts.join(" ");
}

export async function listMessagePage(
  token: string,
  options: {
    readonly labelId?: string;
    readonly pageToken?: string | null;
    readonly pageSize?: number;
    readonly window?: { since: number | null; until: number | null } | undefined;
  } = {},
): Promise<MessagePage> {
  const params = new URLSearchParams({ maxResults: String(options.pageSize ?? 500) });

  const query = dateQuery(options.window);

  if (query !== null) {
    params.set("q", query);
  }

  if (options.labelId !== undefined) {
    params.set("labelIds", options.labelId);
  }
  if (options.pageToken !== undefined && options.pageToken !== null) {
    params.set("pageToken", options.pageToken);
  }

  const page = await call<{
    messages?: readonly { id: string }[];
    nextPageToken?: string;
  }>(token, `/messages?${params.toString()}`);

  return {
    ids: (page.messages ?? []).map((message) => message.id),
    nextPageToken: page.nextPageToken ?? null,
  };
}

export interface HistoryChange {
  readonly changedIds: readonly string[];
  readonly deletedIds: readonly string[];
  readonly historyId: string | null;
}

/**
 * Everything that moved since `startHistoryId`.
 *
 * Label changes count, not just new mail: a message moving to or from SENT
 * alters its direction, and direction is the field the whole unclosed-loop
 * idea rests on.
 */
export async function listHistory(token: string, startHistoryId: string): Promise<HistoryChange> {
  const changed = new Set<string>();
  const deleted = new Set<string>();

  let pageToken: string | null = null;
  let latest: string | null = null;

  for (;;) {
    const params = new URLSearchParams({ startHistoryId, maxResults: "500" });

    for (const type of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) {
      params.append("historyTypes", type);
    }
    if (pageToken !== null) {
      params.set("pageToken", pageToken);
    }

    const page: {
      history?: readonly {
        messagesAdded?: readonly { message: { id: string } }[];
        messagesDeleted?: readonly { message: { id: string } }[];
        labelsAdded?: readonly { message: { id: string } }[];
        labelsRemoved?: readonly { message: { id: string } }[];
      }[];
      nextPageToken?: string;
      historyId?: string;
    } = await call(token, `/history?${params.toString()}`);

    latest = page.historyId ?? latest;

    for (const record of page.history ?? []) {
      for (const entry of record.messagesAdded ?? []) {
        changed.add(entry.message.id);
      }
      for (const entry of record.labelsAdded ?? []) {
        changed.add(entry.message.id);
      }
      for (const entry of record.labelsRemoved ?? []) {
        changed.add(entry.message.id);
      }
      for (const entry of record.messagesDeleted ?? []) {
        deleted.add(entry.message.id);
        changed.delete(entry.message.id);
      }
    }

    if (page.nextPageToken === undefined) {
      break;
    }
    pageToken = page.nextPageToken;
  }

  return { changedIds: [...changed], deletedIds: [...deleted], historyId: latest };
}

export async function fetchMessage(token: string, id: string): Promise<GmailMessage> {
  return await call<GmailMessage>(token, `/messages/${id}?format=full`);
}

/**
 * Bounded concurrency.
 *
 * messages.get costs 5 quota units against a 250-unit-per-second budget, so
 * fifty in flight per second is the ceiling. Five workers sits comfortably
 * under it and leaves room for the retries above.
 */
export async function fetchMessages(
  token: string,
  ids: readonly string[],
  // Three, not five. messages.get costs five quota units against 250 per
  // second, so five workers is nominally fine and empirically is not: Gmail
  // also enforces a per-minute ceiling that a sustained backfill walks into.
  concurrency = 3,
  onProgress?: (done: number, total: number) => void,
): Promise<readonly GmailMessage[]> {
  const results: GmailMessage[] = new Array<GmailMessage>(ids.length);
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const id = ids[index];
      if (id === undefined) {
        return;
      }

      results[index] = await fetchMessage(token, id);
      done += 1;
      onProgress?.(done, ids.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  return results;
}

function headerValue(message: GmailMessage, name: string): string | null {
  const lower = name.toLowerCase();

  for (const header of message.payload?.headers ?? []) {
    if (header.name.toLowerCase() === lower) {
      return header.value;
    }
  }

  return null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findPart(part: GmailPart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data !== undefined) {
    return decodeBase64Url(part.body.data);
  }

  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

/** Depth-first walk preferring text/plain, falling back to stripped text/html. */
function extractBody(part: GmailPart | undefined): string | null {
  if (part === undefined) {
    return null;
  }

  const plain = findPart(part, "text/plain");
  if (plain !== null) {
    return plain;
  }

  const html = findPart(part, "text/html");
  return html === null ? null : stripHtml(html);
}

function splitAddresses(value: string | null): readonly string[] {
  if (value === null || value.trim().length === 0) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Body text stored per message. Enough to summarize, not enough to bloat the store. */
export const MAX_BODY_CHARS = 20_000;

/**
 * Maps a Gmail message onto the universal item shape.
 *
 * Direction comes from the SENT label rather than from comparing the From
 * header to the account address, because Gmail is authoritative about what you
 * sent and address comparison is not (aliases, delegation, plus-addressing).
 */
export function toItem(context: SyncContext, message: GmailMessage): ItemUpsert {
  const labels = message.labelIds ?? [];
  const direction: Direction = labels.includes("SENT") ? "outbound" : "inbound";

  const body = extractBody(message.payload);

  // Gmail occasionally returns an internalDate of 0. Ingested naively that
  // becomes a message from 1970 sitting at the bottom of every coverage range.
  const occurredAt = plausibleTime(
    message.internalDate === undefined ? null : Number.parseInt(message.internalDate, 10),
    Date.now(),
  );

  return {
    accountId: context.accountId,
    streamId: context.streamId,
    externalId: message.id,
    kind: "message",
    direction,
    threadId: message.threadId,
    title: headerValue(message, "Subject"),
    body: body === null ? null : body.slice(0, MAX_BODY_CHARS),
    snippet: message.snippet ?? null,
    author: headerValue(message, "From"),
    participants: [
      ...splitAddresses(headerValue(message, "To")),
      ...splitAddresses(headerValue(message, "Cc")),
    ],
    occurredAt,
    endsAt: null,
    sourceUpdatedAt: null,
    uri: `https://mail.google.com/mail/u/0/#all/${message.id}`,
    raw: message,
  };
}

export const gmailConnector: SourceConnector = {
  id: "gmail",
  sourceType: "google",
  label: "Gmail",
  scopes: GMAIL_SCOPES,
  kinds: ["message"],

  async watermark(context: SyncContext): Promise<string | null> {
    return (await fetchProfile(context.token)).historyId;
  },

  async *backfill(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch> {
    const profile = await fetchProfile(context.token);
    let pageToken: string | null = cursor;

    for (;;) {
      const page: MessagePage = await listMessagePage(context.token, {
        pageToken,
        pageSize: 500,
        window: context.window,
      });

      const messages =
        page.ids.length === 0
          ? []
          : await fetchMessages(context.token, page.ids, context.concurrency);

      yield {
        upserts: messages.map((message) => toItem(context, message)),
        cursor: page.nextPageToken,
        progress: { total: profile.messagesTotal },
      };

      if (page.nextPageToken === null) {
        return;
      }
      pageToken = page.nextPageToken;
    }
  },

  async *incremental(context: SyncContext, cursor: string): AsyncGenerator<SyncBatch> {
    const change = await listHistory(context.token, cursor);

    const messages =
      change.changedIds.length === 0
        ? []
        : await fetchMessages(context.token, change.changedIds, context.concurrency);

    yield {
      upserts: messages.map((message) => toItem(context, message)),
      deletes: change.deletedIds,
      cursor: change.historyId ?? cursor,
      progress: { total: change.changedIds.length },
    };
  },
};
