// Chunking por seção (M5.8). Markdown quebra nos títulos `#`..`###`; seção
// longa quebra de novo em parágrafos. Manifest (package.json etc.) vira um
// chunk só, truncado — o que importa ali são nome, scripts e dependências.

import { createHash } from "node:crypto";

export interface Chunk {
  title: string;
  content: string;
  contentHash: string;
}

const MAX_CHARS = 1500;

export function hashChunk(title: string, content: string): string {
  return createHash("sha256").update(`${title}\n${content}`).digest("hex");
}

function make(title: string, content: string): Chunk {
  const trimmed = content.trim();
  return { title, content: trimmed, contentHash: hashChunk(title, trimmed) };
}

function splitLong(title: string, body: string): Chunk[] {
  if (body.length <= MAX_CHARS) return [make(title, body)];
  const chunks: Chunk[] = [];
  let current = "";
  for (const paragraph of body.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > MAX_CHARS) {
      chunks.push(make(`${title} (parte ${chunks.length + 1})`, current));
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph.slice(0, MAX_CHARS * 2);
  }
  if (current.trim()) chunks.push(make(`${title} (parte ${chunks.length + 1})`, current));
  return chunks;
}

export function chunkMarkdown(source: string, text: string): Chunk[] {
  const sections: Array<{ heading: string[]; body: string[] }> = [{ heading: [], body: [] }];
  const path: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      const level = (match[1] as string).length;
      path.splice(level - 1);
      path[level - 1] = match[2] as string;
      sections.push({ heading: path.filter(Boolean), body: [] });
    } else {
      (sections.at(-1) as { body: string[] }).body.push(line);
    }
  }
  return sections
    .filter((section) => section.body.join("\n").trim().length > 0)
    .flatMap((section) =>
      splitLong([source, ...section.heading].join(" › "), section.body.join("\n")),
    );
}

export function chunkWhole(source: string, text: string): Chunk[] {
  return text.trim() ? [make(source, text.slice(0, MAX_CHARS * 2))] : [];
}
