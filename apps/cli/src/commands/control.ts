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

  // M4.8 — aprovação do PR (seção 27 do PLAN.md). O merge continua manual.
  program
    .command("approve <featureId>")
    .description("Aprova a Feature pronta: o APO abre o Pull Request (nunca faz merge)")
    .action(async (featureId: string) => {
      await daemonRequest(`/features/${featureId}/approve`, { method: "POST" });
      console.log("Aprovada. O APO vai fazer push da branch e abrir o PR.");
      console.log(`Acompanhe com: apo feature report ${featureId}  |  apo logs ${featureId} -f`);
    });

  program
    .command("reject <featureId>")
    .description("Rejeita a Feature pronta; o motivo vira uma Task de ajuste")
    .requiredOption("--reason <texto>", "o que precisa mudar")
    .action(async (featureId: string, options: { reason: string }) => {
      await daemonRequest(`/features/${featureId}/reject`, {
        method: "POST",
        body: { reason: options.reason },
      });
      console.log(
        "Rejeitada. O motivo virou uma Task de ajuste; a Feature volta para a fila de correção.",
      );
    });
}
