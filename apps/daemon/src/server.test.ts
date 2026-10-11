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

describe("listener remoto com token (M6.7)", () => {
  const token = "t".repeat(32);

  it("sem token, com token errado ou de tamanho diferente → 401", async () => {
    const app = buildServer(stubDeps, { authToken: token });
    for (const authorization of [undefined, `Bearer ${"x".repeat(32)}`, "Bearer curto"]) {
      const response = await app.inject({
        method: "GET",
        url: "/health",
        ...(authorization ? { headers: { authorization } } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });

  it("token certo passa", async () => {
    const app = buildServer(stubDeps, { authToken: token });
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /health com detalhes (M6.9)", () => {
  it("Postgres fora → 503 degraded, com os providers", async () => {
    const app = buildServer({
      ...stubDeps,
      health: async () => ({
        postgres: "connect ECONNREFUSED",
        providers: [{ target: "a", availability: "available" }],
      }),
    } as ServerDeps);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "degraded", providers: [{ target: "a" }] });
    await app.close();
  });
});
