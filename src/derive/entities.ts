/**
 * Entity resolution.
 *
 * Walks items, extracts the people involved, and links them. Versioned and
 * re-runnable like every other derivation, from data already in the store.
 *
 * The governing rule, restated because it is the whole design:
 *
 *   An address or a phone number is an identity anchor. A name is not.
 *
 * So: addresses create and key entities. Names attach as labels and as search
 * handles, but a name alone never merges two entities and never creates one
 * that an address could later collide with. Two people called John Smith stay
 * two entities until they share an address or a human runs `harbor merge`.
 *
 * This deliberately under-merges. The failure it avoids is the one with no
 * visible symptom: silently welding two people together produces confident,
 * well-sourced, wrong answers, and nothing in the output looks off.
 *
 * The exception is `self`. Knowing which addresses are the user is not a
 * nicety; it is the precondition for asking whether they replied to something,
 * which is the entire basis of the unclosed-loop detector.
 */
import {
  clearItemLinks,
  countPendingResolution,
  createEntity,
  findByIdentifier,
  linkItem,
  listSelfHandles,
  markResolved,
  mergeEntities,
  pendingResolution,
  resolveEntity,
  selfEntity,
  setAliases,
  setDisplayName,
  upsertIdentifier,
} from "../store/entities.js";
import { normalizePhone } from "./nicknames.js";
import {
  isUsefulName,
  looksAutomated,
  normalizeEmail,
  normalizeName,
  parseAddress,
  parseAddressList,
} from "./identity.js";
import { linkContacts } from "./contacts.js";
import { aliasesFor } from "./nicknames.js";
import { listAccounts } from "../store/accounts.js";
import type { DB } from "../kernel/db.js";
import type { Entity } from "../store/entities.js";

/** Bump to re-resolve everything. Independent of the chunking pipeline. */
export const ENTITY_VERSION = 4;

const ITEM_BATCH = 500;

export interface ResolveOptions {
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onProgress?: (done: number, total: number) => void;
  readonly onNote?: (message: string) => void;
}

export interface ResolveReport {
  readonly itemsResolved: number;
  readonly entitiesCreated: number;
  readonly linksWritten: number;
  readonly selfAddresses: number;
  readonly contactCards: number;
  readonly contactMerges: number;
  readonly aliases: number;
  readonly version: number;
  readonly remaining: number;
  readonly durationMs: number;
}

/**
 * Establishes the `self` entity from connected account addresses.
 *
 * Addresses that appear as the author of outbound mail are folded in too,
 * which catches aliases and send-as identities that the account label alone
 * would miss.
 */
function ensureSelf(db: DB, onNote?: (message: string) => void): { entity: Entity; addresses: number } {
  const existing = selfEntity(db);
  // An account label is only a name for you when it is actually an address.
  // iMessage's label is "iMessage", which is the name of a source, not a
  // person, and using it made the self entity read as though the user were
  // called iMessage.
  const named = listAccounts(db).find((account) => account.label.includes("@"));
  const label = named?.label ?? "me";

  const entity =
    existing ?? createEntity(db, "self", label, "self:default");

  const addresses = new Set<string>();

  for (const account of listAccounts(db)) {
    if (!account.label.includes("@")) {
      continue;
    }

    addresses.add(normalizeEmail(account.label));
  }

  // Handles a connector told us are ours.
  //
  // Distinct from the two sources below, and stronger than either. An account
  // label is a guess that happens to usually be an address; an outbound author
  // is an inference from a header. This is the source saying so.
  const phones = new Set<string>();

  for (const handle of listSelfHandles(db)) {
    if (handle.kind === "phone") {
      const normalized = normalizePhone(handle.value);

      if (normalized !== null) {
        phones.add(normalized);
      }

      continue;
    }

    if (handle.value.includes("@")) {
      addresses.add(normalizeEmail(handle.value));
    }
  }

  // Anything we have demonstrably sent from is us.
  const authors = db
    .prepare(
      `SELECT DISTINCT author FROM items
       WHERE direction = 'outbound' AND author IS NOT NULL AND deleted_at IS NULL
       LIMIT 200`,
    )
    .all() as { author: string }[];

  for (const row of authors) {
    const parsed = parseAddress(row.author);
    if (parsed.email !== null) {
      addresses.add(parsed.email);
    }
  }

  const now = Date.now();

  for (const address of addresses) {
    const owner = findByIdentifier(db, "email", address);

    if (owner !== null && owner.id !== entity.id) {
      // Merged into self, not left alone.
      //
      // Leaving it produced exactly the wrong outcome on a real store: mail
      // from a Gmail account made "self", then a Comcast account arrived, its
      // address already belonged to an entity built from correspondence, the
      // unique constraint refused to move it, and the user ended up as two
      // people. One held 16,000 items and the other 9,000, and neither knew
      // about the other.
      //
      // An address Harbor was told is yours is the strongest claim there is:
      // it comes from a connected account, not from a header. Nothing outranks
      // it, so the entity holding it is you under another name.
      onNote?.(`${address} belonged to a separate entity; merging it into you`);
      mergeEntities(db, owner.id, entity.id);
      continue;
    }

    upsertIdentifier(db, {
      entityId: entity.id,
      kind: "email",
      value: address,
      normalized: address,
      confidence: 1,
      seenAt: now,
    });
  }

  for (const phone of phones) {
    const owner = findByIdentifier(db, "phone", phone);

    if (owner !== null && owner.id !== entity.id) {
      onNote?.(`${phone} belonged to a separate entity; merging it into you`);
      mergeEntities(db, owner.id, entity.id);
      continue;
    }

    upsertIdentifier(db, {
      entityId: entity.id,
      kind: "phone",
      value: phone,
      normalized: phone,
      confidence: 1,
      seenAt: now,
    });
  }

  // Identifiers that are not identifiers.
  //
  // An earlier version treated every account label as an address, so a source
  // named "iMessage" became one. Harmless in isolation and confusing to read,
  // and re-resolution alone will not remove it because nothing revisits an
  // identifier once written.
  db.prepare(
    `DELETE FROM identifiers
     WHERE entity_id = ? AND kind = 'email' AND normalized NOT LIKE '%@%'`,
  ).run(entity.id);

  return { entity, addresses: addresses.size + phones.size };
}

