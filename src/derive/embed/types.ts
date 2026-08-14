/**
 * The embedder contract.
 *
 * Same rule as the reasoning provider: nothing outside this directory names a
 * model or an endpoint. Which embedder is in use is configuration.
 *
 * The default implementation talks HTTP to a local server (Ollama, llama.cpp,
 * LM Studio) rather than running inference in-process. That is the same
 * decision the architecture makes everywhere else: local inference is a
 * process boundary, and the boundary is HTTP. It keeps Harbor's dependency
 * tree small, lets the embedding model be swapped without touching Node, and
 * means the M8 routing ladder inherits a working local-model path instead of
 * inventing one.
 *
 * An in-process implementation exists for machines with no local server. It is
 * a lazy import of an optional dependency, so it costs nothing until used.
 */

export interface Embedder {
  readonly id: string;
  readonly model: string;
  readonly dims: number;

  /**
   * Embeds a batch. Returns one vector per input, in order.
   *
   * Batching is the caller's lever for throughput; implementations should send
   * the batch as one request where the backend supports it.
   */
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

/** Cosine similarity. Vectors are normalized on write, so this is a dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;

  for (let index = 0; index < length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }

  return sum;
}

/**
 * Normalizes in place and returns the same array.
 *
 * Storing unit vectors means similarity is a dot product everywhere, and it
 * means sqlite-vec's L2 distance ranks identically to cosine, so the index and
 * the fallback scan agree on ordering.
 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;

  for (const value of vector) {
    sum += value * value;
  }

  const magnitude = Math.sqrt(sum);

  if (magnitude === 0) {
    return vector;
  }

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / magnitude;
  }

  return vector;
}

export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  // Copy rather than view: better-sqlite3 buffers are not guaranteed aligned,
  // and a misaligned Float32Array view throws.
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
