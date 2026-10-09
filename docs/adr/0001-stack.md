# ADR 0001 — Stack inicial

**Status:** aceito
**Contexto:** M0 — Spikes e fundação

## Decisão

Ver `TECHNICAL_PLAN.md`, seção 2 ("Decisões de stack"), para a tabela completa com justificativa por dependência (regra 12 do `PLAN.md`: nenhuma dependência nova sem justificar por que código simples não resolve).

Resumo:

| Área | Escolha |
|---|---|
| Runtime | Node.js 24, ESM, TypeScript `strict` |
| Monorepo | pnpm workspaces + `tsc -b` (project references) |
| Orquestração | `@langchain/langgraph` + checkpointer Postgres |
| Banco | PostgreSQL 17, imagem `pgvector/pgvector:pg17` desde o início |
| Acesso a dados | Drizzle ORM + drizzle-kit |
| Validação | zod |
| Config | YAML validado por zod |
| Logging | pino (JSON estruturado) |
| Processos | execa |
| CLI | commander |
| IPC CLI↔daemon | Fastify sobre Unix socket + SSE |
| Testes | Vitest |
| Lint/format | Biome |

## Consequências

- Uma linguagem só (TypeScript/Node) para CLI, daemon e todos os packages — evita contexto duplicado entre runtimes.
- `tsc -b` com project references dispensa bundler para o daemon/CLI, que rodam direto em Node.
- A imagem Postgres já inclui `pgvector` desde o M0, mesmo a extensão só sendo ativada no M5 — trocar de imagem depois do M0 seria retrabalho.
- Biome cobre lint+format com uma ferramenta só; regras de arquitetura (ex.: "nenhum literal de provider fora de `packages/harnesses`") são verificadas por teste, não por lint, porque são regras de dependência entre módulos, não de estilo de código.
- **Porta do Postgres: 5433, não 5432.** Descoberto durante o M0: este host já roda Postgres de outros projetos (`whatsapp_bot-postgres-1`) na 5432. `docker/compose.yaml` e o `DATABASE_URL` default (`drizzle.config.ts`, `connection.ts`) usam 5433 para não colidir.

## Revisão

Os itens marcados 🔬 na seção 6.2 do `TECHNICAL_PLAN.md` (flags dos CLIs: `--permission-mode`, `--sandbox`, resume nativo) são hipóteses a confirmar nos spikes (M0.9–M0.12). Este ADR não cobre essas decisões — elas têm ADR próprio (`0002-agent-harness.md`) depois do fechamento do M0.
