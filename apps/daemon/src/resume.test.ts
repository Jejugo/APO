import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pausedUntil, resumeFeatures } from "./resume.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "apo-resume-"));
  dirs.push(dir);
  return dir;
}

function fakeDeps(features: Array<{ id: string; projectId: string }>, repoPath: string) {
  const started: string[] = [];
  return {
    started,
    deps: {
      features: { listByStatuses: async () => features },
      projects: { getById: async () => ({ id: "p", repoPath, defaultBranch: "main" }) },
      featureRunner: {
        isRunning: () => false,
        run: async (input: { featureId: string }) => {
          started.push(input.featureId);
        },
      },
      logger: { info() {}, warn() {}, error() {} },
      worktreesRoot: repoPath,
    },
  };
}

describe("pausedUntil", () => {
  it("usa o resumeAt da última pausa por capacidade", async () => {
    const events = {
      listByFeature: async () => [
        { type: "feature.paused_capacity", payload: { resumeAt: "2026-10-14T01:00:00.000Z" } },
        { type: "quality.completed", payload: {} },
        { type: "feature.paused_capacity", payload: { resumeAt: "2026-10-14T02:30:00.000Z" } },
      ],
    };
    expect(await pausedUntil(events, "f")).toEqual(new Date("2026-10-14T02:30:00.000Z"));
  });

  it("sem resumeAt (pausa sem reset conhecido) devolve undefined", async () => {
    const events = {
      listByFeature: async () => [{ type: "feature.paused_capacity", payload: {} }],
    };
    expect(await pausedUntil(events, "f")).toBeUndefined();
  });
});

describe("resumeFeatures com elegibilidade", () => {
  it("só retoma as Features que passam no filtro", async () => {
    const path = repo();
    const { deps, started } = fakeDeps(
      [
        { id: "antes", projectId: "p" },
        { id: "depois", projectId: "p" },
      ],
      path,
    );
    const resumed = await resumeFeatures(
      deps as never,
      ["paused_capacity"],
      "capacity-resume",
      async (id) => id === "depois",
    );
    expect(resumed).toBe(1);
    expect(started).toEqual(["depois"]);
  });

  it("sem filtro, mantém o comportamento de antes (retoma todas)", async () => {
    const path = repo();
    const { deps, started } = fakeDeps([{ id: "a", projectId: "p" }], path);
    await resumeFeatures(deps as never, ["paused_capacity"], "recovery");
    expect(started).toEqual(["a"]);
  });
});
