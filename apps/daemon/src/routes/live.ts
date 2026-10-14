// Visão ao vivo: `apo watch` (painel da Feature) e `apo task tail` (o que o
// agente está fazendo agora). O log de cada attempt é gravado enquanto o CLI
// roda (runSupervisedProcess); aqui ele é lido incrementalmente e mandado por
// SSE, linha a linha. A formatação para humanos fica na CLI.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../server-deps.js";

const POLL_MS = 500;
const ACTIVE_ATTEMPT = new Set(["starting", "working"]);
const DONE_TASK = new Set(["completed", "failed", "cancelled", "needs_human"]);

/** Lê o que o arquivo ganhou desde `offset`; devolve linhas completas. */
function readNew(path: string, state: { offset: number; partial: string }): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size <= state.offset) return [];
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - state.offset);
    readSync(fd, buffer, 0, buffer.length, state.offset);
    state.offset = size;
    const text = state.partial + buffer.toString("utf8");
    const lines = text.split("\n");
    state.partial = lines.pop() ?? "";
    return lines;
  } finally {
    closeSync(fd);
  }
}

interface GateView {
  gate: string;
  command?: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  durationMs?: number;
}

/** Etapas dos quality gates da iteração atual, a partir dos eventos `quality.gate_*`. */
export function gatesOf(
  events: Array<{ type: string; payload: unknown; createdAt: string | Date }>,
  iteration: number,
): GateView[] {
  const gates = new Map<string, GateView>();
  for (const event of events) {
    if (event.type !== "quality.gate_started" && event.type !== "quality.gate_finished") continue;
    const payload = (event.payload ?? {}) as {
      iteration?: number;
      gate?: string;
      command?: string;
      status?: "passed" | "failed";
      durationMs?: number;
    };
    if (payload.iteration !== iteration || !payload.gate) continue;
    if (event.type === "quality.gate_started") {
      gates.set(payload.gate, {
        gate: payload.gate,
        ...(payload.command ? { command: payload.command } : {}),
        status: "running",
        startedAt: new Date(event.createdAt).toISOString(),
      });
    } else {
      const current = gates.get(payload.gate);
      if (current && payload.status) {
        current.status = payload.status;
        if (payload.durationMs !== undefined) current.durationMs = payload.durationMs;
      }
    }
  }
  return [...gates.values()];
}

interface ReviewStepView {
  step: string;
  target: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  durationMs?: number;
  /** requisitos não atendidos (requirements) ou achados (review). */
  items?: number;
}

/** Passos do review da iteração atual, a partir dos eventos `review.step_*`. */
export function reviewStepsOf(
  events: Array<{ type: string; payload: unknown; createdAt: string | Date }>,
  iteration: number,
): ReviewStepView[] {
  const steps = new Map<string, ReviewStepView>();
  for (const event of events) {
    if (event.type !== "review.step_started" && event.type !== "review.step_finished") continue;
    const payload = (event.payload ?? {}) as {
      iteration?: number;
      step?: string;
      target?: string;
      ok?: boolean;
      durationMs?: number;
      items?: number;
    };
    if (payload.iteration !== iteration || !payload.step) continue;
    if (event.type === "review.step_started") {
      // Outro provider assumindo o mesmo passo (limite de capacidade) reinicia o passo.
      steps.set(payload.step, {
        step: payload.step,
        target: payload.target ?? "?",
        status: "running",
        startedAt: new Date(event.createdAt).toISOString(),
      });
    } else {
      const current = steps.get(payload.step);
      if (!current) continue;
      current.status = payload.ok ? "done" : "failed";
      if (payload.durationMs !== undefined) current.durationMs = payload.durationMs;
      if (payload.items !== undefined) current.items = payload.items;
    }
  }
  return [...steps.values()];
}

