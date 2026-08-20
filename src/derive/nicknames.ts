/**
 * Nicknames.
 *
 * A card says "Esperanza Duprée". Nobody types that. They type "essy", and until
 * now that found nothing, so the user learned to type full names, which is the
 * kind of small failure that quietly teaches people the tool is dumb.
 *
 * The important architectural point is that these are **not identities**. A
 * derived nickname is a guess, two people can plausibly share one, and an
 * identifier row could not represent that without one silently swallowing the
 * other. So aliases live in their own table, have no uniqueness, widen lookup,
 * and never merge anything. When "essy" matches two people, the answer is to
 * ask which, not to pick.
 */

/**
 * Diminutives that no rule produces.
 *
 * English nicknames are mostly regular and occasionally historical. No
 * generator gets Bob from Robert or Peggy from Margaret; those came through
 * rhyming shifts centuries ago. A short table covers them, and the rules below
 * cover everything else.
 */
const IRREGULAR: Readonly<Record<string, readonly string[]>> = {
  robert: ["bob", "bobby", "rob", "robbie"],
  richard: ["dick", "rick", "ricky", "rich"],
  william: ["bill", "billy", "will", "willy"],
  margaret: ["peggy", "maggie", "meg", "greta"],
  john: ["jack", "johnny"],
  james: ["jim", "jimmy", "jamie"],
  charles: ["chuck", "charlie", "chas"],
  henry: ["hank", "harry"],
  edward: ["ted", "teddy", "ned", "eddie"],
  elizabeth: ["liz", "beth", "betsy", "eliza", "libby", "lizzie"],
  sarah: ["sally"],
  mary: ["molly", "polly"],
  anne: ["nancy", "annie"],
  ann: ["nancy", "annie"],
  katherine: ["kate", "katie", "kitty", "kay"],
  catherine: ["kate", "katie", "kitty", "kay"],
  theodore: ["ted", "teddy", "theo"],
  joseph: ["joe", "joey"],
  michael: ["mike", "mickey", "mick"],
  patrick: ["pat", "paddy", "rick"],
  daniel: ["dan", "danny"],
  alex: ["tom", "tommy"],
  christopher: ["chris", "kit", "topher"],
  nicholas: ["nick", "nicky", "cole"],
  alexander: ["alex", "xander", "sasha", "lex"],
  alexandra: ["alex", "sasha", "lexi"],
  jonathan: ["jon", "johnny", "nate"],
  francis: ["frank", "frankie"],
  frances: ["fran", "franny"],
  esperanza: ["bella", "belle", "isa"],
  isabel: ["bella", "belle", "isa"],
  eleanor: ["nell", "ellie", "nora"],
  virginia: ["ginny", "ginger"],
  barbara: ["barb", "babs"],
  deborah: ["deb", "debbie"],
  jennifer: ["jen", "jenny"],
  jessica: ["jess", "jessie"],
  rebecca: ["becky", "becca", "bex"],
  samantha: ["sam", "sammy"],
  stephanie: ["steph", "stevie"],
  victoria: ["vicky", "tori", "vic"],
  benjamin: ["ben", "benny"],
  gregory: ["greg"],
  matthew: ["matt", "matty"],
  andrew: ["andy", "drew"],
  anthony: ["tony"],
  timothy: ["tim", "timmy"],
  zachary: ["zach", "zack"],
};

const SUFFIXES = ["y", "ie", "i", "s"] as const;

/**
 * Removes accents so "Duprée" and "Dupree" are the same word.
 *
 * Search that fails on a diacritic is search that fails on exactly the names
 * people are least likely to type carefully.
 */