interface Extracted {
  readonly email: string | null;
  readonly phone: string | null;
  readonly name: string | null;
  readonly raw: string;
  readonly role: "author" | "participant";
}

function extract(item: {
  readonly author: string | null;
  readonly participants: string | null;
}): readonly Extracted[] {
  const people: Extracted[] = [];

  if (item.author !== null && item.author.length > 0) {
    const parsed = parseAddress(item.author);
    people.push({ ...parsed, role: "author" });
  }

  if (item.participants !== null) {
    let values: string[] = [];

    try {
      values = JSON.parse(item.participants) as string[];
    } catch {
      values = [];
    }

    for (const parsed of parseAddressList(values)) {
      people.push({ ...parsed, role: "participant" });
    }
  }

  return people;
}

/**
 * Aliases for entities with no contact card.
 *
 * Skips anything already covered, anything organizational, and anything whose
 * display name is still just an address: a nickname derived from "noreply" is
 * noise, and orgs are not referred to by diminutives.
 */
/**
 * Does this read like a person's name?
 *
 * One or two words, no corporate vocabulary. Deliberately strict: a missed
 * nickname costs one failed search, whereas a company treated as a person
 * pollutes every lookup that shares a prefix with it.
 */
function looksPersonal(name: string): boolean {
  const words = name.trim().split(/\s+/);

  if (words.length > 3) {
    return false;
  }

  return !/\b(support|services?|team|account|inc|llc|ltd|co|society|academy|group|store|shop|news|alerts?|notifications?|billing|sales|info|help|admin|noreply|no-reply)\b/i.test(
    name,
  );
}

function backfillAliases(db: DB): number {
  const rows = db
    .prepare(
      `SELECT id, display_name FROM entities
       WHERE merged_into IS NULL
         AND kind = 'person'
         AND display_name NOT LIKE '%@%'
         AND id NOT IN (SELECT DISTINCT entity_id FROM entity_aliases)`,
    )
    .all() as { id: string; display_name: string }[];

  let written = 0;

  // Same reason as the address book pass: short locks beat one long one.
  const BATCH = 100;

  const work = db.transaction((batch: readonly { id: string; display_name: string }[]) => {
    for (const row of batch) {
      // Two words, both looking like a name.
      //
      // "Ubisoft Account Support" and "Episcopal Academy Alumni Society" are
      // not people, whatever the resolver decided, and generating diminutives
      // from them fills the alias table with words nobody would ever type.
      if (!isUsefulName(row.display_name) || !looksPersonal(row.display_name)) {
        continue;
      }

      written += setAliases(db, row.id, aliasesFor(row.display_name));
    }
  });

  for (let index = 0; index < rows.length; index += BATCH) {
    work(rows.slice(index, index + BATCH));
  }

  return written;
}

