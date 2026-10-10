// M1.16 — lacuna do PLAN.md seção 7 nunca atribuída a uma fase.

import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";

interface FeatureRow {
  id: string;
  status: string;
}

export function registerControlCommands(program: Command): void {
  program
    .command("pause <featureId>")
    .description("Pausa uma Feature")
    .action(async (featureId: string) => {
      const row = await daemonRequest<FeatureRow>(`/features/${featureId}/pause`, {
        method: "POST",
      });
      console.log(`Feature ${row.id} agora está ${row.status}.`);
    });

  program
    .command("resume <featureId>")
    .description("Retoma uma Feature pausada")
    .action(async (featureId: string) => {
      const row = await daemonRequest<FeatureRow>(`/features/${featureId}/resume`, {
        method: "POST",
      });
      console.log(`Feature ${row.id} agora está ${row.status}.`);
    });

  program
    .command("cancel <featureId>")
    .description("Cancela uma Feature, interrompendo o attempt em execução")
    .action(async (featureId: string) => {
      const row = await daemonRequest<FeatureRow & { wasRunning: boolean }>(
        `/features/${featureId}/cancel`,
        { method: "POST" },
      );
      if (row.wasRunning) {
        console.log(
          `Cancelamento solicitado para a feature ${row.id}. Use 'apo feature show ${row.id}' para ver quando terminar.`,
        );
      } else {
        console.log(`Feature ${row.id} não tinha execução ativa (status atual: ${row.status}).`);
      }
    });
}