export function fold(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Shortened forms of one given name.
 *
 * The generative half. Take the first two to four letters, optionally double
 * the final consonant, add a diminutive ending. That is where "Essy" comes from:
 * Esperanza cut to "Is", doubled to "Iss", plus "y".
 *
 * It over-generates on purpose. An alias that nobody ever types costs one row;
 * a missing one costs a failed search and a person concluding it does not work.
 */
function shortForms(name: string): readonly string[] {
  const clean = fold(name).replace(/[^a-z]/g, "");

  if (clean.length < 3) {
    return [];
  }

  const found = new Set<string>();

  // Two-letter stems are kept, but only when they double.
  //
  // This is the Essy case, and it is the whole reason the rule exists. Esperanza
  // cut to "Is" and doubled gives "Iss", plus a diminutive ending gives "Essy",
  // which is what someone actually types. Dropping two-letter stems entirely
  // loses that; keeping their bare form ("is", "ma") produces fragments nobody
  // says. So: doubled forms from two letters, everything from three or more.
  for (const stem of [clean.slice(0, 2), clean.slice(0, 3), clean.slice(0, 4)]) {
    if (stem.length < 2) {
      continue;
    }

    const short = stem.length === 2;
    const last = stem[stem.length - 1] ?? "";
    const doublable = /[bcdfglmnprstz]/.test(last);
    const doubled = doublable ? `${stem}${last}` : stem;

    if (!short) {
      found.add(stem);
    }

    for (const suffix of SUFFIXES) {
      if (!short) {
        found.add(`${stem}${suffix}`);
      }

      if (doublable) {
        found.add(`${doubled}${suffix}`);
      }
    }

    if (doublable) {
      found.add(doubled);
    }

    // An "s" that doubles usually takes the z sound in speech: Esperanza gives
    // Ezzy far more often than Essy, and both are worth having.
    if (last === "s") {
      const zed = `${stem.slice(0, -1)}zz`;
      found.add(zed);

      for (const suffix of SUFFIXES) {
        found.add(`${zed}${suffix}`);
      }
    }
  }

  // Anything at or beyond the full name is not a nickname.
  return [...found].filter((entry) => entry.length >= 2 && entry.length < clean.length);
}

export interface Alias {
  readonly alias: string;
  readonly origin: "given" | "family" | "derived" | "vcard";
}

/**
 * Every way a person might be referred to.
 *
 * `explicit` is anything the address book stated outright, which outranks
 * everything derived and is never filtered.
 */
export function aliasesFor(fullName: string, explicit: readonly string[] = []): readonly Alias[] {
  const found = new Map<string, Alias>();

  const add = (alias: string, origin: Alias["origin"]): void => {
    const normalized = fold(alias);

    if (normalized.length < 2 || normalized.length > 40) {
      return;
    }

    // First writer wins, so a stated nickname is never downgraded to derived.
    if (!found.has(normalized)) {
      found.set(normalized, { alias: normalized, origin });
    }
  };

  for (const stated of explicit) {
    add(stated, "vcard");
  }

  const parts = fold(fullName)
    .split(/[\s,]+/)
    .filter((part) => part.length > 0);

  const given = parts[0];
  const family = parts.length > 1 ? parts[parts.length - 1] : undefined;

  if (given !== undefined) {
    add(given, "given");

    for (const nickname of IRREGULAR[given] ?? []) {
      add(nickname, "derived");
    }

    for (const short of shortForms(given)) {
      add(short, "derived");
    }
  }

  if (family !== undefined && family !== given) {
    // Surnames get the bare form only. "Smitty" from Smith is a stretch, and
    // surname-derived diminutives collide far more than given-name ones.
    add(family, "family");
  }

  // Middle names get nothing: nobody refers to a person by their middle name,
  // and generating from them is how an alias table fills with noise.
  return [...found.values()];
}

/**
 * E.164, so a number is one string however it was typed.
 *
 * iMessage always writes +15551234567; a vCard writes whatever the person
 * typed, which is usually (610) 555-0134. Without this they are two identities
 * and a contact card can never join a text thread to a person.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) {
    const rest = digits.slice(1).replace(/\D/g, "");
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : null;
  }

  const bare = digits.replace(/\D/g, "");

  if (bare.length === 10) {
    // Defaulting to +1 is a North American assumption and it is the right one
    // for a store whose other number formats all come from a US-centric source.
    return `+1${bare}`;
  }

  if (bare.length === 11 && bare.startsWith("1")) {
    return `+${bare}`;
  }

  return bare.length >= 8 && bare.length <= 15 ? `+${bare}` : null;
}

/** Does this look like a phone number rather than a name or an address? */
export function looksLikePhone(input: string): boolean {
  const trimmed = input.trim();

  if (trimmed.includes("@")) {
    return false;
  }

  return /^\+?[\d\s().-]{8,20}$/.test(trimmed) && normalizePhone(trimmed) !== null;
}
