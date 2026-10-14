// Cliente do GET /tasks/:id/live?follow=true (SSE): entrega cada linha do log
// do attempt e avisa quando troca de attempt (failover) ou a Task termina.

import type { IncomingMessage } from "node:http";
import { daemonStream } from "../daemon-client.js";

export interface TailHandlers {
  onAttempt(attempt: { n: number; target: string | null; status: string }): void;
  onLine(line: string): void;
  onDone(status: string): void;
}

/** Devolve uma função que encerra o acompanhamento. */
export function followTask(
  taskId: string,
  handlers: TailHandlers,
): Promise<{ stop(): void; finished: Promise<void> }> {
  return followStream(`/tasks/${taskId}/live?follow=true`, handlers);
}

/** Saída ao vivo de uma fase da Feature que não é Task: gates (`validating`) ou review (`reviewing`). */
export function followPhase(
  featureId: string,
  phase: "gates" | "review",
  handlers: TailHandlers,
): Promise<{ stop(): void; finished: Promise<void> }> {
  return followStream(`/features/${featureId}/${phase}/live?follow=true`, handlers);
}

async function followStream(
  path: string,
  handlers: TailHandlers,
): Promise<{ stop(): void; finished: Promise<void> }> {
  const response: IncomingMessage = await daemonStream(path);
  response.setEncoding("utf8");
  const finished = (async () => {
    let buffer = "";
    try {
      for await (const chunk of response) {
        buffer += chunk as string;
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue;
          const payload = JSON.parse(data) as {
            line?: string;
            status?: string;
            n?: number;
            target?: string | null;
          };
          if (event === "attempt")
            handlers.onAttempt(payload as { n: number; target: string | null; status: string });
          else if (event === "done") {
            handlers.onDone(payload.status ?? "?");
            return;
          } else if (payload.line !== undefined) handlers.onLine(payload.line);
        }
      }
    } catch {
      // conexão encerrada (stop ou daemon reiniciou)
    }
  })();
  return { stop: () => response.destroy(), finished };
}
