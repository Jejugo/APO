import { describe, expect, it } from "vitest";
import { classifyCodexFailure } from "./codex/classify-failure.js";
import { detectLimitFailure, parseResetAt } from "./limit-detection.js";
import { buildWorkerEnvironment } from "./worker-env.js";

// Fixture real: Codex (conta ChatGPT) batendo no limite durante a validação do M1.
const CODEX_USAGE_LIMIT =
  "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:58 PM.";

describe("detectLimitFailure", () => {
  it("classifica o limite de uso real do Codex como quota_exhausted, com resetAt", () => {
    const now = new Date(2026, 9, 9, 15, 54, 0);
    const failure = detectLimitFailure(CODEX_USAGE_LIMIT, now);
    expect(failure?.kind).toBe("quota_exhausted");
    expect(failure?.resetAt).toEqual(new Date(2026, 9, 9, 15, 58, 0));
  });

  it("classifica 'too many requests' como rate_limited", () => {
    expect(detectLimitFailure("429 Too Many Requests")?.kind).toBe("rate_limited");
  });

  it("não classifica erros comuns como limite", () => {
    expect(detectLimitFailure("TypeError: cannot read property x")).toBeUndefined();
  });
});

describe("parseResetAt", () => {
  it("joga para amanhã quando o horário já passou", () => {
    const now = new Date(2026, 9, 9, 16, 30, 0);
    expect(parseResetAt("try again at 3:58 PM", now)).toEqual(new Date(2026, 9, 10, 15, 58, 0));
  });

  // Fixture real (Codex, início do M3): reset em outro dia, com data completa.
  it("entende 'try again at Oct 10th, 2026 2:27 AM'", () => {
    const text =
      "You’ve hit your usage limit. Upgrade to Pro (...) or try again at Oct 10th, 2026 2:27 AM.";
    expect(parseResetAt(text)).toEqual(new Date(2026, 9, 10, 2, 27, 0));
    expect(detectLimitFailure(text)?.kind).toBe("quota_exhausted");
  });

  it("entende 'try again in N minutes'", () => {
    const now = new Date(2026, 9, 9, 10, 0, 0);
    expect(parseResetAt("please try again in 15 minutes", now)).toEqual(
      new Date(2026, 9, 9, 10, 15, 0),
    );
  });

  it("devolve undefined sem formato reconhecido — nunca inventa", () => {
    expect(parseResetAt("usage limit reached")).toBeUndefined();
  });
});

describe("classifyCodexFailure com a mensagem real de limite", () => {
  it("vira quota_exhausted em vez de crash", () => {
    const failure = classifyCodexFailure({
      type: "turn.failed",
      error: { message: CODEX_USAGE_LIMIT },
    });
    expect(failure.kind).toBe("quota_exhausted");
  });
});

describe("buildWorkerEnvironment", () => {
  it("só repassa a allowlist, nunca segredos do daemon", () => {
    const env = buildWorkerEnvironment([], {
      HOME: "/home/x",
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://segredo",
      JEV_API_KEY: "segredo",
      GITHUB_TOKEN: "segredo",
    });
    expect(env).toEqual({ HOME: "/home/x", PATH: "/usr/bin" });
  });

  it("inclui variáveis autorizadas explicitamente pelo Project", () => {
    const env = buildWorkerEnvironment(["NPM_TOKEN"], {
      HOME: "/h",
      NPM_TOKEN: "ok",
      OTHER: "não",
    });
    expect(env).toEqual({ HOME: "/h", NPM_TOKEN: "ok" });
  });
});
