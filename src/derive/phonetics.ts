/**
 * Matching names that are not spelled the same.
 *
 * Names are the one thing embeddings are actively bad at. In vector space
 * "Dave" sits near "David", which is right, and equally near "Dan" and "Dana",
 * which is not, and also near every use of "dave" as an ordinary word. A
 * similarity model trained on meaning has no reason to distinguish two people
 * with similar-sounding names, because for its purposes they are the same kind
 * of thing. Reaching for semantics here makes recall worse in exactly the way
 * that is hardest to debug: the wrong person, confidently.
 *
 * What actually works on names is older and duller. Two mechanisms, and they
 * fail differently on purpose.
 *
 * **Phonetic keys** catch names that sound alike and look nothing alike:
 * Caitlin and Kaitlyn, Shawn and Sean, Meyer and Maier. They are computed once
 * per entity and stored, so a lookup is an index hit rather than a scan over
 * every name in the store. That is the whole reason `name_keys` is a table: a
 * similarity function called at query time is O(entities) per query, and a
 * store with four thousand correspondents pays that on every message.
 *
 * **Edit distance** catches names that look alike and sound different, which is
 * mostly typing: Stephan for Stephen, Micheal for Michael, a dropped letter in
 * a handle. Jaro-Winkler rather than Levenshtein because it weights a common
 * prefix, and names that differ are usually names that differ early.
 *
 * Neither is allowed to conclude anything on its own. This file returns
 * candidates and a score; whether two names are one person stays with the
 * entity resolver, which has evidence these do not: a shared thread, a shared
 * address book entry, a shared number.
 */

/** Below this, two names are simply different names. */
export const NEAR_THRESHOLD = 0.88;

/**
 * A Double Metaphone approximation, English-first.
 *
 * Not the full Philips algorithm, which handles Slavic, Germanic and Romance
 * origin rules across several hundred branches. This covers the transformations
 * that account for nearly all English-language name confusion, and it is honest
 * about being a subset because the alternative was a dependency for one
 * function or six hundred lines that would never be reviewed.
 *
 * Returns a primary key and, where the name has a genuinely ambiguous
 * pronunciation, a secondary. Both are stored, so Sean matches Shawn from
 * either direction.
 */
export function metaphone(name: string): readonly string[] {
  const word = name
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

  if (word.length === 0) {
    return [];
  }

  const keys = new Set<string>();

  keys.add(encode(word));

  // Initial clusters where English pronunciation diverges from spelling. Each
  // one produces a second key rather than replacing the first, because the
  // spelling is evidence too: Knight is pronounced like Night and is not
  // usually the same person as somebody called Night.
  const alternates: readonly [RegExp, string][] = [
    [/^KN/, "N"],
    [/^GN/, "N"],
    [/^PN/, "N"],
    [/^WR/, "R"],
    [/^PS/, "S"],
    [/^X/, "S"],
    [/^WH/, "W"],
    [/^H/, ""],
    // Not anchored to the start. Sean and Shawn are the same name and the H is
    // the only thing between them, which the primary encoding turns into two
    // unrelated keys because SH is a distinct sound and S is not.
    [/SH/, "S"],
  ];

  for (const [pattern, replacement] of alternates) {
    if (pattern.test(word)) {
      keys.add(encode(word.replace(pattern, replacement)));
    }
  }

  return [...keys].filter((key) => key.length > 0);
}

