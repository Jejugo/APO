// Persistência e busca (M5.6/M5.8/M5.9). Ingestão idempotente: um chunk é
// identificado por (project, source, content_hash) — o que não mudou não é
// reembeddado; o que sumiu do arquivo é apagado.

import { randomUUID } from "node:crypto";
import { type Db, schema } from "@apo/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Chunk } from "./chunking.js";
import type { EmbeddingProvider } from "./embedding.js";

const { memories } = schema;

export const MEMORY_KINDS = [
  "doc",
  "convention",
  "decision",
  "pattern",
  "failure",
  "correction",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface RetrievedMemory {
  id: string;
  kind: string;
  source: string;
  title: string;
  content: string;
  similarity: number;
}

export interface SourceSync {
  inserted: number;
  kept: number;
  removed: number;
}

export class MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  /** Faz o conteúdo de `source` no banco ser exatamente `chunks`. */
  async syncSource(
    projectId: string,
    source: string,
    kind: MemoryKind,
    chunks: Chunk[],
  ): Promise<SourceSync> {
    const unique = [...new Map(chunks.map((chunk) => [chunk.contentHash, chunk])).values()];
    const hashes = unique.map((chunk) => chunk.contentHash);
    const removed = await this.db
      .delete(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          eq(memories.source, source),
          ...(hashes.length > 0 ? [notInArray(memories.contentHash, hashes)] : []),
        ),
      )
      .returning({ id: memories.id });

    const existing = hashes.length
      ? await this.db
          .select({ contentHash: memories.contentHash })
          .from(memories)
          .where(
            and(
              eq(memories.projectId, projectId),
              eq(memories.source, source),
              inArray(memories.contentHash, hashes),
            ),
          )
      : [];
    const have = new Set(existing.map((row) => row.contentHash));
    const missing = unique.filter((chunk) => !have.has(chunk.contentHash));
    if (missing.length > 0) {
      const vectors = await this.embeddings.embed(
        missing.map((chunk) => `${chunk.title}\n${chunk.content}`),
        "passage",
      );
      await this.db
        .insert(memories)
        .values(
          missing.map((chunk, index) => ({
            id: randomUUID(),
            projectId,
            kind,
            source,
            title: chunk.title,
            content: chunk.content,
            contentHash: chunk.contentHash,
            embedding: vectors[index] as number[],
            embeddingModel: this.embeddings.id,
          })),
        )
        .onConflictDoNothing();
    }
    return { inserted: missing.length, kept: have.size, removed: removed.length };
  }

  /** Apaga memórias de documentos que não existem mais no repo. */
  async pruneSources(projectId: string, kind: MemoryKind, keepSources: string[]): Promise<number> {
    const removed = await this.db
      .delete(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          eq(memories.kind, kind),
          ...(keepSources.length > 0 ? [notInArray(memories.source, keepSources)] : []),
        ),
      )
      .returning({ id: memories.id });
    return removed.length;
  }

  async search(projectId: string, query: string, limit: number): Promise<RetrievedMemory[]> {
    const [vector] = await this.embeddings.embed([query], "query");
    if (!vector) return [];
    const literal = `[${vector.join(",")}]`;
    const distance = sql<number>`${memories.embedding} <=> ${literal}::vector`;
    const rows = await this.db
      .select({
        id: memories.id,
        kind: memories.kind,
        source: memories.source,
        title: memories.title,
        content: memories.content,
        distance,
      })
      .from(memories)
      .where(eq(memories.projectId, projectId))
      .orderBy(distance)
      .limit(limit);
    return rows.map(({ distance: value, ...row }) => ({ ...row, similarity: 1 - Number(value) }));
  }

  async list(projectId: string, kind?: string) {
    return this.db
      .select({
        id: memories.id,
        kind: memories.kind,
        source: memories.source,
        title: memories.title,
        content: memories.content,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .where(and(eq(memories.projectId, projectId), ...(kind ? [eq(memories.kind, kind)] : [])))
      .orderBy(memories.kind, memories.source, memories.title);
  }

  async remove(projectId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(memories)
      .where(and(eq(memories.projectId, projectId), eq(memories.id, id)))
      .returning({ id: memories.id });
    return rows.length > 0;
  }
}
