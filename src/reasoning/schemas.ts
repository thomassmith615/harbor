/**
 * Output schemas, and why they are declared rather than hoped for.
 *
 * Harbor already declares `verification: "schema"` on its structured task
 * classes, and until now that meant *checking* the output after generation.
 * Checking is a filter: a malformed reply is discarded, the work is lost, and
 * the pass records nothing. `json.ts` exists entirely to salvage what it can
 * from replies that came back wrong, which is a well-built machine for a
 * problem that should not exist.
 *
 * Every local inference server can be told the shape up front. llama.cpp takes
 * a GBNF grammar, Ollama takes a JSON schema in `format`, and both then sample
 * only from tokens that keep the output valid. A malformed reply stops being
 * something to handle and becomes something the sampler cannot emit.
 *
 * The practical consequence is larger than it sounds. A 4B model with
 * constrained decoding beats a much bigger one without it at this particular
 * job, because the failure being eliminated is not a reasoning failure. It is a
 * formatting failure, and formatting is exactly what a grammar is for. It also
 * removes the reason `extract.structured` has been quietly escalating: a task
 * that fails schema verification climbs the ladder, so every unparseable reply
 * from a local model was being paid for twice.
 *
 * Schemas live here rather than beside their callers so that the provider can
 * reach them without importing half of `derive/`, and so that a task class and
 * its shape are looked up the same way.
 *
 * Deliberately loose about optional fields. A schema tight enough to forbid a
 * model from omitting something it does not know will make it invent one, and
 * an invented confirmation code is worse than a missing one.
 */

export interface JsonSchema {
  readonly type: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly items?: unknown;
  readonly additionalProperties?: boolean;
  readonly [key: string]: unknown;
}

const NULLABLE_STRING = { type: ["string", "null"] };

/**
 * What `plans.ts` asks for.
 *
 * `going[].quote` is required and that is the load-bearing part of this file. A
 * roster entry without the words it came from cannot be verified against the
 * transcript, and an unverifiable roster is a false statement about who is
 * going out tonight rather than a slightly worse one. Requiring it in the
 * grammar means the model cannot produce a name without also committing to
 * where it read it.
 */
const PLAN: JsonSchema = {
  type: "object",
  properties: {
    plan: {
      type: ["object", "null"],
      properties: {
        proposal: { type: "string" },
        venue: NULLABLE_STRING,
        time: NULLABLE_STRING,
        going: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              quote: { type: "string" },
            },
            required: ["name", "quote"],
          },
        },
      },
      required: ["proposal", "going"],
    },
  },
  required: ["plan"],
};

/**
 * A sensitivity verdict.
 *
 * The narrowest schema here, and the one where constraint pays best: the whole
 * output is one label from a closed set, and an unconstrained small model
 * writes a paragraph explaining its reasoning about half the time.
 */
const SENSITIVITY: JsonSchema = {
  type: "object",
  properties: {
    sensitivity: { type: "string", enum: ["none", "low", "medium", "high"] },
    reason: { type: "string" },
  },
  required: ["sensitivity"],
};

/**
 * The generic structured-extraction envelope.
 *
 * `extract.structured` covers several callers with different record shapes, so
 * this constrains the envelope and not the records. Partial constraint is worth
 * having: it eliminates the prose-around-the-JSON failure, which is the
 * majority of what `json.ts` currently repairs, without pretending one shape
 * fits purchases and plans alike.
 *
 * A caller with a specific shape passes it explicitly. See `route`.
 */
const RECORDS: JsonSchema = {
  type: "object",
  properties: {
    records: { type: "array", items: { type: "object" } },
  },
  required: ["records"],
};

const BY_TASK: Readonly<Record<string, JsonSchema>> = {
  "classify.sensitivity": SENSITIVITY,
  "extract.records": RECORDS,
  "extract.plan": PLAN,
};

export function schemaFor(id: string): JsonSchema | undefined {
  return BY_TASK[id];
}

/**
 * A GBNF grammar for the same shape, for servers that take a grammar instead.
 *
 * llama.cpp's server accepts `json_schema` on recent builds and `grammar` on
 * older ones, and there is no reliable way to tell which is in front of you
 * without asking. Both are sent; a server ignores the one it does not know.
 *
 * This is a deliberately small subset: objects, arrays, strings, and the null
 * union that appears throughout the schemas above. A general JSON Schema to
 * GBNF compiler is a real piece of work and llama.cpp ships one, so building a
 * second here would be duplicating a dependency's job in order to avoid a
 * dependency.
 */
export function grammarFor(schema: JsonSchema): string | undefined {
  void schema;

  // Intentionally not implemented. `json_schema` covers Ollama and current
  // llama.cpp; an older llama.cpp falls back to the post-hoc repair in
  // `json.ts`, which is exactly where it was before this file existed.
  return undefined;
}
