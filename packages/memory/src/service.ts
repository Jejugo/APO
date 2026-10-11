// MemoryService — fachada usada pelo daemon e pelo graph (M5.8–M5.10).

import { hashChunk } from "./chunking.js";
import { collectProjectDocs } from "./ingest.js";
import type { MemoryKind, MemoryStore, RetrievedMemory } from "./store.js";

export interface IngestReport {
  files: number;
  inserted: number;
  kept: number;
  removed: number;
}

export interface RetrieveOptions {
  limit?: number;
  /** Teto de caracteres do bloco que vai para o prompt (≈ tokens × 4). */
  maxChars?: number;
  minSimilarity?: number;
}

export interface MemoryItem {
  kind: MemoryKind;
  title: string;
  content: string;
}

export class MemoryService {
  constructor(private readonly store: MemoryStore) {}

  async ingestProject(projectId: string, repoPath: string): Promise<IngestReport> {
    const docs = await collectProjectDocs(repoPath);
    const report: IngestReport = { files: docs.size, inserted: 0, kept: 0, removed: 0 };
    for (const [source, chunks] of docs) {
      const sync = await this.store.syncSource(projectId, source, "doc", chunks);
      report.inserted += sync.inserted;
      report.kept += sync.kept;
      report.removed += sync.removed;
    }
    report.removed += await this.store.pruneSources(projectId, "doc", [...docs.keys()]);
    return report;
  }

  /** Top-k por similaridade, cortado no orçamento de caracteres. */
  async retrieve(
    projectId: string,
    query: string,
    options: RetrieveOptions = {},
  ): Promise<RetrievedMemory[]> {
    const limit = options.limit ?? 6;
    const maxChars = options.maxChars ?? 6000;
    const minSimilarity = options.minSimilarity ?? 0;
    const found = await this.store.search(projectId, query, limit);
    const picked: RetrievedMemory[] = [];
    let used = 0;
    for (const memory of found) {
      if (memory.similarity < minSimilarity) continue;
      const size = memory.title.length + memory.content.length;
      if (used + size > maxChars) continue;
      picked.push(memory);
      used += size;
    }
    return picked;
  }

  /** Memórias destiladas de uma Feature (M5.10) ou registradas à mão. */
  async remember(projectId: string, source: string, items: MemoryItem[]): Promise<number> {
    let inserted = 0;
    for (const kind of new Set(items.map((item) => item.kind))) {
      const chunks = items
        .filter((item) => item.kind === kind)
        .map((item) => ({
          title: item.title,
          content: item.content,
          contentHash: hashChunk(item.title, item.content),
        }));
      inserted += (await this.store.syncSource(projectId, `${source}#${kind}`, kind, chunks))
        .inserted;
    }
    return inserted;
  }

  list(projectId: string, kind?: string) {
    return this.store.list(projectId, kind);
  }

  remove(projectId: string, id: string) {
    return this.store.remove(projectId, id);
  }
}

/** Bloco de memória para prompts (planner e worker). */
export function renderMemories(memories: RetrievedMemory[]): string | undefined {
  if (memories.length === 0) return undefined;
  return [
    "## Contexto do projeto (memória)",
    "Trechos da documentação e decisões anteriores deste projeto que parecem relevantes. Siga as convenções descritas aqui.",
    ...memories.map((memory) => `### ${memory.title} [${memory.kind}]\n${memory.content}`),
  ].join("\n\n");
}
