/**
 * In-process embedder, for machines with no local inference server.
 *
 * `@huggingface/transformers` is an optional dependency and is imported lazily,
 * so it costs nothing unless HARBOR_EMBED=local is set. It pulls ONNX Runtime
 * and downloads model weights on first use, which is exactly the kind of weight
 * the HTTP path exists to avoid. This is the fallback, not the default.
 */
import { ConfigurationError } from "../../kernel/errors.js";
import { normalize } from "./types.js";
import { affixesFor, applyAffix } from "./affixes.js";
import type { Embedder } from "./types.js";

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

interface FeatureExtractionOutput {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
}

type Pipeline = (
  texts: readonly string[],
  options: { pooling: string; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

export async function localEmbedder(model?: string): Promise<Embedder> {
  const name = model ?? process.env["HARBOR_EMBED_MODEL"] ?? DEFAULT_MODEL;

  let pipeline: Pipeline;

  try {
    // Dynamic specifier so TypeScript does not require the optional dependency
    // to be installed, and so a missing package is a runtime message rather
    // than a build failure.
    const specifier = "@huggingface/transformers";
    const transformers = (await import(specifier)) as {
      pipeline: (task: string, model: string) => Promise<Pipeline>;
    };
    pipeline = await transformers.pipeline("feature-extraction", name);
  } catch {
    throw new ConfigurationError(
      "The in-process embedder is not available",
      "Run `npm install @huggingface/transformers`, or leave HARBOR_EMBED unset " +
        "to use a local server over HTTP instead.",
    );
  }

  let dims = 0;

  async function embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    const output = await pipeline(texts, { pooling: "mean", normalize: true });

    const width = output.dims[output.dims.length - 1] ?? 0;
    dims = width;

    const vectors: Float32Array[] = [];

    for (let index = 0; index < texts.length; index += 1) {
      const start = index * width;
      const vector = new Float32Array(width);

      for (let offset = 0; offset < width; offset += 1) {
        vector[offset] = output.data[start + offset] ?? 0;
      }

      vectors.push(normalize(vector));
    }

    return vectors;
  }

  const probe = await embed(["harbor dimension probe"]);
  dims = probe[0]?.length ?? dims;

  const affixes = affixesFor(name);

  return {
    id: `local:${name}`,
    model: name,
    dims,
    embed: (texts) => embed(applyAffix(affixes.document, texts)),
    embedQuery: (texts) => embed(applyAffix(affixes.query, texts)),
  };
}
