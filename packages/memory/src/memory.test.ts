// M5 — memória contra o Postgres do docker/compose.yaml (pgvector), com o
// HashingEmbeddingProvider (determinístico, sem baixar modelo).

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, ProjectRepository, createDb } from "@apo/db";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chunkMarkdown } from "./chunking.js";
import { HashingEmbeddingProvider, embedInBatches } from "./embedding.js";
import { isIngestible } from "./ingest.js";
import { MemoryService, renderMemories } from "./service.js";
import { MemoryStore } from "./store.js";

describe("chunking e seleção de arquivos", () => {
  it("quebra por título, mantendo o caminho dos títulos; ignora # dentro de bloco de código", () => {
    const chunks = chunkMarkdown(
      "README.md",
      "# Loja\nintro\n## Convenções\nUse JSDoc.\n```sh\n# não é título\n```\n## Deploy\nVercel.\n",
    );
    expect(chunks.map((chunk) => chunk.title)).toEqual([
      "README.md › Loja",
      "README.md › Loja › Convenções",
      "README.md › Loja › Deploy",
    ]);
    expect(chunks[1]?.content).toContain("# não é título");
  });

  it("seleciona docs, ADRs e manifests da raiz; ignora o resto", () => {
    expect(isIngestible("README.md")).toBe("markdown");
    expect(isIngestible("docs/guia.md")).toBe("markdown");
    expect(isIngestible("docs/adr/0001-x.md")).toBe("markdown");
    expect(isIngestible("CLAUDE.md")).toBe("markdown");
    expect(isIngestible("package.json")).toBe("manifest");
    expect(isIngestible("packages/x/package.json")).toBeUndefined();
    expect(isIngestible("src/notas.md")).toBeUndefined();
    expect(isIngestible("node_modules/a/README.md")).toBeUndefined();
    expect(isIngestible(".github/README.md")).toBeUndefined();
  });
});

describe("embedInBatches", () => {
  it("nunca passa mais que o tamanho do lote e preserva a ordem", async () => {
    const sizes: number[] = [];
    const texts = Array.from({ length: 40 }, (_, index) => String(index));
    const vectors = await embedInBatches(texts, 16, async (batch) => {
      sizes.push(batch.length);
      return batch.map((text) => [Number(text)]);
    });
    expect(sizes).toEqual([16, 16, 8]);
    expect(vectors.map((vector) => vector[0])).toEqual(texts.map(Number));
  });
});

describe("MemoryService (pgvector)", () => {
  let db: Db;
  let service: MemoryService;
  let projectId: string;
  let repo: string;

  beforeAll(() => {
    db = createDb();
    service = new MemoryService(new MemoryStore(db, new HashingEmbeddingProvider()));
  });
  afterAll(async () => {
    await db.$client.end();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  async function setup(files: Record<string, string>) {
    repo = mkdtempSync(join(tmpdir(), "apo-memory-"));
    await execa("git", ["init", "-q", "-b", "main"], { cwd: repo });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    await execa("git", ["add", "-A"], { cwd: repo });
    const project = await new ProjectRepository(db).create({
      id: randomUUID(),
      name: "mem",
      repoPath: repo,
      defaultBranch: "main",
    });
    projectId = project?.id ?? "";
  }

  it("ingestão idempotente: rodar duas vezes não duplica; mudança reembeda só o que mudou; arquivo removido sai", async () => {
    await setup({
      "README.md":
        "# Loja\n## Convenções\nToda função exportada tem JSDoc em português.\n## Deploy\nDeploy na Vercel.\n",
      "docs/api.md": "# API\nREST com paginação por cursor.\n",
      "package.json": '{"name":"loja","scripts":{"test":"vitest run"}}',
      "src/index.ts": "export {};\n",
    });
    const first = await service.ingestProject(projectId, repo);
    expect(first).toMatchObject({ files: 3, inserted: 4, kept: 0, removed: 0 });
    const second = await service.ingestProject(projectId, repo);
    expect(second).toMatchObject({ inserted: 0, kept: 4, removed: 0 });
    expect(await service.list(projectId)).toHaveLength(4);

    writeFileSync(
      join(repo, "README.md"),
      "# Loja\n## Convenções\nToda função exportada tem JSDoc em português.\n## Deploy\nDeploy no Fly.io.\n",
    );
    unlinkSync(join(repo, "docs/api.md"));
    await execa("git", ["add", "-A"], { cwd: repo });
    const third = await service.ingestProject(projectId, repo);
    expect(third).toMatchObject({ inserted: 1, removed: 2 });
    const titles = (await service.list(projectId)).map((row) => row.title);
    expect(titles).not.toContain("docs/api.md › API");
    expect((await service.list(projectId)).some((row) => row.content.includes("Fly.io"))).toBe(
      true,
    );
  });

  it("retrieval: a convenção plantada aparece para a Task relevante e o bloco respeita o orçamento", async () => {
    await setup({
      "README.md":
        "# Loja\n## Deploy\nDeploy automático na Vercel a cada push.\n## Banco\nPostgres com migrations do Drizzle.\n",
    });
    await service.ingestProject(projectId, repo);
    await service.remember(projectId, "manual", [
      {
        kind: "convention",
        title: "Preços em centavos",
        content: "Valores monetários são sempre inteiros em centavos; formate só na borda da UI.",
      },
    ]);

    const found = await service.retrieve(
      projectId,
      "Task: calcular o total do carrinho com preços e descontos em centavos",
      { limit: 2 },
    );
    expect(found[0]?.title).toBe("Preços em centavos");
    expect(renderMemories(found)).toContain("## Contexto do projeto (memória)");

    const tight = await service.retrieve(projectId, "preços centavos", { maxChars: 60 });
    expect(
      tight.reduce((sum, memory) => sum + memory.title.length + memory.content.length, 0),
    ).toBeLessThanOrEqual(60);
  });

  it("remember é idempotente por Feature e tipo", async () => {
    await setup({ "README.md": "# x\ny\n" });
    const items = [
      {
        kind: "decision" as const,
        title: "Usar cursor",
        content: "Paginação por cursor, não offset.",
      },
    ];
    expect(await service.remember(projectId, "feature:abc", items)).toBe(1);
    expect(await service.remember(projectId, "feature:abc", items)).toBe(0);
  });
});
