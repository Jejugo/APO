# Desenvolvimento do APO

Como ajustar e evoluir o APO. Operação da VM: [`homelab.md`](./homelab.md). Uso do dia a dia: skill global `apo` (`~/.claude/skills/apo/SKILL.md`).

## Princípio

**O Mac é onde se desenvolve e testa; a VM só recebe versões prontas.** Nada é editado direto em `/opt/apo`. O caminho é sempre: Mac → `pnpm check` verde → commit → push → deploy na VM.

## Ambiente local

```bash
cd ~/Documents/1.\ Projects/apo
pnpm install
pnpm db:up          # Postgres 17 + pgvector no Docker (porta 5433), separado do banco da VM
pnpm db:migrate
pnpm check          # lint (Biome) + typecheck (tsc -b --force) + testes (Vitest) + build
```

Pacotes: `packages/{domain,config,db,observability,harnesses,routing,orchestrator,memory}`, `apps/{daemon,cli}`.

## Testes

| Suíte | Quando | Custo |
|---|---|---|
| `pnpm check` | sempre, antes de qualquer commit | grátis (FakeHarness + Postgres local) |
| `APO_LIVE_HARNESS_TESTS=1 pnpm vitest run packages/harnesses/src/contract.test.ts` | mudou algo em `packages/harnesses` (flags, parsing, sandbox) | API real (centavos) |
| `set -a; . ~/.apo/secrets.env; set +a; APO_LIVE_JEV=1 pnpm vitest run packages/routing/src/jev.live.test.ts` | mudou o `JevTaskRouter` ou a política de capacidade | ~US$ 0,0001 |
| Daemon local + repo descartável | mudou o graph, o daemon ou o fluxo de ponta a ponta | quota real |

O teste de integração do graph (`packages/orchestrator/src/feature-graph.test.ts`) cobre o fluxo inteiro com FakeHarness: DAG paralelo, conflito, failover, quality gates, review, loop de correção, aprovação (`interrupt`), PR, replan, memória, Jev fora do ar. Regressão nova vira teste ali.

### Daemon local para teste de ponta a ponta

```bash
unset APO_URL                                  # a CLI fala com o daemon local
node apps/cli/dist/main.js daemon start
git init /tmp/repo-teste && ...                # repo descartável com .apo/project.yaml
node apps/cli/dist/main.js project add /tmp/repo-teste
node apps/cli/dist/main.js run --project <id> "objetivo"
node apps/cli/dist/main.js logs <feature> -f
node apps/cli/dist/main.js daemon stop
```

O daemon local usa `~/.apo` do Mac (config, `secrets.env`, worktrees). Nunca aponte o daemon local para o banco da VM.

## Mudanças no banco

1. Altere `packages/db/src/schema.ts` (e os repositórios em `repositories.ts`).
2. `pnpm --filter @apo/db run generate` — gera `packages/db/migrations/NNNN_*.sql`.
3. Revise o SQL gerado. O drizzle-kit não gera `CREATE EXTENSION`; se precisar, acrescente no topo (ver `0007_*.sql`).
4. `pnpm db:migrate` local; a migration vai no commit e roda na VM pelo `install.sh`.

Migrations são só para frente. Voltar o código na VM **não** desfaz o banco — por isso o backup antes de deploy com migration arriscada (abaixo).

## Documentação

- Mudança de comportamento ou achado de teste real → `TECHNICAL_PLAN.md` (seção do marco correspondente, "Achados").
- Decisão de arquitetura → ADR novo em `docs/adr/NNNN-*.md`.
- Comando novo na CLI → atualize a skill global `apo` (`~/.agents/skills/apo/`, com symlinks em `~/.claude/skills` e `~/.codex/skills`; o procedimento do `apo init` fica em `init.md`).
- Mudança no deploy → `deploy/homelab/*` e `docs/homelab.md`.

## Deploy na VM

1. **Antes:** veja se há Feature rodando (`APO feature list --project <id>`). O deploy reinicia o serviço: o recovery retoma o que estava no meio, mas o attempt em andamento é refeito (gasta quota). Prefira deploy sem nada rodando.
2. **Migration arriscada:** backup na hora — `ssh 192.168.15.45 'sudo systemctl start apo-maintenance.service'` (grava `pg_dump` em `/home/apo/backups`).
3. **Deploy:**
   ```bash
   ssh 192.168.15.45 'sudo git -C /opt/apo pull --ff-only && sudo /opt/apo/deploy/homelab/install.sh'
   ```
   O `install.sh` é idempotente: rebuild como `root`, migrations como `apo`, units do systemd, restart.
4. **Depois:**
   ```bash
   ssh 192.168.15.45 'systemctl is-active apo && journalctl -u apo -n 20 --no-pager'
   APO status
   ```

### Rollback

```bash
ssh 192.168.15.45 'sudo git -C /opt/apo checkout <commit-bom> && sudo /opt/apo/deploy/homelab/install.sh'
```

Depois corrija no Mac e faça um deploy normal (o `pull --ff-only` volta a funcionar com `sudo git -C /opt/apo checkout main`). Se a versão ruim aplicou migration, restaure o backup (`docs/homelab.md`, "Restaurar backup").

## Mudanças sem código

| O quê | Onde | Efeito |
|---|---|---|
| Workers em paralelo, Jev, memória, acesso remoto | `/home/apo/.apo/config.yaml` na VM | `sudo systemctl restart apo` |
| Segredos (Jev, token) | `/home/apo/.apo/secrets.env` na VM (chmod 600) | `sudo systemctl restart apo` |
| Gates, review, prepare de um repo | `.apo/project.yaml` no repo | próxima Feature |
| Roles customizados | `.apo/roles/*.yaml` no repo | próxima Feature |
| Convenções | `APO memory add` | imediato |
| Versão dos CLIs dos agentes | `CLAUDE_CODE_VERSION` etc. em `deploy/homelab/install.sh` | próximo deploy |
