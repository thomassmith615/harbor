/**
 * Getting a JSON object out of whatever a model actually said.
 *
 * The naive version is `JSON.parse(response)`, and it worked in development
 * against a cloud model that had been asked nicely. On a real run against a
 * local model, 43 of 50 extractions failed with "response was not JSON" and no
 * purchase was ever recorded.
 *
 * The cause: the configured local model is a reasoning model. It emits a
 * `<think>` block before its answer, so every response began with prose and
 * parsing died on the first character. Nothing about that is exotic; most
 * capable small models released in the last year do it, several wrap output in
 * code fences whatever the prompt says, and some add a friendly sentence first.
 *
 * The lesson is not "use a better prompt". A model's job is to produce the
 * content and the caller's job is to find it, because the caller is the only
 * one of the two that can be relied upon. Prompting reduces how often this is
 * needed and never gets it to zero, and the failure mode when it does happen is
 * a silent empty result.
 *
 * This is deliberately not a JSON repair library. It removes known wrappers and
 * finds the outermost balanced object; if what is inside is malformed, that is a
 * real failure and it is reported as one. Guessing at broken JSON would mean
 * inventing purchase records, which is far worse than extracting none.
 */

/** Reasoning traces, in the forms models actually emit them. */
const THINKING = /<(think|thinking|reasoning|scratchpad)>[\s\S]*?<\/\1>/gi;

/** An unterminated reasoning block, which happens when output is truncated. */
const OPEN_THINKING = /<(think|thinking|reasoning|scratchpad)>[\s\S]*$/i;

export interface JsonRecovery {
  readonly value: unknown;
  /** What had to be stripped. Reported so a bad model choice is visible. */
  readonly repaired: readonly string[];
  readonly error: string | null;
}

/**
 * The outermost balanced `{...}`, respecting strings and escapes.
 *
 * Indexing to the first `{` and the last `}` is the obvious approach and it is
 * wrong: a brace inside a quoted merchant name ends the object early, and a
 * model that emits two objects yields a span containing both.
 */
function firstObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }

      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function recoverJson(raw: string): JsonRecovery {
  const repaired: string[] = [];
  let text = raw.trim();

  if (THINKING.test(text)) {
    text = text.replace(THINKING, "").trim();
    repaired.push("reasoning block");
  }

  // Reset, because a global regex carries lastIndex between calls and the next
  // extraction would silently skip the check.
  THINKING.lastIndex = 0;

  if (OPEN_THINKING.test(text) && !text.includes("{")) {
    return {
      value: null,
      repaired,
      error: "the model produced only a reasoning trace, with no answer",
    };
  }

  text = text.replace(OPEN_THINKING, "").trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);

  if (fenced?.[1] !== undefined) {
    text = fenced[1].trim();
    repaired.push("code fence");
  }

  if (text.length === 0) {
    return { value: null, repaired, error: "the model said nothing" };
  }

  try {
    return { value: JSON.parse(text), repaired, error: null };
  } catch {
    // Fall through: there is probably an object inside some prose.
  }

  const object = firstObject(text);

  if (object === null) {
    return {
      value: null,
      repaired,
      error: `no JSON object in the response: ${text.slice(0, 80)}`,
    };
  }

  repaired.push("surrounding prose");

  try {
    return { value: JSON.parse(object), repaired, error: null };
  } catch (error) {
    return {
      value: null,
      repaired,
      error: `found an object but it is malformed: ${
        error instanceof Error ? error.message.slice(0, 60) : "unknown"
      }`,
    };
  }
}
