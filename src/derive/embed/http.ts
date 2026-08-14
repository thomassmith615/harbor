/**
 * HTTP embedder.
 *
 * Speaks the OpenAI `/v1/embeddings` shape, which Ollama, llama.cpp's server,
 * LM Studio, and every hosted provider all implement. That one wire format is
 * why this is the default: the model becomes a config line rather than a
 * dependency.
 *
 * Ollama, which is the expected setup on a Mac:
 *
 *   brew install ollama
 *   ollama pull nomic-embed-text
 *
 * Then nothing else needs configuring; the defaults below point at it.
 */
import { ConfigurationError, UpstreamError } from "../../kernel/errors.js";
import { normalize } from "./types.js";
import type { Embedder } from "./types.js";

const DEFAULT_URL = "http://127.0.0.1:11434/v1/embeddings";
const DEFAULT_MODEL = "nomic-embed-text";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface EmbeddingResponse {
  readonly data: readonly { readonly index: number; readonly embedding: readonly number[] }[];
  readonly model?: string;
}

export interface HttpEmbedderOptions {
  readonly url?: string;
  readonly model?: string;
  readonly apiKey?: string | undefined;
  /** Known ahead of time avoids a probe request. Detected on first use if absent. */
  readonly dims?: number;
}

export async function httpEmbedder(options: HttpEmbedderOptions = {}): Promise<Embedder> {
  const url = options.url ?? process.env["HARBOR_EMBED_URL"] ?? DEFAULT_URL;
  const model = options.model ?? process.env["HARBOR_EMBED_MODEL"] ?? DEFAULT_MODEL;
  const apiKey = options.apiKey ?? process.env["HARBOR_EMBED_KEY"];

  async function request(texts: readonly string[]): Promise<readonly Float32Array[]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
          },
          body: JSON.stringify({ model, input: texts }),
        });
      } catch (cause: unknown) {
        lastError = cause;

        if (attempt === MAX_ATTEMPTS) {
          throw new ConfigurationError(
            `Could not reach the embedding server at ${url}`,
            "Start a local server (`ollama serve`) or set HARBOR_EMBED_URL. " +
              "To embed in-process instead, set HARBOR_EMBED=local.",
          );
        }

        await sleep(2 ** attempt * 250);
        continue;
      }

      if (response.ok) {
        const parsed = (await response.json()) as EmbeddingResponse;

        // Providers are allowed to return out of order; `index` is authoritative.
        const vectors = new Array<Float32Array>(texts.length);

        for (const entry of parsed.data) {
          vectors[entry.index] = normalize(Float32Array.from(entry.embedding));
        }

        for (let index = 0; index < vectors.length; index += 1) {
          if (vectors[index] === undefined) {
            throw new UpstreamError(
              `Embedding server returned ${String(parsed.data.length)} vectors for ${String(texts.length)} inputs`,
            );
          }
        }

        return vectors as readonly Float32Array[];
      }

      const body = await response.text();

      if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * 400);
        continue;
      }

      throw new UpstreamError(
        `Embedding server returned ${String(response.status)}: ${body}`,
        {
          status: response.status,
          hint:
            response.status === 404
              ? `Model "${model}" may not be pulled. Try \`ollama pull ${model}\`.`
              : undefined,
        },
      );
    }

    throw new UpstreamError("Embedding request failed", { cause: lastError });
  }

  // One probe so `dims` is known before anything is written. Getting this wrong
  // means a vector index built at the wrong width, which fails obscurely later.
  const dims =
    options.dims ?? (await request(["harbor dimension probe"]))[0]?.length ?? 0;

  if (dims === 0) {
    throw new UpstreamError("Embedding server returned an empty vector");
  }

  return {
    id: `http:${url}`,
    model,
    dims,
    embed: request,
  };
}
