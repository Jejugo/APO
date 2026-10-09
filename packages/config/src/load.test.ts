import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GlobalConfigSchema } from "./config-schema.js";
import { ConfigValidationError, loadConfig } from "./load.js";
import { ProjectConfigSchema } from "./project-schema.js";

function tempYamlFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "apo-config-test-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("loadConfig", () => {
  it("aplica todos os defaults quando o arquivo não existe", () => {
    const missingPath = join(tmpdir(), "apo-config-test-missing-file", "config.yaml");
    const config = loadConfig(missingPath, GlobalConfigSchema);

    expect(config.limits?.maxGlobalWorkers).toBe(4);
    expect(config.routing?.degradedAt).toBe(80);
    expect(config.routing?.avoidAt).toBe(95);
  });

  it("preserva campos informados e aplica defaults no resto", () => {
    const path = tempYamlFile("routing:\n  degradedAt: 70\n");
    const config = loadConfig(path, GlobalConfigSchema);

    expect(config.routing?.degradedAt).toBe(70);
    expect(config.routing?.avoidAt).toBe(95);
  });

  it("rejeita tipo errado com mensagem legível (campo e motivo)", () => {
    const path = tempYamlFile('limits:\n  maxGlobalWorkers: "quatro"\n');

    try {
      loadConfig(path, GlobalConfigSchema);
      expect.unreachable("deveria ter lançado ConfigValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues[0]).toContain("limits.maxGlobalWorkers");
    }
  });

  it("rejeita project.yaml com workspace.defaultMode fora do enum", () => {
    const path = tempYamlFile("workspace:\n  defaultMode: invalido\n");
    expect(() => loadConfig(path, ProjectConfigSchema)).toThrow(ConfigValidationError);
  });

  it("aceita project.yaml mínimo com defaults completos", () => {
    const path = tempYamlFile("quality:\n  commands:\n    tests: pnpm test\n");
    const config = loadConfig(path, ProjectConfigSchema);

    expect(config.quality?.commands?.tests).toBe("pnpm test");
    expect(config.git?.requirePrApproval).toBe(true);
    expect(config.workspace?.defaultMode).toBe("auto");
  });
});
