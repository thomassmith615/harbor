/**
 * Folding the address book into the entity layer.
 *
 * M5's rule was that an email address is an identity anchor and a name is not,
 * and that only a shared address or an explicit human instruction may merge two
 * entities. This is the explicit instruction. A contact card asserting that
 * dana@northlightco.com and dana.w@gmail.com are the same person was typed by
 * a human on purpose, which makes it better evidence than anything Harbor could
 * infer from correspondence patterns.
 *
 * So contacts are allowed to do two things nothing else is:
 *
 *   merge entities that share no address, when a card lists both
 *   set a display name and pin it, so resolution stops second-guessing it
 *
 * Both are recorded as merges rather than rewrites, so they are inspectable and
 * `harbor unlink` still undoes them.
 */
import {
  createEntity,
  findByIdentifier,
  mergeEntities,
  pinEntity,
  resolveEntity,
  setAliases,
  upsertIdentifier,
} from "../store/entities.js";
import { isUsefulName, normalizeEmail, normalizeName } from "./identity.js";
import { aliasesFor, normalizePhone } from "./nicknames.js";
import { readRaw } from "../store/items.js";
import type { DB } from "../kernel/db.js";
import type { Entity } from "../store/entities.js";

export interface ContactLinkReport {
  readonly cards: number;
  readonly entitiesCreated: number;
  readonly merges: number;
  readonly namesPinned: number;
  readonly addressesLinked: number;
  readonly phonesLinked: number;
  readonly aliasesWritten: number;
  /**
   * Cards with a name and nothing to anchor it to.
   *
   * A name is not an identity, so a card carrying only a name cannot create or
   * find an entity and is skipped. That is correct and it is also invisible: on
   * a real address book someone went looking for a contact they knew was there
   * and found nothing, with no way to tell whether the card was missing, the
   * phone number had not parsed, or Harbor had simply ignored it.
   */
  readonly unanchored: readonly string[];
}

export interface CardDetail {
  readonly title: string | null;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly nickname: string | null;
  readonly linkedTo: string | null;
}

/** Every stored card and what Harbor could make of it. For diagnosis. */
export function inspectCards(db: DB, query?: string): readonly CardDetail[] {
  const rows = db
    .prepare(
      `SELECT id, title, participants FROM items
       WHERE kind = 'contact' AND deleted_at IS NULL
         AND (@query IS NULL OR LOWER(title) LIKE @needle)
       ORDER BY title
       LIMIT 200`,
    )
    .all({
      query: query ?? null,
      needle: query === undefined ? null : `%${query.toLowerCase()}%`,
    }) as ContactRow[];

  return rows.map((row) => {
    const { phones, nicknames } = fromRaw(db, row.id);

    const emails = emailsIn(row.participants);
    const allPhones = [...new Set([...phones, ...phonesIn(row.participants)])];
    const anchor = allPhones[0] ?? emails[0];

    const owner =
      anchor === undefined
        ? null
        : (findByIdentifier(db, allPhones[0] === undefined ? "email" : "phone", anchor)
            ?.displayName ?? null);

    return {
      title: row.title,
      emails,
      phones: allPhones,
      nickname: nicknames[0] ?? null,
      linkedTo: owner,
    };
  });
}

interface ContactRow {
  readonly id: string;
  readonly title: string | null;
  readonly participants: string | null;
  readonly occurred_at: number;
}

interface CardShape {
  readonly card?: {
    readonly phones?: readonly string[];
    readonly fullName?: string | null;
    readonly nickname?: string | null;
  };
}

/**
 * Phone numbers and stated nicknames, out of the stored payload.
 *
 * `participants` only ever held email addresses, so the numbers a card carries
 * were parsed at ingest and then dropped on the floor. They are the whole reason
 * a text thread can be joined to a person.
 */
/** Participants hold both addresses and numbers; these split them apart. */
function emailsIn(participants: string | null): readonly string[] {
  try {
    return (JSON.parse(participants ?? "[]") as string[])
      .filter((entry) => entry.includes("@"))
      .map(normalizeEmail);
  } catch {
    return [];
  }
}

function phonesIn(participants: string | null): readonly string[] {
  try {
    return (JSON.parse(participants ?? "[]") as string[])
      .filter((entry) => !entry.includes("@"))
      .map((entry) => normalizePhone(entry))
      .filter((entry): entry is string => entry !== null);
  } catch {
    return [];
  }
}

function fromRaw(db: DB, itemId: string): {
  readonly phones: readonly string[];
  readonly nicknames: readonly string[];
} {
  try {
    // Through the store, not the column: raw payloads are gzipped, so reading
    // the blob directly gets you a header and nothing else.
    const parsed = readRaw(db, itemId) as CardShape | null;
    const card = parsed?.card;

    if (card === undefined) {
      return { phones: [], nicknames: [] };
    }

    const phones = (card.phones ?? [])
      .map((entry) => normalizePhone(entry))
      .filter((entry): entry is string => entry !== null);

    // A NICKNAME property is a human stating the answer outright, which beats
    // anything derivable.
    const nicknames = card.nickname === undefined || card.nickname === null ? [] : [card.nickname];

    return { phones, nicknames };
  } catch {
    return { phones: [], nicknames: [] };
  }
}

