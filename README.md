# APO — Agent Orchestrator

Autonomous Software Factory local e provider-agnostic. Orquestra Claude Code, Codex e Gemini CLI para transformar um objetivo em alto nível numa Feature, decompor em Tasks, executar em paralelo com failover automático entre providers, e entregar um Pull Request após aprovação humana.

## Documentação

| Documento | Responde |
|---|---|
| [`PLAN.md`](./PLAN.md) | O que o sistema é e quais regras ele segue (fonte de verdade arquitetural) |
| [`ROADMAP.md`](./ROADMAP.md) | Em que ordem construir, por quê, e os adendos arquiteturais decididos ao longo do caminho |
| [`TECHNICAL_PLAN.md`](./TECHNICAL_PLAN.md) | Stack, contratos, modelo de dados, entregas e gates de saída de cada fase |
| [`EXAMPLES.md`](./EXAMPLES.md) | Exemplos de uso do sistema finalizado |

## Status

Em desenvolvimento — M0 (spikes e fundação).

## Desenvolvimento

```bash
pnpm install
pnpm db:up        # Postgres + pgvector via Docker
pnpm check        # lint + typecheck + test + build
```
