#!/usr/bin/env node
import { Command } from "commander";
import { registerChatCommand } from "./commands/chat.js";
import { registerControlCommands } from "./commands/control.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerFeatureCommands } from "./commands/feature.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerProvidersCommand } from "./commands/providers.js";
import { registerQuestionCommands } from "./commands/questions.js";
import { registerRoleCommands } from "./commands/role.js";
import { registerRunCommand } from "./commands/run.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommands } from "./commands/task.js";
import { DaemonHttpError, DaemonUnavailableError } from "./daemon-client.js";
import { watchFeature } from "./live/watch.js";

const program = new Command();
program.name("apo").description("Orquestrador local de agentes de código").version("0.0.0");

registerInitCommand(program);
registerDaemonCommands(program);
registerProjectCommands(program);
registerMemoryCommands(program);
registerQuestionCommands(program);
registerRunCommand(program);
registerChatCommand(program);
// Atalho de `apo feature watch` — o comando mais usado no dia a dia.
program
  .command("watch <featureId>")
  .description("Painel ao vivo da Feature (atalho de `apo feature watch`)")
  .action(async (featureId: string) => {
    await watchFeature(featureId);
  });
registerFeatureCommands(program);
registerTaskCommands(program);
registerRoleCommands(program);
registerLogsCommand(program);
registerStatusCommand(program);
registerControlCommands(program);
registerProvidersCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof DaemonUnavailableError) {
    console.error(error.message);
  } else if (error instanceof DaemonHttpError) {
    // O daemon já devolve uma mensagem legível; o stack trace só atrapalha.
    const message = (error.body as { error?: string } | undefined)?.error;
    console.error(message ? `Erro (${error.status}): ${message}` : error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