export function registerLiveRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/features/:id/board", async (request, reply) => {
    const { id } = request.params as { id: string };
    const feature = await deps.features.getById(id);
    if (!feature) {
      reply.code(404);
      return { error: "feature não encontrada" };
    }
    const tasks = (await deps.tasks.listByFeature(id)).sort((a, b) => a.seq - b.seq);
    const seqById = new Map(tasks.map((task) => [task.id, task.seq]));
    const events = await deps.events.listByFeature(id);
    const pendingQuestions = (await deps.agentMessages.listPending(id, "question")).map(
      (message) => ({
        id: message.id,
        createdAt: message.createdAt,
        ...(message.payload as {
          taskId: string;
          question: string;
          options: unknown[];
          recommended?: string;
        }),
      }),
    );
    return {
      gates: gatesOf(events, feature.fixIteration),
      review: reviewStepsOf(events, feature.fixIteration),
      feature: {
        id: feature.id,
        objective: feature.objective,
        status: feature.status,
        fixIteration: feature.fixIteration,
        prUrl: feature.prUrl,
        createdAt: feature.createdAt,
        updatedAt: feature.updatedAt,
      },
      tasks: await Promise.all(
        tasks.map(async (task) => {
          const attempt = (await deps.taskAttempts.listByTask(task.id)).at(-1);
          return {
            id: task.id,
            seq: task.seq,
            title: task.title,
            status: task.status,
            role: task.role,
            origin: task.origin,
            dependsOn: task.dependencies
              .map((dep) => seqById.get(dep))
              .filter((seq) => seq !== undefined),
            attempt: attempt
              ? {
                  n: attempt.n,
                  target: attempt.targetId,
                  status: attempt.status,
                  startedAt: attempt.startedAt,
                  endedAt: attempt.endedAt,
                }
              : null,
          };
        }),
      ),
      questions: pendingQuestions,
      events: events.slice(-12).map((event) => ({
        type: event.type,
        taskId: event.taskId,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
    };
  });

  // Log de uma fase da Feature que não é Task (quality gates, review): leitura
  // única ou SSE até a Feature sair da fase.
  function registerPhaseLog(
    route: string,
    phase: string,
    pathOf: (featureId: string, iteration: number) => string | undefined,
  ): void {
    app.get(route, async (request, reply) => {
      const { id } = request.params as { id: string };
      const { follow } = request.query as { follow?: string };
      const feature = await deps.features.getById(id);
      if (!feature) {
        reply.code(404);
        return { error: "feature não encontrada" };
      }
      if (!pathOf(id, feature.fixIteration)) {
        reply.code(501);
        return { error: "log desta fase não configurado neste daemon" };
      }
      const logPath = (iteration: number) => pathOf(id, iteration) as string;

      if (follow !== "true" && follow !== "1") {
        const state = { offset: 0, partial: "" };
        const lines = readNew(logPath(feature.fixIteration), state);
        if (state.partial) lines.push(state.partial);
        return { iteration: feature.fixIteration, lines };
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let closed = false;
      request.raw.on("close", () => {
        closed = true;
      });
      const send = (event: string | undefined, data: unknown) => {
        if (!closed)
          reply.raw.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
      };

      let iteration = feature.fixIteration;
      let state = { offset: 0, partial: "" };
      let idleRounds = 0;
      send("attempt", { n: iteration, target: null, status: phase });
      while (!closed) {
        const fresh = await deps.features.getById(id);
        if (fresh && fresh.fixIteration !== iteration) {
          // Nova rodada de correção → novo log; o anterior já foi lido até o fim.
          iteration = fresh.fixIteration;
          state = { offset: 0, partial: "" };
          send("attempt", { n: iteration, target: null, status: fresh.status });
        }
        const lines = readNew(logPath(iteration), state);
        for (const line of lines) send(undefined, { line });
        idleRounds = lines.length > 0 ? 0 : idleRounds + 1;
        // Encerra quando a Feature saiu da fase e o log parou de crescer.
        if (fresh && fresh.status !== phase && idleRounds >= 2) {
          send("done", { status: fresh.status });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      reply.raw.end();
    });
  }
  registerPhaseLog("/features/:id/gates/live", "validating", (id, it) =>
    deps.gateLogPath?.(id, it),
  );
  registerPhaseLog("/features/:id/review/live", "reviewing", (id, it) =>
    deps.reviewLogPath?.(id, it),
  );

  app.get("/tasks/:id/live", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { follow } = request.query as { follow?: string };
    const task = await deps.tasks.getById(id);
    if (!task) {
      reply.code(404);
      return { error: "task não encontrada" };
    }
    const logPathOf = deps.attemptLogPath;
    if (!logPathOf) {
      reply.code(501);
      return { error: "logs de attempt não configurados neste daemon" };
    }

    if (follow !== "true" && follow !== "1") {
      const attempt = (await deps.taskAttempts.listByTask(id)).at(-1);
      if (!attempt) return { attempt: null, lines: [] };
      const state = { offset: 0, partial: "" };
      const lines = readNew(logPathOf(attempt.id), state);
      if (state.partial) lines.push(state.partial);
      return { attempt: { n: attempt.n, target: attempt.targetId, status: attempt.status }, lines };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });
    const send = (event: string | undefined, data: unknown) => {
      if (!closed)
        reply.raw.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    };

    let currentId: string | undefined;
    let state = { offset: 0, partial: "" };
    let idleRounds = 0;
    while (!closed) {
      const attempts = await deps.taskAttempts.listByTask(id);
      const latest = attempts.at(-1);
      if (latest && latest.id !== currentId) {
        // Restante do attempt anterior antes de trocar (failover/reroute).
        if (currentId) {
          for (const line of readNew(logPathOf(currentId), state)) send(undefined, { line });
        }
        currentId = latest.id;
        state = { offset: 0, partial: "" };
        send("attempt", { n: latest.n, target: latest.targetId, status: latest.status });
      }
      if (currentId) {
        const lines = readNew(logPathOf(currentId), state);
        for (const line of lines) send(undefined, { line });
        idleRounds = lines.length > 0 ? 0 : idleRounds + 1;
      }
      const fresh = await deps.tasks.getById(id);
      const attemptActive = latest ? ACTIVE_ATTEMPT.has(latest.status) : false;
      // Encerra quando a Task terminou e o log parou de crescer.
      if (fresh && DONE_TASK.has(fresh.status) && !attemptActive && idleRounds >= 2) {
        send("done", { status: fresh.status });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    reply.raw.end();
  });
}
