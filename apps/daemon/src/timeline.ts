// Linha do tempo de uma Feature: cada etapa com início, fim e duração, para
// explicar onde o tempo foi (trabalho, tentativas perdidas, gates, review,
// pausas por capacidade, espera por você e intervalos). Tudo derivado dos
// eventos e das tentativas já gravados — nada novo é persistido.

export type TimelineKind =
  | "trabalho"
  | "tentativa_perdida"
  | "gates"
  | "review"
  | "pausa_capacidade"
  | "aguardando_voce";

export interface TimelineSegment {
  kind: TimelineKind;
  label: string;
  status: string;
  startedAt: Date;
  /** null = ainda em andamento. */
  endedAt: Date | null;
}

export interface TimelineInput {
  feature: { createdAt: Date; status: string; updatedAt: Date };
  events: Array<{ type: string; payload: unknown; taskId?: string | null; createdAt: Date }>;
  attempts: Array<{
    taskId: string;
    n: number;
    targetId: string | null;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
  }>;
  tasks: Array<{ id: string; seq: number; title: string }>;
  now: Date;
}

export interface Timeline {
  startedAt: Date;
  endedAt: Date;
  totalMs: number;
  /** Tempo sem nenhuma etapa em andamento (intervalo entre etapas). */
  idleMs: number;
  totalsMs: Record<TimelineKind | "intervalos", number>;
  segments: TimelineSegment[];
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DECISIONS = new Set([
  "feature.approved",
  "feature.rejected",
  "feature.cancelled",
  "feature.cancel_requested",
]);

const REVIEW_LABEL: Record<string, string> = { requirements: "requisitos", review: "Reviewer" };

export function buildTimeline(input: TimelineInput): Timeline {
  const { feature, events, attempts, tasks, now } = input;
  const seqOf = new Map(tasks.map((task) => [task.id, task]));
  const segments: TimelineSegment[] = [];

  for (const attempt of attempts) {
    const task = seqOf.get(attempt.taskId);
    const name = task ? `#${task.seq} ${task.title}` : "Task";
    segments.push({
      kind: attempt.status === "completed" ? "trabalho" : "tentativa_perdida",
      label: `${name} · tentativa ${attempt.n} · ${attempt.targetId ?? "?"}`,
      status: attempt.status,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
    });
  }

  const gateOpen = new Map<string, TimelineSegment>();
  const reviewOpen = new Map<string, TimelineSegment>();
  const questionOpen = new Map<string, TimelineSegment>();
  let approvalOpen: TimelineSegment | undefined;

  events.forEach((event, index) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const iteration = typeof payload.iteration === "number" ? payload.iteration : 0;
    switch (event.type) {
      case "quality.gate_started": {
        const gate = String(payload.gate ?? "?");
        const segment: TimelineSegment = {
          kind: "gates",
          label: `gates r${iteration} · ${gate}`,
          status: "rodando",
          startedAt: event.createdAt,
          endedAt: null,
        };
        gateOpen.set(`${iteration}:${gate}`, segment);
        segments.push(segment);
        break;
      }
      case "quality.gate_finished": {
        const key = `${iteration}:${String(payload.gate)}`;
        const segment = gateOpen.get(key);
        if (segment) {
          segment.endedAt = event.createdAt;
          segment.status = String(payload.status ?? "?");
          gateOpen.delete(key);
        }
        break;
      }
      case "review.step_started": {
        const step = String(payload.step ?? "?");
        const segment: TimelineSegment = {
          kind: "review",
          label: `review r${iteration} · ${REVIEW_LABEL[step] ?? step} · ${String(payload.target ?? "?")}`,
          status: "rodando",
          startedAt: event.createdAt,
          endedAt: null,
        };
        reviewOpen.set(`${iteration}:${step}`, segment);
        segments.push(segment);
        break;
      }
      case "review.step_finished": {
        const key = `${iteration}:${String(payload.step)}`;
        const segment = reviewOpen.get(key);
        if (segment) {
          segment.endedAt = event.createdAt;
          segment.status = payload.ok ? "ok" : "falhou";
          reviewOpen.delete(key);
        }
        break;
      }
      case "feature.paused_capacity": {
        // A pausa dura até o próximo evento da Feature (a retomada, normalmente).
        segments.push({
          kind: "pausa_capacidade",
          label: "pausa por capacidade",
          status: "pausada",
          startedAt: event.createdAt,
          endedAt: events[index + 1]?.createdAt ?? null,
        });
        break;
      }
      case "task.question": {
        const task = seqOf.get(event.taskId ?? "");
        const segment: TimelineSegment = {
          kind: "aguardando_voce",
          label: `pergunta à Task #${task?.seq ?? "?"}`,
          status: "aberta",
          startedAt: event.createdAt,
          endedAt: null,
        };
        questionOpen.set(event.taskId ?? "", segment);
        segments.push(segment);
        break;
      }
      case "task.question_answered": {
        const segment = questionOpen.get(event.taskId ?? "");
        if (segment) {
          segment.endedAt = event.createdAt;
          segment.status = "respondida";
          questionOpen.delete(event.taskId ?? "");
        }
        break;
      }
      case "feature.awaiting_pr_approval": {
        approvalOpen = {
          kind: "aguardando_voce",
          label: "aguardando sua aprovação do PR",
          status: "aberta",
          startedAt: event.createdAt,
          endedAt: null,
        };
        segments.push(approvalOpen);
        break;
      }
    }
    if (approvalOpen && DECISIONS.has(event.type) && approvalOpen.endedAt === null) {
      approvalOpen.endedAt = event.createdAt;
      approvalOpen.status = event.type.replace("feature.", "");
    }
  });

  const startedAt = feature.createdAt;
  const endedAt = TERMINAL.has(feature.status) ? feature.updatedAt : now;
  const ordered = [...segments].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  const totalsMs = {
    trabalho: 0,
    tentativa_perdida: 0,
    gates: 0,
    review: 0,
    pausa_capacidade: 0,
    aguardando_voce: 0,
    intervalos: 0,
  };
  for (const segment of ordered) {
    totalsMs[segment.kind] += (segment.endedAt ?? now).getTime() - segment.startedAt.getTime();
  }

  // Intervalos = tempo do total que nenhuma etapa cobre (união dos intervalos).
  let covered = 0;
  let cursor = startedAt.getTime();
  for (const segment of ordered) {
    const from = Math.max(segment.startedAt.getTime(), cursor);
    const to = Math.min((segment.endedAt ?? now).getTime(), endedAt.getTime());
    if (to > from) {
      covered += to - from;
      cursor = to;
    }
  }
  const totalMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
  const idleMs = Math.max(0, totalMs - covered);
  totalsMs.intervalos = idleMs;

  return { startedAt, endedAt, totalMs, idleMs, totalsMs, segments: ordered };
}
