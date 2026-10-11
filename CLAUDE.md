# APO — instruções para o Claude Code

Orquestrador local de agentes de código (Claude Code, Codex, Antigravity): objetivo → DAG de Tasks em worktrees → integração → quality gates → review → aprovação humana → PR. Roda em produção na VM do homelab (`ubuntu-lab`); este repo no Mac é onde se desenvolve.

- Processo completo de desenvolvimento, testes e deploy: **[`docs/development.md`](./docs/development.md)**.
- Operação da VM: [`docs/homelab.md`](./docs/homelab.md). Uso: skill global `apo`.
- Arquitetura e histórico de decisões: `PLAN.md` (fonte de verdade), `TECHNICAL_PLAN.md` (marcos, gates, achados), `docs/adr/`.

## Regras

- Respostas, comentários e docs em português, com acentuação correta. Identificadores em inglês.
- **Commit e push só quando o usuário pedir.** Deploy na VM também.
- `pnpm check` verde antes de qualquer commit. Comportamento novo → teste novo (fluxo de ponta a ponta: `packages/orchestrator/src/feature-graph.test.ts`).
- Achado de teste real ou mudança de comportamento → registrar em `TECHNICAL_PLAN.md`. Decisão de arquitetura → ADR.
- Nunca editar `/opt/apo` na VM. Mudanças em produção passam por commit → push → `install.sh`.
- Antes de reiniciar o serviço ou a VM, perguntar: a VM roda outros serviços do usuário.
- Nunca imprimir segredos (`~/.apo/secrets.env`, tokens). Logins dos CLIs (claude/codex/gh) são sempre do usuário.

## Armadilhas conhecidas

- **Arquitetura:** `packages/orchestrator` não pode conter nomes de provider/harness concretos (`claude-code`, `codex`, `gemini-cli`), nem em testes — o `architecture.test.ts` falha. Só `apps/daemon/src/targets.ts` conhece harnesses concretos.
- **`awaiting_approval`** só pode ser escrito pelo node `prepare_delivery`, depois do `evaluateCompletion` (teste de arquitetura garante).
- **Status terminal da Feature** é escrito só pelo node `complete` do graph. Cancelamento viaja por `configurable.attemptControl`, nunca pelo `signal` do `invoke()`.
- **Graph:** use `recursionLimit: FEATURE_GRAPH_RECURSION_LIMIT` em todo `invoke` (o padrão do LangGraph, 25, estoura). Nodes precisam ser idempotentes (recovery re-invoca do início).
- **`exactOptionalPropertyTypes`** está ligado: use spread condicional (`...(x ? { x } : {})`) em vez de `x: undefined`.
- **Biome reformata** ao rodar `--write`; edições por substituição de texto podem não casar depois — releia antes de editar.
- **Saída de terminal:** o hook `rtk` filtra comandos como `git log`/`grep`; para ver a saída crua, prefixe com `rtk proxy`.
- **Codex `--output-schema`** é modo strict: o `CodexHarness` normaliza o schema (todo campo `required`, opcionais anuláveis). Escreva schemas zod normais.
- **Testes de integração** precisam do Postgres local (`pnpm db:up`).
