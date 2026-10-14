/**
 * Resumo de uma linha do objetivo para listagens: a primeira linha com texto,
 * espaços colapsados, cortada em `max` caracteres (o objetivo inteiro fica em
 * `apo feature show <id>`).
 */
export function summarizeObjective(objective: string, max = 80): string {
  const first = objective
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  if (!first) return "(sem objetivo)";
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}
