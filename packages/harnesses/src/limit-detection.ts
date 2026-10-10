// Detecção de limite de uso/quota por texto. Os CLIs nem sempre devolvem um
// status numérico quando a conta (assinatura) bate no limite.
//
// Fixture real (validação do M1, Codex com conta ChatGPT), que antes era
// classificada como "crash" e por isso nunca disparava failover:
//   "You’ve hit your usage limit. Upgrade to Pro (...), visit (...) to purchase
//    more credits or try again at 3:58 PM."

import type { AgentFailure } from "./types.js";

const QUOTA_PATTERNS = [
  /usage limit/i,
  /quota (?:exceeded|exhausted)/i,
  /out of credits/i,
  /purchase more credits/i,
  /limit (?:reached|exceeded)/i,
];

const RATE_LIMIT_PATTERNS = [/rate[ -]?limit/i, /too many requests/i, /\b429\b/];

/** Retorna `undefined` se o texto não indica limite de uso. */
export function detectLimitFailure(text: string, now: Date = new Date()): AgentFailure | undefined {
  const quota = QUOTA_PATTERNS.some((pattern) => pattern.test(text));
  const rate = RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
  if (!quota && !rate) {
    return undefined;
  }
  const resetAt = parseResetAt(text, now);
  return {
    kind: quota ? "quota_exhausted" : "rate_limited",
    message: text.trim().slice(0, 1000),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/**
 * Formatos suportados: "try again at 3:58 PM" (hora local; se já passou, é
 * amanhã) e "try again in 15 minutes|hours|seconds". Sem formato reconhecido,
 * `undefined` — o resetAt fica desconhecido (seção 15 do PLAN.md: nunca inventar).
 */
export function parseResetAt(text: string, now: Date = new Date()): Date | undefined {
  // "try again at Oct 10th, 2026 2:27 AM" — formato visto quando o reset é em outro dia.
  const dated =
    /try again at ([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(
      text,
    );
  if (dated) {
    const month = MONTHS.indexOf((dated[1] ?? "").toLowerCase());
    if (month >= 0) {
      const hours = to24h(Number(dated[4]), dated[6]);
      return new Date(Number(dated[3]), month, Number(dated[2]), hours, Number(dated[5]), 0, 0);
    }
  }

  const at = /try again at (\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text);
  if (at) {
    const hours = to24h(Number(at[1]), at[3]);
    const minutes = Number(at[2]);
    const reset = new Date(now);
    reset.setHours(hours, minutes, 0, 0);
    if (reset.getTime() <= now.getTime()) {
      reset.setDate(reset.getDate() + 1);
    }
    return reset;
  }

  const inMatch = /try again in (\d+)\s*(second|minute|hour)s?/i.exec(text);
  if (inMatch) {
    const amount = Number(inMatch[1]);
    const unit = inMatch[2]?.toLowerCase();
    const ms = unit === "hour" ? 3_600_000 : unit === "minute" ? 60_000 : 1_000;
    return new Date(now.getTime() + amount * ms);
  }

  return undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function to24h(hours: number, meridiem: string | undefined): number {
  const m = meridiem?.toUpperCase();
  if (m === "PM" && hours < 12) return hours + 12;
  if (m === "AM" && hours === 12) return 0;
  return hours;
}
