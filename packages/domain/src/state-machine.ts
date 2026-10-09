// Motor genérico de state machine. Toda transição de status no sistema passa
// por aqui — nenhum outro código altera status diretamente (seção 5.2 do
// TECHNICAL_PLAN.md). É determinístico de propósito (regra 10 do PLAN.md).

export class InvalidTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Transição inválida em ${entity}: "${from}" -> "${to}"`);
    this.name = "InvalidTransitionError";
  }
}

export function createTransitionTable<S extends string>(entries: Array<[S, S[]]>): Map<S, Set<S>> {
  const table = new Map<S, Set<S>>();
  for (const [from, tos] of entries) {
    table.set(from, new Set(tos));
  }
  return table;
}

export function canTransition<S extends string>(table: Map<S, Set<S>>, from: S, to: S): boolean {
  return table.get(from)?.has(to) ?? false;
}

export function transition<S extends string>(
  table: Map<S, Set<S>>,
  entityName: string,
  from: S,
  to: S,
): S {
  if (!canTransition(table, from, to)) {
    throw new InvalidTransitionError(entityName, from, to);
  }
  return to;
}