export function resolveEntities(db: DB, options: ResolveOptions = {}): ResolveReport {
  const started = Date.now();

  const self = ensureSelf(db, options.onNote);

  // Address book first. Its assertions are the strongest identity evidence
  // available, and running it before the correspondence pass means everything
  // afterwards attaches to already-merged, already-named entities.
  const contacts = linkContacts(db);

  if (contacts.merges > 0) {
    options.onNote?.(
      `address book merged ${String(contacts.merges)} entities that share no address`,
    );
  }

  if (contacts.phonesLinked > 0) {
    options.onNote?.(
      `${String(contacts.phonesLinked)} phone numbers linked, joining texts to people`,
    );
  }

  if (contacts.unanchored.length > 0) {
    options.onNote?.(
      `${String(contacts.unanchored.length)} cards have a name but no address or phone ` +
        `Harbor could read (${contacts.unanchored.slice(0, 3).join(", ")}...); ` +
        "run `harbor contacts` to see them",
    );
  }

  const total = Math.min(
    countPendingResolution(db, ENTITY_VERSION),
    options.limit ?? Number.MAX_SAFE_INTEGER,
  );

  let itemsResolved = 0;
  let entitiesCreated = 0;
  let linksWritten = 0;

  while (itemsResolved < total) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const items = pendingResolution(
      db,
      ENTITY_VERSION,
      Math.min(ITEM_BATCH, total - itemsResolved),
    );

    if (items.length === 0) {
      break;
    }

    const work = db.transaction(() => {
      for (const item of items) {
        clearItemLinks(db, item.id);

        for (const person of extract(item)) {
          const seenAt = item.occurredAt;
          let entity: Entity | null = null;

          if (person.email !== null) {
            entity = findByIdentifier(db, "email", person.email);

            if (entity === null) {
              const label =
                person.name !== null && isUsefulName(person.name) ? person.name : person.email;

              entity = createEntity(
                db,
                looksAutomated(person.email) ? "org" : "person",
                label,
                `email:${person.email}`,
              );
              entitiesCreated += 1;
            }

            upsertIdentifier(db, {
              entityId: entity.id,
              kind: "email",
              value: person.raw.includes("<") ? person.email : person.raw,
              normalized: person.email,
              confidence: 1,
              seenAt,
            });
          } else if (person.phone !== null) {
            // Same standing as an address. A phone number is stated by a source
            // and is not a guess, which is the whole test for an anchor.
            entity = findByIdentifier(db, "phone", person.phone);

            if (entity === null) {
              const label =
                person.name !== null && isUsefulName(person.name) ? person.name : person.phone;

              entity = createEntity(db, "person", label, `phone:${person.phone}`);
              entitiesCreated += 1;
            }

            upsertIdentifier(db, {
              entityId: entity.id,
              kind: "phone",
              value: person.raw,
              normalized: person.phone,
              confidence: 1,
              seenAt,
            });
          } else if (person.name !== null && isUsefulName(person.name)) {
            // A name with no address. It can only join an entity that some
            // address already anchored under exactly this name; otherwise it
            // gets its own, because guessing here is how two people merge.
            const normalized = normalizeName(person.name);
            entity = findByIdentifier(db, "name", normalized);

            if (entity === null) {
              entity = createEntity(db, "person", person.name, `name:${normalized}`);
              entitiesCreated += 1;
            }
          }

          if (entity === null) {
            continue;
          }

          const current = resolveEntity(db, entity.id);

          // Spam forging your own address in the From header attaches whatever
          // name it invented to the entity that owns that address, which is
          // you. Correct by the rules and useless in practice: `harbor person`
          // filled with "Tyrone Knight" and "Dental Implant Options". Names
          // only stick to `self` when they arrive from something authoritative,
          // which in practice means the address book.
          const nameAllowed = current === null || current.kind !== "self";

          if (person.name !== null && isUsefulName(person.name) && nameAllowed) {
            const normalized = normalizeName(person.name);

            upsertIdentifier(db, {
              entityId: entity.id,
              kind: "name",
              value: person.name,
              normalized,
              // Lower than an address: a name is a label, and its confidence
              // should say so anywhere this data is used to decide something.
              confidence: 0.6,
              seenAt,
            });

            // An address-anchored entity still labelled by its address gets a
            // real name the first time one shows up.
            if (current !== null && !current.pinned && current.displayName.includes("@")) {
              setDisplayName(db, current.id, person.name);
            }
          }

          const target = resolveEntity(db, entity.id);
          if (target !== null) {
            linkItem(db, item.id, target.id, person.role);
            linksWritten += 1;
          }
        }

        markResolved(db, item.id, ENTITY_VERSION);
      }
    });

    work();

    itemsResolved += items.length;
    options.onProgress?.(itemsResolved, total);
  }

  // Aliases for everyone the address book did not cover. A frequent
  // correspondent with a real name in their From header deserves the same
  // nickname handling as someone with a card.
  const extraAliases = backfillAliases(db);

  return {
    itemsResolved,
    entitiesCreated: entitiesCreated + contacts.entitiesCreated,
    linksWritten,
    selfAddresses: self.addresses,
    contactCards: contacts.cards,
    contactMerges: contacts.merges,
    aliases: contacts.aliasesWritten + extraAliases,
    version: ENTITY_VERSION,
    remaining: countPendingResolution(db, ENTITY_VERSION),
    durationMs: Date.now() - started,
  };
}
