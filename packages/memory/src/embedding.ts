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
    const output = await extractor(
      texts.map((text) => `${role}: ${text}`),
      { pooling: "mean", normalize: true },
    );
    return output.tolist();
  }
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
