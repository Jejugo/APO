// M6.2 — `apo chat`: conversa com o Lead do Project. Cada mensagem vira uma
// ação estruturada que o daemon executa (M6.3). Sem argumento abre um REPL;
// com uma mensagem, manda só ela e sai (útil em scripts).

import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { DaemonHttpError, daemonRequest } from "../daemon-client.js";

interface ChatResponse {
  reply: string;
  action: { action: string };
  result: { ok: boolean; note: string };
}

interface HistoryResponse {
  summary: string | null;
  messages: Array<{ role: string; content: string; result: { note: string } | null }>;
}

async function send(projectId: string, message: string): Promise<void> {
  try {
    const response = await daemonRequest<ChatResponse>(`/projects/${projectId}/chat`, {
      method: "POST",
      body: { message },
    });
    console.log(`\nLead: ${response.reply}`);
    if (response.result.note) {
      console.log(`${response.result.ok ? "→" : "⚠"} ${response.result.note}`);
    }
  } catch (error) {
    if (error instanceof DaemonHttpError) {
      console.error(`⚠ ${(error.body as { error?: string } | undefined)?.error ?? error.message}`);
      return;
    }
    throw error;
  }
}

async function history(projectId: string): Promise<void> {
  const data = await daemonRequest<HistoryResponse>(`/projects/${projectId}/chat?limit=20`);
  if (data.summary) console.log(`(resumo anterior)\n${data.summary}\n`);
  for (const message of data.messages) {
    console.log(`${message.role === "user" ? "Você" : "Lead"}: ${message.content}`);
    if (message.result?.note) console.log(`  → ${message.result.note}`);
  }
}

export function registerChatCommand(program: Command): void {
  program
    .command("chat [mensagem]")
    .description("Conversa com o Lead do Project (sem mensagem abre o modo interativo)")
    .requiredOption("--project <id>", "id do Project")
    .action(async (message: string | undefined, options: { project: string }) => {
      if (message) {
        await send(options.project, message);
        return;
      }
      console.log("Conversando com o Lead. /historico mostra a conversa, /sair encerra.");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const line = (await rl.question("\nVocê: ")).trim();
          if (!line) continue;
          if (line === "/sair" || line === "/exit") break;
          if (line === "/historico") {
            await history(options.project);
            continue;
          }
          await send(options.project, line);
        }
      } finally {
        rl.close();
      }
    });
}
