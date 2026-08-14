/**
 * The Apple Contacts connector.
 *
 * Contacts are an awkward fit for an item store and a very good fit for the
 * entity layer, and it is worth being clear about which job this is doing.
 *
 * As items they are strained: a contact is not a thing that happened, so
 * `occurred_at` is its last revision, which is meaningless for retrieval. They
 * are stored anyway because `raw` has to be preserved somewhere and because
 * "search my contacts" is a reasonable thing to want.
 *
 * The real value is what `derive/contacts.ts` does with them. A card asserting
 * that dana@work.com and dana.w@gmail.com are one person is the strongest
 * identity signal Harbor can get, because a human typed it deliberately. M5's
 * rule was that only a shared address or an explicit instruction may merge two
 * entities. An address book is an explicit instruction.
 */
import {
  CARDDAV_ROOT,
  collectionCtag,
  discoverHome,
  discoverPrincipal,
  fetchContacts,
  listCollections,
} from "./dav.js";
import { parseCards } from "./vcard.js";
import { plausibleTime } from "../../store/items.js";
import { normalizePhone } from "../../derive/nicknames.js";
import type { ItemUpsert } from "../../store/items.js";
import type { SourceConnector, SyncBatch, SyncContext } from "../types.js";
import type { VCard } from "./vcard.js";

function authHeader(context: SyncContext): string {
  return `${context.authScheme} ${context.token}`;
}

function parseCursor(cursor: string | null): Record<string, { ctag: string | null }> {
  if (cursor === null || cursor.length === 0) {
    return {};
  }

  try {
    return JSON.parse(cursor) as Record<string, { ctag: string | null }>;
  } catch {
    return {};
  }
}

function toItem(
  context: SyncContext,
  collectionUrl: string,
  card: VCard,
  vcard: string,
): ItemUpsert | null {
  if (card.uid.length === 0 || (card.fullName === null && card.emails.length === 0)) {
    return null;
  }

  const revision = card.revision === null ? null : Date.parse(card.revision);

  const lines: string[] = [];

  if (card.organization !== null) {
    lines.push(card.organization);
  }
  if (card.emails.length > 0) {
    lines.push(card.emails.join(", "));
  }
  if (card.phones.length > 0) {
    lines.push(card.phones.join(", "));
  }
  if (card.note !== null) {
    lines.push(card.note);
  }

  return {
    accountId: context.accountId,
    streamId: context.streamId,
    externalId: `${collectionUrl}#${card.uid}`,
    kind: "contact",
    title: card.fullName ?? card.emails[0] ?? "(unnamed)",
    body: lines.join("\n"),
    snippet: card.emails.join(", ") || card.organization,
    author: null,
    // Both kinds, in a field the content hash covers.
    //
    // Phone numbers used to live only in the raw payload, which meant a fix to
    // the vCard parser produced identical hashes and the rows were never
    // rewritten. Anything the entity layer needs has to be somewhere a change
    // is visible.
    participants: [
      ...card.emails,
      ...card.phones
        .map((phone) => normalizePhone(phone))
        .filter((phone): phone is string => phone !== null),
    ],
    // Not a moment in time in any useful sense. Revision is the least wrong
    // answer, and nothing in retrieval should be leaning on it.
    occurredAt: plausibleTime(revision, Date.now()),
    endsAt: null,
    sourceUpdatedAt: revision !== null && Number.isFinite(revision) ? revision : null,
    uri: null,
    // The verbatim card as well as the parsed one. Preserving only the parse
    // means every future parser improvement needs a re-sync from the source,
    // which is precisely what raw preservation exists to avoid.
    raw: { collectionUrl, card, vcard },
  };
}

async function* walk(
  context: SyncContext,
  cursor: string | null,
  onlyChanged: boolean,
): AsyncGenerator<SyncBatch> {
  const known = parseCursor(cursor);
  const next: Record<string, { ctag: string | null }> = { ...known };

  const principal = await discoverPrincipal(CARDDAV_ROOT, authHeader(context));
  const home = await discoverHome(CARDDAV_ROOT, principal, authHeader(context), "addressbook");
  const books = await listCollections(CARDDAV_ROOT, home, authHeader(context), "VCARD");

  for (const book of books) {
    const current = book.ctag ?? (await collectionCtag(book.url, authHeader(context)));

    if (onlyChanged && current !== null && known[book.url]?.ctag === current) {
      continue;
    }

    const resources = await fetchContacts(book.url, authHeader(context));
    const upserts: ItemUpsert[] = [];

    for (const resource of resources) {
      for (const card of parseCards(resource.data)) {
        const item = toItem(context, book.url, card, resource.data);

        if (item !== null) {
          upserts.push(item);
        }
      }
    }

    next[book.url] = { ctag: current };

    yield {
      upserts,
      cursor: JSON.stringify(next),
      progress: { total: null },
      note: `${book.displayName}: ${String(upserts.length)} contacts`,
    };
  }

  yield { upserts: [], cursor: JSON.stringify(next), progress: { total: null } };
}

export const appleContactsConnector: SourceConnector = {
  id: "apple-contacts",
  sourceType: "apple",
  label: "Apple Contacts",
  scopes: [],
  kinds: ["contact"],

  async watermark(): Promise<string | null> {
    return null;
  },

  async *backfill(context: SyncContext, cursor: string | null): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor, false);
  },

  async *incremental(context: SyncContext, cursor: string): AsyncGenerator<SyncBatch> {
    yield* walk(context, cursor, true);
  },
};
