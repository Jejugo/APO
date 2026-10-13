import { describe, expect, it } from "vitest";
import { buildWorkerEnvironment } from "./worker-env.js";

describe("buildWorkerEnvironment", () => {
  it("não repassa o NODE_ENV do daemon (production na VM quebrava testes que o CI passa)", () => {
    const env = buildWorkerEnvironment([], {
      HOME: "/home/apo",
      PATH: "/usr/bin",
      NODE_ENV: "production",
    });
    expect(env).toEqual({ HOME: "/home/apo", PATH: "/usr/bin" });
  });

  it("segredos do daemon nunca entram; o que o Project autoriza entra", () => {
    const env = buildWorkerEnvironment(["NPM_TOKEN"], {
      HOME: "/h",
      DATABASE_URL: "postgres://x",
      OPENROUTER_API_KEY: "k",
      NPM_TOKEN: "t",
    });
    expect(env).toEqual({ HOME: "/h", NPM_TOKEN: "t" });
  });
});