function encode(word: string): string {
  let out = "";
  let index = 0;

  const at = (offset: number): string => word[offset] ?? "";

  while (index < word.length && out.length < 6) {
    const c = at(index);
    const next = at(index + 1);

    // A doubled consonant is one sound, except LL in Spanish-origin names,
    // which this does not attempt to detect.
    if (c === next && c !== "C") {
      index += 1;
      continue;
    }

    switch (c) {
      case "A":
      case "E":
      case "I":
      case "O":
      case "U":
      case "Y":
        // Vowels count only at the start. Inside a name they are the least
        // reliable part of the spelling and the part people get wrong.
        if (index === 0) {
          out += "A";
        }
        index += 1;
        break;

      case "B":
        out += "P";
        index += 1;
        break;

      case "C":
        if (next === "H") {
          out += "X";
          index += 2;
        } else if (next === "I" || next === "E" || next === "Y") {
          out += "S";
          index += 1;
        } else if (next === "K") {
          out += "K";
          index += 2;
        } else {
          out += "K";
          index += 1;
        }
        break;

      case "D":
        if (next === "G") {
          out += "J";
          index += 2;
        } else {
          out += "T";
          index += 1;
        }
        break;

      case "G":
        if (next === "H") {
          // Silent in Hugh, Vaughan, Callaghan.
          index += 2;
        } else if (next === "N") {
          out += "N";
          index += 2;
        } else if (next === "E" || next === "I" || next === "Y") {
          out += "J";
          index += 1;
        } else {
          out += "K";
          index += 1;
        }
        break;

      case "P":
        if (next === "H") {
          out += "F";
          index += 2;
        } else {
          out += "P";
          index += 1;
        }
        break;

      case "Q":
        out += "K";
        index += 1;
        break;

      case "S":
        if (next === "H") {
          out += "X";
          index += 2;
        } else {
          out += "S";
          index += 1;
        }
        break;

      case "T":
        if (next === "H") {
          out += "0";
          index += 2;
        } else if (next === "I" && (at(index + 2) === "O" || at(index + 2) === "A")) {
          out += "X";
          index += 1;
        } else {
          out += "T";
          index += 1;
        }
        break;

      case "V":
        out += "F";
        index += 1;
        break;

      case "W":
      case "H":
        // Kept only before a vowel; silent otherwise.
        if (isVowel(next)) {
          out += c;
        }
        index += 1;
        break;

      case "X":
        out += "KS";
        index += 1;
        break;

      case "Z":
        out += "S";
        index += 1;
        break;

      case "K":
        out += "K";
        index += 1;
        break;

      default:
        out += c;
        index += 1;
        break;
    }
  }

  return out.slice(0, 6);
}

function isVowel(character: string): boolean {
  return character === "A" || character === "E" || character === "I" || character === "O" || character === "U";
}

/**
 * Jaro-Winkler similarity, 0 to 1.
 *
 * Chosen over Levenshtein because it rewards a shared prefix, and names that
 * are different names usually differ near the beginning while names that are
 * typos of each other usually differ near the end.
 */
export function similarity(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();

  if (left === right) {
    return 1;
  }

  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);

  const leftMatched = new Array<boolean>(left.length).fill(false);
  const rightMatched = new Array<boolean>(right.length).fill(false);

  let matches = 0;

  for (let index = 0; index < left.length; index += 1) {
    const from = Math.max(0, index - window);
    const to = Math.min(index + window + 1, right.length);

    for (let other = from; other < to; other += 1) {
      if (rightMatched[other] === true || left[index] !== right[other]) {
        continue;
      }

      leftMatched[index] = true;
      rightMatched[other] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) {
    return 0;
  }

  let transpositions = 0;
  let cursor = 0;

  for (let index = 0; index < left.length; index += 1) {
    if (leftMatched[index] !== true) {
      continue;
    }

    while (rightMatched[cursor] !== true) {
      cursor += 1;
    }

    if (left[index] !== right[cursor]) {
      transpositions += 1;
    }

    cursor += 1;
  }

  const jaro =
    (matches / left.length + matches / right.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler's prefix bonus, capped at four characters as in the original.
  let prefix = 0;

  while (prefix < 4 && prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Whether two names are close enough to be worth asking about.
 *
 * Both mechanisms, either sufficient. A name that sounds the same and a name
 * that is one keystroke away are both worth a look, and requiring both would
 * reject Caitlin against Kaitlyn (different spellings) and Stephen against
 * Stephan (different sounds) at the same time.
 */
export function near(a: string, b: string): boolean {
  if (similarity(a, b) >= NEAR_THRESHOLD) {
    return true;
  }

  const left = metaphone(a);
  const right = metaphone(b);

  // A single-syllable key is short enough to collide with half the alphabet,
  // so a phonetic match on its own needs the names to be plausibly the same
  // length as well.
  if (left.some((key) => key.length >= 3 && right.includes(key))) {
    return Math.abs(a.length - b.length) <= 3;
  }

  return false;
}
