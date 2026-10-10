import { createLogger } from "@apo/observability";
import { describe, expect, it } from "vitest";
import type { ServerDeps } from "./server-deps.js";
import { buildServer } from "./server.js";

// Só testa /health, que não toca o resto de ServerDeps — os stubs abaixo
// nunca são exercitados aqui (as rotas de negócio têm seus próprios testes
// de integração, ex. feature-graph.test.ts em @apo/orchestrator).
const stubDeps = { logger: createLogger({}) } as unknown as ServerDeps;

describe("GET /health", () => {
  it("responde status ok com pid e uptime", async () => {
    const app = buildServer(stubDeps);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.pid).toBe(process.pid);
    expect(typeof body.uptimeMs).toBe("number");
    await app.close();
  });
});
