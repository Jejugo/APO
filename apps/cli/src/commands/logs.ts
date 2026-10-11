import type { Command } from "commander";
import { daemonRequest, daemonStream } from "../daemon-client.js";

interface EventRow {
  type: string;
  createdAt: string;
  payload?: unknown;
}

function printEvent(row: EventRow): void {
  const suffix = row.payload !== undefined ? ` ${JSON.stringify(row.payload)}` : "";
  console.log(`[${row.createdAt}] ${row.type}${suffix}`);
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs <featureId>")
    .description("Mostra os eventos de uma Feature (use -f para acompanhar em tempo real)")
    .option("-f, --follow", "acompanha novos eventos até a Feature terminar")
    .action(async (featureId: string, options: { follow?: boolean }) => {
      if (!options.follow) {
        const rows = await daemonRequest<EventRow[]>(`/features/${featureId}/logs`);
        for (const row of rows) {
          printEvent(row);
        }
        return;
      }

      const res = await daemonStream(`/features/${featureId}/logs?follow=true`);
      res.setEncoding("utf8");
      let buffer = "";
      for await (const chunk of res) {
        buffer += chunk as string;
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const block of lines) {
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const json = dataLine.slice("data: ".length);
          if (block.startsWith("event: done")) {
            const feature = await daemonRequest<{ status: string }>(`/features/${featureId}`);
            if (feature.status === "awaiting_approval") {
              console.log(
                `\nFeature pronta. Deseja abrir o Pull Request?  apo approve ${featureId}  |  apo reject ${featureId} --reason "..."  (detalhes: apo feature report ${featureId})`,
              );
            }
            return;
          }
          printEvent(JSON.parse(json) as EventRow);
        }
      }
    });
}
