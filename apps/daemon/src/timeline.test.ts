import { describe, expect, it } from "vitest";
import { buildTimeline } from "./timeline.js";

const t = (minute: number) => new Date(Date.UTC(2026, 9, 14, 0, minute, 0));

const base = {
  feature: { createdAt: t(0), status: "completed", updatedAt: t(60) },
  tasks: [{ id: "t1", seq: 1, title: "API" }],
  now: t(60),
};

describe("buildTimeline", () => {
  it("tentativas perdidas e a que concluiu aparecem separadas, com o tempo de cada uma", () => {
    const timeline = buildTimeline({
      ...base,
      events: [],
      attempts: [
        {
          taskId: "t1",
          n: 1,
          targetId: "claude-sonnet",
          status: "rate_limited",
          startedAt: t(2),
          endedAt: t(27),
        },
        {
          taskId: "t1",
          n: 2,
          targetId: "codex-sol",
          status: "stalled",
          startedAt: t(28),
          endedAt: t(43),
        },
        {
          taskId: "t1",
          n: 3,
          targetId: "codex-luna",
          status: "completed",
          startedAt: t(44),
          endedAt: t(49),
        },
      ],
    });
    expect(timeline.totalsMs.tentativa_perdida).toBe((25 + 15) * 60_000);
    expect(timeline.totalsMs.trabalho).toBe(5 * 60_000);
    expect(timeline.segments[0]?.label).toBe("#1 API · tentativa 1 · claude-sonnet");
  });

  it("gates e passos do review são pareados por rodada; etapa sem fim fica em aberto", () => {
    const timeline = buildTimeline({
      ...base,
      attempts: [],
      events: [
        {
          type: "quality.gate_started",
          payload: { iteration: 0, gate: "build" },
          createdAt: t(10),
        },
        {
          type: "quality.gate_finished",
          payload: { iteration: 0, gate: "build", status: "passed" },
          createdAt: t(30),
        },
        {
          type: "review.step_started",
          payload: { iteration: 0, step: "review", target: "codex-sol" },
          createdAt: t(31),
        },
        {
          type: "review.step_finished",
          payload: { iteration: 0, step: "review", ok: true },
          createdAt: t(40),
        },
        {
          type: "quality.gate_started",
          payload: { iteration: 1, gate: "tests" },
          createdAt: t(41),
        },
      ],
    });
    expect(timeline.totalsMs.gates).toBe(20 * 60_000 + 19 * 60_000);
    expect(timeline.totalsMs.review).toBe(9 * 60_000);
    const open = timeline.segments.find((segment) => segment.label === "gates r1 · tests");
    expect(open?.endedAt).toBeNull();
    expect(open?.status).toBe("rodando");
  });

  it("pausa por capacidade dura até o próximo evento; espera de aprovação até a decisão", () => {
    const timeline = buildTimeline({
      ...base,
      attempts: [],
      events: [
        { type: "feature.paused_capacity", payload: {}, createdAt: t(5) },
        {
          type: "quality.gate_started",
          payload: { iteration: 0, gate: "build" },
          createdAt: t(35),
        },
        { type: "feature.awaiting_pr_approval", payload: {}, createdAt: t(40) },
        { type: "feature.approved", payload: {}, createdAt: t(55) },
      ],
    });
    expect(timeline.totalsMs.pausa_capacidade).toBe(30 * 60_000);
    expect(timeline.totalsMs.aguardando_voce).toBe(15 * 60_000);
    expect(timeline.segments.at(-1)?.status).toBe("approved");
  });

  it("intervalos são o tempo do total que nenhuma etapa cobre", () => {
    const timeline = buildTimeline({
      ...base,
      events: [],
      attempts: [
        {
          taskId: "t1",
          n: 1,
          targetId: "a",
          status: "completed",
          startedAt: t(10),
          endedAt: t(20),
        },
      ],
    });
    expect(timeline.totalMs).toBe(60 * 60_000);
    expect(timeline.idleMs).toBe(50 * 60_000);
    expect(timeline.totalsMs.intervalos).toBe(50 * 60_000);
  });

  it("Feature ativa usa o instante atual como fim", () => {
    const timeline = buildTimeline({
      feature: { createdAt: t(0), status: "validating", updatedAt: t(5) },
      events: [],
      attempts: [],
      tasks: [],
      now: t(30),
    });
    expect(timeline.endedAt).toEqual(t(30));
    expect(timeline.idleMs).toBe(30 * 60_000);
  });
});
