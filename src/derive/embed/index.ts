/**
 * Embedder selection.
 *
 * HTTP by default, in-process only when asked for. One line to add a third.
 */
import { httpEmbedder } from "./http.js";
import { localEmbedder } from "./local.js";
import type { Embedder } from "./types.js";

export type { Embedder } from "./types.js";
export { cosine, fromBlob, normalize, toBlob } from "./types.js";

export async function createEmbedder(): Promise<Embedder> {
  const kind = process.env["HARBOR_EMBED"] ?? "http";

  if (kind === "local") {
    return await localEmbedder();
  }

  if (kind === "http") {
    return await httpEmbedder();
  }

  throw new Error(`Unknown HARBOR_EMBED value: ${kind}. Use "http" or "local".`);
}
