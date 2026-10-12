// EmbeddingProvider (M5.7). Implementação local com transformers.js — ver
// docs/adr/0004-embeddings-locais.md. O modelo é baixado uma vez para
// ~/.apo/models e roda no próprio processo do daemon (ONNX, sem GPU).

import { createHash } from "node:crypto";

export type EmbeddingRole = "query" | "passage";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[], role: EmbeddingRole): Promise<number[][]>;
}

export const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  private extractor: Promise<Extractor> | undefined;

  constructor(private readonly options: { cacheDir: string; model?: string }) {}

  get id(): string {
    return this.options.model ?? DEFAULT_EMBEDDING_MODEL;
  }

  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      const transformers = await import("@huggingface/transformers");
      transformers.env.cacheDir = this.options.cacheDir;
      return (await transformers.pipeline("feature-extraction", this.id, {
        dtype: "q8",
      })) as unknown as Extractor;
    })();
    return this.extractor;
  }

  async embed(texts: string[], role: EmbeddingRole): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    // O e5 foi treinado com prefixo de papel ("query:" / "passage:").
    return embedInBatches(texts, EMBED_BATCH_SIZE, async (batch) => {
      const output = await extractor(
        batch.map((text) => `${role}: ${text}`),
        { pooling: "mean", normalize: true },
      );
      return output.tolist();
    });
  }
}

/**
 * Tamanho do lote enviado ao modelo. A memória do ONNX cresce com o lote: 196
 * trechos de uma vez levaram o daemon a ~9 GB na VM (achado de 2026-10-12).
 */
export const EMBED_BATCH_SIZE = 16;

/** Embeda em lotes sequenciais, preservando a ordem. */
export async function embedInBatches(
  texts: string[],
  size: number,
  embedBatch: (batch: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += size) {
    vectors.push(...(await embedBatch(texts.slice(start, start + size))));
  }
  return vectors;
}

/**
 * Determinístico e sem modelo: bag-of-words com hashing, normalizado. Só para
 * testes — aproxima por palavras em comum, sem semântica.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly id = "hashing-test";
  readonly dimensions = 384;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (const word of text
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .match(/[a-z0-9]{3,}/g) ?? []) {
        const bucket = createHash("sha1").update(word).digest().readUInt32BE(0) % this.dimensions;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    });
  }
}