/**
 * Runs over stored contact items and reconciles them with entities.
 *
 * Idempotent: running it twice changes nothing the second time, because merges
 * are keyed on entity identity and pinning is a set, not a toggle.
 */
export function linkContacts(db: DB): ContactLinkReport {
  const rows = db
    .prepare(
      `SELECT id, title, participants, occurred_at FROM items
       WHERE kind = 'contact' AND deleted_at IS NULL`,
    )
    .all() as ContactRow[];

  let entitiesCreated = 0;
  let merges = 0;
  let namesPinned = 0;
  let addressesLinked = 0;
  let phonesLinked = 0;
  let aliasesWritten = 0;
  const unanchored: string[] = [];

  // Batched rather than one transaction over the whole address book.
  //
  // A single transaction across 421 cards holds the write lock for as long as
  // the pass takes, which starves every other reader and writer and blows past
  // busy_timeout. Batching keeps each lock short; the pass is idempotent, so a
  // partial run is safe to repeat.
  const BATCH = 50;

  const work = db.transaction((batch: readonly ContactRow[]) => {
    for (const row of batch) {
      const addresses = emailsIn(row.participants);

      const fromPayload = fromRaw(db, row.id);

      // Participants carry both kinds now. Raw is still read, so cards stored
      // by an older version keep working without a re-sync.
      const phones = [...new Set([...fromPayload.phones, ...phonesIn(row.participants)])];
      const nicknames = fromPayload.nicknames;

      if (addresses.length === 0 && phones.length === 0) {
        if (row.title !== null && row.title.trim().length > 0) {
          unanchored.push(row.title);
        }

        continue;
      }

      // Which entities do these identifiers currently belong to?
      //
      // Both kinds, which is the join that matters: a card holding Marcus's
      // mobile and his Gmail is what merges the iMessage thread with the mail
      // thread. Neither source could ever have known they were one person.
      const owners = new Map<string, Entity>();

      for (const address of addresses) {
        const owner = findByIdentifier(db, "email", address);

        if (owner !== null) {
          owners.set(owner.id, owner);
        }
      }

      for (const phone of phones) {
        const owner = findByIdentifier(db, "phone", phone);

        if (owner !== null) {
          owners.set(owner.id, owner);
        }
      }

      // Prefer an existing entity to a new one, and prefer `self` above all:
      // folding your own address into a contact card must not demote you.
      const existing = [...owners.values()];
      const selfEntity = existing.find((entity) => entity.kind === "self");

      let target: Entity;

      if (selfEntity !== undefined) {
        target = selfEntity;
      } else if (existing.length > 0) {
        target = existing[0] as Entity;
      } else {
        target = createEntity(
          db,
          "person",
          row.title ?? addresses[0] ?? phones[0] ?? "(unnamed)",
          `contact:${row.id}`,
        );
        entitiesCreated += 1;
      }

      // The merge the card authorizes.
      for (const other of existing) {
        if (other.id === target.id) {
          continue;
        }

        mergeEntities(db, other.id, target.id);
        merges += 1;
      }

      const survivor = resolveEntity(db, target.id);

      if (survivor === null) {
        continue;
      }

      for (const address of addresses) {
        upsertIdentifier(db, {
          entityId: survivor.id,
          kind: "email",
          value: address,
          normalized: address,
          // The highest confidence in the system. A human typed this.
          confidence: 1,
          seenAt: row.occurred_at,
        });
        addressesLinked += 1;
      }

      for (const phone of phones) {
        upsertIdentifier(db, {
          entityId: survivor.id,
          kind: "phone",
          value: phone,
          normalized: phone,
          confidence: 1,
          seenAt: row.occurred_at,
        });
        phonesLinked += 1;
      }

      // Aliases, from the card's own name.
      //
      // Search, not identity: they widen lookup and never merge anything, so a
      // wrong guess costs a spurious match rather than two people welded
      // together. That asymmetry is what makes generating them liberally safe.
      if (row.title !== null && isUsefulName(row.title) && survivor.kind === "person") {
        const derived = aliasesFor(row.title, nicknames);
        aliasesWritten += setAliases(db, survivor.id, derived);
      }

      if (row.title !== null && isUsefulName(row.title) && survivor.kind !== "self") {
        upsertIdentifier(db, {
          entityId: survivor.id,
          kind: "name",
          value: row.title,
          normalized: normalizeName(row.title),
          confidence: 1,
          seenAt: row.occurred_at,
        });

        // Pinned: the address book outranks whatever a From header happened to
        // say, and re-resolution must not overwrite it.
        pinEntity(db, survivor.id, row.title);
        namesPinned += 1;
      }
    }
  });

  for (let index = 0; index < rows.length; index += BATCH) {
    work(rows.slice(index, index + BATCH));
  }

  return {
    cards: rows.length,
    entitiesCreated,
    merges,
    namesPinned,
    addressesLinked,
    phonesLinked,
    aliasesWritten,
    unanchored,
  };
}
