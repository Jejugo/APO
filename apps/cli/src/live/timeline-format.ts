// Formatação da linha do tempo de uma Feature (`apo feature timeline`). Os dados
// vêm de GET /features/:id/timeline; aqui só se escolhe o que mostrar e como.

import { formatDuration } from "./duration.js";

export type TimelineKind =
  | "trabalho"
  | "tentativa_perdida"
  | "gates"
  | "review"
  | "pausa_capacidade"
  | "aguardando_voce"
  | "intervalos";

export interface TimelineResponse {
  startedAt: string;
  endedAt: string;
  totalMs: number;
  idleMs: number;
  totalsMs: Record<TimelineKind, number>;
  segments: Array<{
    kind: Exclude<TimelineKind, "intervalos">;
    label: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
  }>;
}

const KIND_LABEL: Record<TimelineKind, string> = {
  trabalho: "trabalho dos agentes",
  tentativa_perdida: "tentativas perdidas",
  gates: "quality gates",
  review: "review",
  pausa_capacidade: "pausas por capacidade",
  aguardando_voce: "aguardando você",
  intervalos: "intervalos",
};

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", TIME_FORMAT);
}

/** Totais por tipo, do maior para o menor, sem os que deram zero. */
export function formatTotals(totals: Record<TimelineKind, number>): string {
  return (Object.keys(totals) as TimelineKind[])
    .filter((kind) => totals[kind] >= 1000)
    .sort((a, b) => totals[b] - totals[a])
    .map((kind) => `${KIND_LABEL[kind]} ${formatDuration(totals[kind] / 1000)}`)
    .join(" · ");
}

export function formatTimeline(timeline: TimelineResponse): string[] {
  const lines = [
    `Total ${formatDuration(timeline.totalMs / 1000)} (${clock(timeline.startedAt)} → ${clock(timeline.endedAt)})`,
    "",
    "  início    fim       duração   etapa",
  ];
  for (const segment of timeline.segments) {
    const end = segment.endedAt ? clock(segment.endedAt) : "…";
    const duration = segment.endedAt
      ? formatDuration(
          (new Date(segment.endedAt).getTime() - new Date(segment.startedAt).getTime()) / 1000,
        )
      : "em andamento";
    lines.push(
      `  ${clock(segment.startedAt)} ${end.padEnd(9)} ${duration.padEnd(9)} ${segment.label}  [${segment.status}]`,
    );
  }
  lines.push("", `Totais: ${formatTotals({ ...timeline.totalsMs, intervalos: timeline.idleMs })}`);
  return lines;
}
