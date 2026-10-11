// Ingestão (M5.8) — seção 22 do PLAN.md. Só arquivos versionados (`git
// ls-files`): nada de node_modules, build ou segredo fora do git.

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { execa } from "execa";
import { type Chunk, chunkMarkdown, chunkWhole } from "./chunking.js";

const DOC_NAMES = /^(readme|agents|claude|contributing|conventions|architecture)(\.[a-z]+)?\.md$/i;
const MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
]);
const MAX_FILE_BYTES = 200_000;

export function isIngestible(path: string): "markdown" | "manifest" | undefined {
  if (path.split("/").some((part) => part === "node_modules" || part.startsWith("."))) {
    return undefined;
  }
  const name = basename(path);
  if (!path.includes("/") && MANIFESTS.has(name)) return "manifest";
  if (!path.endsWith(".md")) return undefined;
  if (DOC_NAMES.test(name)) return "markdown";
  if (path.startsWith("docs/") || /(^|\/)adrs?\//i.test(path)) return "markdown";
  return undefined;
}

export async function collectProjectDocs(repoPath: string): Promise<Map<string, Chunk[]>> {
  const { stdout } = await execa("git", ["ls-files", "-z"], { cwd: repoPath });
  const files = stdout.split("\0").filter(Boolean);
  const docs = new Map<string, Chunk[]>();
  for (const path of files) {
    const type = isIngestible(path);
    if (!type) continue;
    let text: string;
    try {
      text = await readFile(join(repoPath, path), "utf8");
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES);
    docs.set(path, type === "manifest" ? chunkWhole(path, text) : chunkMarkdown(path, text));
  }
  return docs;
}
