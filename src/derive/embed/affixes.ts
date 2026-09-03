/**
 * Query and document prefixes.
 *
 * Most retrieval embedding models are asymmetric. They were trained with an
 * instruction on one side of the pair and not the other, and they expect that
 * instruction at inference time. `nomic-embed-text` requires `search_query:`
 * and `search_document:`; the BGE family wants an instruction on the query only
 * and nothing on the document; E5 wants `query:` and `passage:`.
 *
 * Harbor sent neither, anywhere, for either embedder. Every vector search ever
 * run embedded the question as though it were a stored document. That does not
 * fail loudly. It produces a working search that is quietly worse than the
 * model can do, which is the hardest kind of defect to notice from the outside
 * and the reason this is a table rather than a string constant: getting it
 * wrong for a new model should be a one-line correction, not an investigation.
 *
 * Matched on a substring of the model name because the same weights ship under
 * several names (`nomic-embed-text`, `nomic-embed-text:v1.5`,
 * `Xenova/bge-small-en-v1.5`, `BAAI/bge-small-en-v1.5`) and every one of them
 * wants the same treatment.
 *
 * An unrecognised model gets no prefix. That is the old behaviour, and it is
 * the right default: a symmetric model given a prefix is worse off, so the
 * failure mode of not knowing is a model performing as it did yesterday rather
 * than a model performing worse than it did yesterday.
 */

export interface Affixes {
  /** Prepended when embedding something being searched for. */
  readonly query: string;
  /** Prepended when embedding something being stored. */
  readonly document: string;
}

const NONE: Affixes = { query: "", document: "" };

interface Rule {
  readonly match: RegExp;
  readonly affixes: Affixes;
  readonly note: string;
}

const RULES: readonly Rule[] = [
  {
    // Nomic is the strictest of these: the prefixes are part of the training
    // objective rather than an optional instruction, and omitting them is a
    // measurable loss rather than a rounding error.
    match: /nomic-embed/i,
    affixes: { query: "search_query: ", document: "search_document: " },
    note: "nomic requires both sides to be labelled",
  },
  {
    // BGE English v1.5 takes an instruction on the query only. Prefixing the
    // document side as well is a documented mistake: the model was trained
    // with bare passages and an instructed passage embeds somewhere else.
    match: /bge-.*-(en|english)|bge-(small|base|large)/i,
    affixes: {
      query: "Represent this sentence for searching relevant passages: ",
      document: "",
    },
    note: "BGE instructs the query only",
  },
  {
    match: /(^|[^a-z])e5-|multilingual-e5|intfloat/i,
    affixes: { query: "query: ", document: "passage: " },
    note: "E5 labels both sides",
  },
  {
    // GTE and the OpenAI endpoints are symmetric and want nothing.
    match: /gte-|text-embedding-3|text-embedding-ada/i,
    affixes: NONE,
    note: "symmetric model, no prefix",
  },
];

export function affixesFor(model: string): Affixes {
  const override = process.env["HARBOR_EMBED_QUERY_PREFIX"];
  const documentOverride = process.env["HARBOR_EMBED_DOCUMENT_PREFIX"];

  if (override !== undefined || documentOverride !== undefined) {
    return { query: override ?? "", document: documentOverride ?? "" };
  }

  return RULES.find((rule) => rule.match.test(model))?.affixes ?? NONE;
}

/** Why a model got the prefixes it did. Reported by `harbor doctor`. */
export function affixNote(model: string): string {
  if (process.env["HARBOR_EMBED_QUERY_PREFIX"] !== undefined) {
    return "prefixes set by environment";
  }

  return RULES.find((rule) => rule.match.test(model))?.note ?? "unrecognised model, no prefix";
}

export function applyAffix(prefix: string, texts: readonly string[]): readonly string[] {
  if (prefix.length === 0) {
    return texts;
  }

  return texts.map((text) => `${prefix}${text}`);
}
