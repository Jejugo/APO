import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigPath } from "@apo/config";
import type { Command } from "commander";

const DEFAULT_CONFIG_YAML = `# ~/.apo/config.yaml — gerado por \`apo init\`. Veja TECHNICAL_PLAN.md seção 2.1.
socketPath: ~/.apo/apo.sock
routing:
  capacityAware: true
  degradedAt: 80
  avoidAt: 95
  preferLowerUsageDifference: 20
limits:
  maxGlobalWorkers: 4
  maxWorkersPerProvider: 2
providers:
  maxAttemptsPerTask: 3
  unknownResetRetryMinutes: 30
  targets:
    - id: claude-code
      harness: claude-code
      provider: anthropic
    - id: codex
      harness: codex
      provider: openai
`;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Cria ~/.apo/config.yaml com os defaults")
    .action(() => {
      const path = globalConfigPath();
      if (existsSync(path)) {
        console.log(`${path} já existe.`);
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, DEFAULT_CONFIG_YAML, "utf8");
      console.log(`Criado ${path}.`);
    });
}
