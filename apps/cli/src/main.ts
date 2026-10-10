#!/usr/bin/env node
import { Command } from "commander";
import { registerControlCommands } from "./commands/control.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerFeatureCommands } from "./commands/feature.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerProvidersCommand } from "./commands/providers.js";
import { registerRoleCommands } from "./commands/role.js";
import { registerRunCommand } from "./commands/run.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommands } from "./commands/task.js";
import { DaemonUnavailableError } from "./daemon-client.js";

const program = new Command();
program.name("apo").description("Orquestrador local de agentes de código").version("0.0.0");

registerInitCommand(program);
registerDaemonCommands(program);
registerProjectCommands(program);
registerRunCommand(program);
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
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
