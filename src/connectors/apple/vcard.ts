/**
 * vCard parsing.
 *
 * Same folding rules as iCalendar, a smaller property set, and one wrinkle
 * neither shares: vCard 2.1 allows quoted-printable encoding on values, which
 * iCloud still emits for cards imported from old sources.
 *
 * What matters downstream is not the card itself but the fact that a card
 * asserts several addresses belong to one person. That is the strongest
 * identity signal Harbor can get, because a human typed it deliberately.
 */
import { parseLine, unescapeText, unfold } from "./ical.js";

export interface VCard {
  readonly uid: string;
  readonly fullName: string | null;
  /** A stated nickname outranks anything derivable from the full name. */
  readonly nickname: string | null;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly organization: string | null;
  readonly note: string | null;
  readonly revision: string | null;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "=" && index + 2 < value.length) {
      const hex = value.slice(index + 1, index + 3);

      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }

    bytes.push(value.charCodeAt(index));
  }

  return Buffer.from(bytes).toString("utf8");
}

export function parseCards(source: string): readonly VCard[] {
  const cards: VCard[] = [];
  let current: Map<string, string[]> | null = null;

  for (const line of unfold(source)) {
    const property = parseLine(line);

    if (property === null) {
      continue;
    }

    if (property.name === "BEGIN" && property.value.toUpperCase() === "VCARD") {
      current = new Map();
      continue;
    }

    if (property.name === "END" && property.value.toUpperCase() === "VCARD") {
      if (current !== null) {
        cards.push(materialize(current));
      }
      current = null;
      continue;
    }

    if (current === null) {
      continue;
    }

    // Apple groups related properties, and the group is part of the name.
    //
    // A card with a labelled phone number is written as `item1.TEL:+1555...`
    // followed by `item1.X-ABLabel:_$!<Mobile>!$_`, and looking up "TEL" finds
    // nothing because the property is called "ITEM1.TEL". Every contact with a
    // labelled number or address, which on a real address book is most of them,
    // came through with no identifiers at all and was silently skipped.
    const name = property.name.replace(/^[A-Z0-9]+\./, "");

    const encoding = (property.params["ENCODING"] ?? "").toUpperCase();
    const raw =
      encoding === "QUOTED-PRINTABLE" ? decodeQuotedPrintable(property.value) : property.value;

    const existing = current.get(name) ?? [];
    existing.push(unescapeText(raw));
    current.set(name, existing);
  }

  return cards;
}

function materialize(properties: Map<string, string[]>): VCard {
  const first = (name: string): string | null => properties.get(name)?.[0] ?? null;

  // N is structured: family;given;middle;prefix;suffix. Only used when there is
  // no FN, which is rare but happens on imported cards.
  const structured = first("N");
  const derived =
    structured === null
      ? null
      : (() => {
          const [family, given] = structured.split(";");
          return [given, family].filter((part) => (part ?? "").length > 0).join(" ").trim();
        })();

  const fullName = first("FN") ?? (derived !== null && derived.length > 0 ? derived : null);

  return {
    uid: first("UID") ?? "",
    fullName,
    nickname: first("NICKNAME"),
    emails: (properties.get("EMAIL") ?? [])
      .map((value) => value.trim().toLowerCase().replace(/^mailto:/i, ""))
      .filter((value) => value.includes("@")),
    // vCard 4 writes numbers as a `tel:` URI; vCard 3 writes them bare. Both
    // reduce to the same digits, so the prefix is simply dropped.
    phones: (properties.get("TEL") ?? []).map((value) =>
      value.trim().replace(/^tel:/i, ""),
    ),
    organization: (first("ORG") ?? "").split(";")[0]?.trim() || null,
    note: first("NOTE"),
    revision: first("REV"),
  };
}
