# APO — Plano técnico

Este documento detalha **como** implementar o [ROADMAP.md](./ROADMAP.md). A hierarquia entre os três documentos é:

| Documento | Responde | Muda quando |
|---|---|---|
| [PLAN.md](./PLAN.md) | O que o sistema é e quais regras ele segue | A visão do produto muda |
| [ROADMAP.md](./ROADMAP.md) | Em que ordem construir e por quê | Uma prioridade ou decisão de escopo muda |
| **TECHNICAL_PLAN.md** | Stack, contratos, modelo de dados e passos de cada fase | Um spike ou uma fase revela algo novo |

Regras de uso:

- Cada fase termina com um **gate de saída**. A fase seguinte só começa quando todos os itens do gate estão marcados (regra 1 do PLAN.md).
- Itens marcados com **🔬 validar no spike** são hipóteses sobre CLIs de terceiros. O spike do M0 confirma ou corrige, e este documento é atualizado.
- Os pacotes do monorepo nascem na fase em que são usados pela primeira vez, não antes (regra 3 do PLAN.md).

---

## 1. Ambiente verificado

Levantado na máquina de desenvolvimento (Mac) em 2026-10-08:

| Ferramenta | Versão | Situação |
|---|---|---|
| Node.js | 24.21.0 | OK (LTS atual) |
| pnpm | 12.4.2 | OK |
| Docker / Compose | 20.10.12 / v2.2.3 | Funciona, mas é antigo. Suficiente para um Postgres local. Atualizar se der problema. |
| git | 2.54.0 | OK (`git worktree` completo) |
| gh | 2.87.3 | OK (criação de PR no M4) |
| Claude Code | 2.1.295 | OK (harness do M1) |
| Codex CLI | 0.161.0 | OK (harness do M1) |
| Gemini CLI | — | **Não instalado.** Necessário no spike do M0 (para avaliação) e obrigatório no M3. |

---

## 2. Decisões de stack

Cada dependência abaixo tem justificativa, conforme a regra 12 do PLAN.md.

| Área | Escolha | Por quê |
|---|---|---|
| Runtime | Node.js 24, ESM, TypeScript `strict` | Os três CLIs-alvo e o LangGraph JS vivem no ecossistema Node. Uma linguagem só para tudo. |
| Monorepo | pnpm workspaces + `tsc -b` (project references) | Pedido do PLAN.md. `tsc -b` dispensa bundler: o daemon e a CLI rodam direto em Node. |
| Orquestração | `@langchain/langgraph` + `@langchain/langgraph-checkpoint-postgres` | Exigido pela seção 2.2 do PLAN.md. O checkpointer Postgres dá retomada após restart. |
| Banco | PostgreSQL 17 na imagem `pgvector/pgvector:pg17` | Uma imagem desde o M0. A extensão só é ativada no M5, mas trocar de imagem depois seria retrabalho. |
| Acesso a dados | Drizzle ORM + drizzle-kit (migrations) | Schema em TypeScript, migrations versionadas e suporte nativo a pgvector no M5. |
| Validação | zod | Valida tudo que vem de fora do processo: config, saída dos agentes, payloads de IPC, resposta do Jev. |
| Config | YAML (`yaml`) validado por zod | O PLAN.md já descreve a config em YAML (seções 18, 24 e 27). |
| Logging | pino (JSON estruturado) | A seção 31 do PLAN.md pede logs estruturados, sem dashboard. |
| Processos | execa | Timeout, cancelamento e kill de árvore de processos são fáceis de errar com `child_process` puro. |
| CLI | commander | Subcomandos aninhados (`apo task assign …`) sem código próprio de parsing. |
| IPC CLI ↔ daemon | Fastify sobre Unix socket (`~/.apo/apo.sock`) + SSE para eventos | O PLAN.md exige que a CLI fale com o daemon (seção 8). Socket local não abre porta de rede. No M6, o mesmo servidor passa a escutar também a interface Tailscale. |
| Testes | Vitest | Rápido, ESM nativo, mocks de módulo. |
| Lint/format | Biome | Uma ferramenta, zero plugin. As regras de arquitetura são verificadas por teste (seção 7), não por lint. |

### 2.1 Decisão importante: quem executa o raciocínio dos agentes persistentes

Lead (e, a partir do M3, PO e CTO — seção 4.6 do ROADMAP) precisam de LLM para planejar, triar intenção ambígua, revisar, verificar requisitos e dar julgamento de produto/arquitetura. A seção 19 do PLAN.md proíbe usar API paga automaticamente na V1.

**Decisão:** esses agentes rodam pelos **mesmos harnesses dos workers**, em modo read-only e com saída JSON validada por zod. Um componente `AgentRunner` (generaliza o que seria `LeadRunner`; contrato completo na seção 6.8) monta o prompt, chama `AgentHarness.execute()` com `workspaceMode: "shared"` e exige uma resposta no schema esperado — parametrizado pela persona invocada (`lead`, `product-owner`, `cto`).

Consequências:

- Nenhum custo de API. Tudo roda pelas assinaturas dos CLIs.
- Os agentes persistentes herdam failover e capacity routing de graça: se o Claude estiver esgotado, o planejamento vai para o Codex.
- São "persistentes" no sentido da seção 4 do PLAN.md: identidade, memória e estado ficam no Postgres (tabela `project_agents`, seção 5.1). Não existe processo de LLM sempre aberto — cada invocação é um `execute()` novo, carregando `memoryNamespace`/`conversationThreadId` como contexto, não uma sessão de CLI viva entre chamadas.
- **Só o Lead muta estado** (cria Task, muda requisito, aprova routing). PO e CTO são consultivos — o Lead invoca essas personas para obter julgamento, mas age sozinho sobre o resultado (seção 4.6 do ROADMAP).
- A única exceção é o Jev (M5), que é um serviço externo com API própria.

---

## 3. Arquitetura de execução

```text
┌─────────────┐   HTTP/JSON + SSE    ┌───────────────────────────────────────────┐
│  apo (CLI)  │ ───── Unix socket ──▶│                 apo daemon                 │
└─────────────┘   ~/.apo/apo.sock    │                                           │
                                     │  API (Fastify)                            │
                                     │   │                                       │
                                     │   ▼                                       │
                                     │  FeatureRunner ── LangGraph ── Postgres ◀─┼── checkpoints
                                     │   │                 graph       (state)   │   + tabelas de domínio
                                     │   ▼                                       │   + events
                                     │  WorkerManager ── ProcessSupervisor       │
                                     │   │                                       │
                                     │   ▼                                       │
                                     │  WorkspacePolicy ── WorktreeManager (git) │
                                     └───┬───────────────────────────────────────┘
                                         │ spawn (process group próprio)
                         ┌───────────────┼───────────────┐
                         ▼               ▼               ▼
                    claude -p        codex exec       gemini -p
                    (worktree A)     (worktree B)     (worktree C)
```

### 3.1 Princípios de execução

1. **A CLI não tem lógica de negócio.** Ela traduz argumentos em chamadas HTTP e formata respostas. `apo logs -f` consome o SSE.
2. **Uma Feature = uma thread do LangGraph, nos engines nativos.** `thread_id = featureId`. O checkpointer guarda o `FeatureState`. As tabelas de domínio guardam a verdade consultável (Task, attempts, resultados). Um engine externo (ADR 0003, ainda proposto) não teria thread do LangGraph: o APO guardaria só `externalExecutionId`.
3. **Workers são filhos do daemon.** Cada worker roda num process group próprio, para que cancelar mate a árvore inteira (o CLI e o que ele disparou, como `pnpm test`).
4. **Restart do daemon mata os workers.** Na V1, não tentamos reatar processos órfãos. Na volta, todo attempt `working` vira `interrupted` e a Task é retomada **pelo mesmo mecanismo de handover do failover** (seção 6.4). Um mecanismo único cobre crash, quota e restart.
5. **Git é a fonte de verdade do trabalho.** O que o agente diz que fez é só um indício. O que conta é o diff, os commits na branch da Task e os quality gates (regras 8 e 9 do PLAN.md).
6. **O APO decide o quê, onde e sob quais políticas; o engine decide como** (ADR 0003, proposto). O graph do M1 é o `SingleAgentEngine`. O contrato `ExecutionEngine` (seção 6.10) só vira código quando existir um segundo engine real. Nenhuma infraestrutura genérica de time (mensageria, ciclo de vida de teammates) é construída sem evidência de necessidade.

### 3.2 Diretórios

| Caminho (Mac, até M5) | Caminho (VM, M6) | Conteúdo |
|---|---|---|
| `~/.apo/config.yaml` | `/home/apo/.apo/config.yaml` | Config global: providers, limites, routing |
| `~/.apo/apo.sock` | idem | Socket do daemon |
| `~/.apo/logs/` | idem | Logs do daemon e um log por attempt |
| `~/.apo/worktrees/<project>/<feature>/<task>` | `/home/apo/worktrees/…` | Worktrees isoladas |
| `~/.apo/runs/<attemptId>/` | `/home/apo/runs/<attemptId>/` | `result.json` de cada attempt — nunca dentro do repo/worktree. Caminho passado ao worker via `APO_RESULT_PATH` (seção 6.3) |
| `<repo>/.apo/project.yaml` | idem | Config do Project: gates, preferências por role, `workspace.defaultMode`, `team.yaml` (seção 6.8) |
| `<repo>/.apo/roles/*.yaml` | idem | `RoleDefinition` do Project — substitui, por id, o default embutido correspondente |

---

## 4. Estrutura do repositório

Estado final esperado. A coluna "Nasce em" segue a regra 3 do PLAN.md.

```text
apo/
├── apps/
│   ├── cli/                  # commander, cliente HTTP do socket          (M1)
│   └── daemon/               # Fastify, bootstrap, recovery               (M1)
├── packages/
│   ├── domain/               # tipos, enums, state machines, zod schemas  (M0)
│   ├── config/               # carga e validação do YAML                  (M0)
│   │   └── default-roles/    # RoleDefinition embutidos (frontend, qa…)   (M2)
│   ├── db/                   # Drizzle schema, migrations, repositórios   (M0)
│   ├── observability/        # logger pino, emissor de eventos            (M0)
│   ├── harnesses/            # AgentHarness + adapters + FakeHarness      (M1)
│   │   └── src/
│   │       ├── claude-code/{harness.ts,capacity-collector.ts}            (collector no M3)
│   │       ├── codex/{harness.ts,capacity-collector.ts}
│   │       ├── gemini/{harness.ts,capacity-collector.ts}
│   │       └── fake/
│   ├── orchestrator/         # graph, nodes, AgentRunner, IntentTriage    (M1)
│   ├── git/                  # WorktreeManager, integração de branches    (M2)
│   ├── workers/              # WorkerManager, ProcessSupervisor           (M2)
│   ├── messaging/            # MessageBus, MessageRepository, AgentInbox  (M2)
│   ├── routing/              # resolver, RuleBasedRouter, CapacityMonitor (M3)
│   │   └── src/jev/          # JevTaskRouter                              (M5)
│   ├── quality/              # gates, completion contract                 (M4)
│   └── memory/               # embeddings, retrieval, writer              (M5)
├── fixtures/
│   └── sample-repo/          # projeto TS pequeno para testes e2e         (M0)
├── spikes/                   # scripts e relatórios dos spikes            (M0)
├── docker/compose.yaml       # Postgres + pgvector                        (M0)
├── docs/adr/                 # decisões de arquitetura                    (M0)
├── pnpm-workspace.yaml
└── package.json
```

Em relação à seção 34 do PLAN.md: `core` e `workflows` não existem como pacotes. Os templates de workflow cabem em `orchestrator` até terem tamanho próprio. `providers` virou `harnesses`, porque o pacote contém harnesses, não providers (seção 14 do PLAN.md).

---

## 5. Modelo de dados

### 5.1 Tabelas

| Tabela | Colunas principais | Nasce em |
|---|---|---|
| `projects` | `id`, `name`, `repo_path`, `default_branch`, `config_snapshot jsonb`, `created_at` | M1 |
| `project_agents` | `id`, `project_id`, `role_id`, `lifecycle` (`persistent`/`dynamic`), `execution_preference jsonb`, `memory_namespace`, `conversation_thread_id`, `enabled` | M1 (só `lead`; PO/CTO configuráveis a partir do M3) |
| `features` | `id`, `project_id`, `objective`, `intent` (`bugfix`/`feature`), `workflow_template`, `status`, `requirements jsonb`, `execution_preference jsonb`, `integration_branch`, `fix_iteration`, `pr_url`, timestamps | M1 |
| `tasks` | `id`, `feature_id`, `title`, `description`, `kind` (`read`/`write`), `role` (nullable, id do `RoleDefinition`), `expected_paths text[]` (nullable, estimativa do planner), `actual_changed_paths text[]` (nullable, via git diff), `status`, `dependencies text[]`, `complexity`, `risk`, `execution_preference jsonb`, `workspace_mode`, `worktree_path`, `branch`, `artifacts jsonb`, `origin` (`plan`/`review`/`quality`/`conflict`/`plan_change`/`overlap_absorbed`), timestamps | M1 (`role`/`expected_paths` a partir do M2.5; `actual_changed_paths` a partir do M2.12) |
| `task_attempts` | `id`, `task_id`, `n`, `provider`, `harness`, `model`, `resolution_source`, `status`, `failure_kind`, `pid`, `log_path`, `started_at`, `ended_at`, `handover_id` | M1 |
| `handovers` | `id`, `task_id`, `from_attempt_id`, `payload jsonb` (`TaskHandover`) | M3 |
| `provider_capacity` | `provider`, `availability`, `usage_percent` (nullable), `reset_at`, `reason`, `captured_at` | M3 |
| `routing_decisions` | `id`, `task_id`, `router` (`rule`/`jev`), `input jsonb`, `output jsonb`, `final_target jsonb`, `overridden_by_policy bool`, `confidence` | M3 |
| `quality_results` | `id`, `feature_id`, `iteration`, `gate`, `command`, `exit_code`, `passed`, `duration_ms`, `output_excerpt`, `log_path` | M4 |
| `review_findings` | `id`, `feature_id`, `iteration`, `severity`, `file`, `description`, `suggested_fix`, `generated_task_id` | M4 |
| `agent_messages` | `id`, `from_task_id`/`from_agent`, `to` (role dinâmica ou persona persistente), `feature_id`, `task_id` (nullable), `type` (`information`/`question`/`plan_change_request`/`handoff`/`review_feedback`), `content`, `delivery` (`mailbox`/`blocking`), `answer jsonb` (nullable), `created_at` | M2 (`information`/`question`; `plan_change_request` chega no M4) |
| `message_deliveries` | `message_id`, `task_id`, `delivered_at` | M2 — entrega é por (mensagem, Task), não um campo único na mensagem (seção 6.9) |
| `conversation_threads` / `conversation_messages` | thread por Project, mensagens do `apo chat` | M6 |
| `memories` | `id`, `project_id`, `category`, `content`, `source`, `content_hash`, `embedding vector(n)` | M5 |
| `events` | `id bigserial`, `type`, `project_id`, `feature_id`, `task_id`, `payload jsonb`, `created_at` | M0 |

`events` é **append-only**. É a base da seção 30 do PLAN.md e do `apo logs`.

### 5.2 Máquinas de estado

As transições são funções puras em `packages/domain`, testadas com tabela de casos. Nenhum outro código altera status diretamente. Todo `UPDATE` de status passa por `transition(entity, event)`, que rejeita transições inválidas e emite o evento correspondente.

**Feature** (unifica as seções 3, 19 e Phase 10 do PLAN.md):

```text
created → planning → executing → integrating → validating → reviewing ─┐
              ▲          │  ▲                                   │      │
              │          │  └──────── fixing ◀── (gate/review falhou)  │
              │          ▼                                            ▼
          (replan)  paused_capacity                          awaiting_approval
                                                               │        │
                                                          delivering  rejected
                                                               │
                                                           completed

De qualquer estado ativo: paused, cancelled, failed, needs_human
```

**Task:** `pending → ready → running → completed`, com desvios `running → retrying → running`, `running → failed`, `* → cancelled`, `retrying → needs_human` (Task com preferência `forced` e target indisponível, seção 14.1 do PLAN.md).

**TaskAttempt** (seção 13 do PLAN.md, mais `interrupted`): `starting → working → completed | failed | rate_limited | stalled | cancelled | interrupted`.

---

## 6. Contratos centrais

### 6.1 `AgentHarness`

**Fechado no spike M0.9/M0.10** (`spikes/claude-code.md`, `spikes/codex.md`). Claude Code e Codex confirmados reais; Gemini CLI segue aberto — ver `spikes/gemini.md` (bloqueado na autenticação, seção 6.2 mantém esse provider como hipótese não confirmada).

```ts
interface AgentHarness {
  readonly id: HarnessId;            // "claude-code" | "codex" | "gemini-cli" | "fake"
  readonly provider: ProviderId;     // "anthropic" | "openai" | "google"

  getCapabilities(): AgentCapabilities;

  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult>;

  // Só dentro do mesmo harness. Entre providers vale o handover (seção 6.4).
  resume?(input: ResumeExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult>;
}

interface AgentExecutionInput {
  prompt: string;
  cwd: string;
  mode: "read-only" | "workspace-write";
  networkAccess: boolean;             // só relevante em "workspace-write" — seção 6.2
  model?: string;
  outputSchema?: JsonSchema;          // para chamadas do LeadRunner
  timeoutMs: number;                  // obrigatório, sem default "confortável" — ver nota abaixo
  logPath: string;                    // stdout/stderr bruto vai para cá
}

interface AgentExecutionResult {
  outcome: "success" | "failure";
  failure?: { kind: FailureKind; message: string; resetAt?: Date };
  sessionId?: string;                 // habilita resume nativo
  finalMessage?: string;
  structuredOutput?: unknown;         // validado por zod no chamador
  durationMs: number;
}

type FailureKind =
  | "rate_limited"      // temporário, há resetAt     → provider degraded
  | "quota_exhausted"   // sem capacidade no período  → provider exhausted
  | "auth"              // credencial inválida        → provider unavailable, alerta humano
  | "timeout"
  | "stalled"           // sem saída nem mudança em disco por N minutos
  | "crash"             // exit code inesperado
  | "cancelled"
  | "invalid_output";   // saída não bate com outputSchema
```

Cada adapter tem um `classifyFailure(exitCode, stderrTail, events)` próprio, testado contra **fixtures reais capturadas no spike** (ver os dois formatos de `auth` e os dois de "modelo inexistente" registrados em `spikes/claude-code.md` §7 e `spikes/codex.md` §7).

**`timeoutMs` é obrigatório, não uma boa prática opcional — confirmado pelos dois spikes.** Claude Code com credencial inválida levou **~4,4 minutos** para retornar um erro `401` estruturado (lento, não travado — mas 4,4min é inaceitável sem timeout); Codex com credencial inválida tenta reconectar via WebSocket e depois HTTPS, **5 tentativas em cada canal**, adicionando ~10-15s antes do `401` definitivo. O `ProcessSupervisor` nunca pode esperar indefinidamente por "ainda não respondeu" — precisa de um teto por `TaskAttempt`, calibrado acima desses pisos conhecidos.

**Isolamento de settings do operador — achado novo, não previsto na versão anterior deste documento.** Os dois CLIs, por padrão, carregam configuração pessoal do usuário que roda o daemon (não só `process.env`, que já era coberto por `buildWorkerEnvironment()` — seção 6.3):

- Claude Code carrega `CLAUDE.md`/hooks globais do usuário (confirmado: o hook `rtk` pessoal do operador foi aplicado dentro de uma Task headless, reescrevendo comandos). `--bare` resolve isso, mas força autenticação só via `ANTHROPIC_API_KEY`/`apiKeyHelper` — ignora OAuth/keychain. Como a autenticação real desta máquina é OAuth, o adapter precisa decidir entre (a) manter OAuth e aceitar o vazamento de settings pessoais, ou (b) usar `--bare` e garantir `ANTHROPIC_API_KEY` no `buildWorkerEnvironment()`. **Decisão para M1:** usar `--setting-sources` vazio (nenhuma fonte de settings local/projeto/usuário) em vez de `--bare`, porque preserva a auth OAuth existente e ainda bloqueia `CLAUDE.md`/hooks — a ser confirmado num spike de acompanhamento antes do M1.5 (adapter real).
- Codex carrega `~/.codex/config.toml` e `~/.codex/hooks.json` por padrão (mesmo achado: a regra `rtk` pessoal foi aplicada). **Decisão para M1:** todo spawn do `CodexHarness` inclui `--ignore-user-config` por padrão.

**Confinamento de escrita não é garantido só pela flag de sandbox — achado crítico do spike M0.10.** `codex exec -s workspace-write` (sem `--add-dir` extra) **não bloqueou** escrita em `../fora-do-workspace.txt` (relativo, escapando do cwd) nem em `/tmp/...` (caminho absoluto fora de qualquer workspace). A tabela da seção 6.2 anterior assumia que a flag de sandbox por si só bastava para a garantia de isolamento do `WorkspacePolicy` — não basta. Mitigação adotada (defesa em profundidade, não uma única barreira):

1. A flag de sandbox continua sendo a primeira linha de defesa (ela funcionou perfeitamente para `read-only`, só falhou em conter `workspace-write` aos limites esperados).
2. **Pós-execução, o `WorkerManager` verifica `actualChangedPaths`** (seção 6.3) contra os limites do worktree. Mas atenção: `git diff --name-only` só vê mudanças **dentro do repositório git do worktree** — uma escrita em `/tmp` ou em um diretório irmão fora da árvore git é **invisível** a esse diff. Por isso o `WorkerManager` também captura um snapshot raso (antes/depois, só nomes + mtime, não conteúdo) de um conjunto fixo de "zonas de risco conhecidas" (`$TMPDIR`, o diretório pai do worktree) e levanta a Task para `needs_human` se qualquer arquivo novo ou modificado aparecer ali durante a execução.
3. Isolamento real por processo (container, VM, namespaces) é a solução definitiva, mas só fica natural quando a execução sai do Mac do dev — que é o M6 (ver decisão de roadmap registrada em memória: Mac até o M5, VM só no M6). Até lá, (1)+(2) são a defesa disponível, documentadas como mitigação deliberadamente parcial, não como solução.

#### `CapacityCollector` (dentro de cada harness)

Conhecimento de usage/quota é tão específico de provider quanto `classifyFailure` — por isso vive no mesmo lugar, nunca em `packages/routing`:

```ts
interface CapacityCollector {
  collect(): Promise<ProviderCapacitySnapshot>;
}
```

Cada harness implementa a sua (`packages/harnesses/<provider>/capacity-collector.ts`), usando o que o spike (M0, item 9) mostrar disponível — arquivo local, comando do CLI, ou nada (fica `unknown`, seção 15 do PLAN.md). O `CapacityMonitor` (M3.3, em `packages/routing`) só consome a interface genérica, nunca sabe que provider está por trás. Isso evita a violação de `if (provider === "codex")` fora da camada de adapters (regra 4 do PLAN.md) — um erro fácil de cometer aqui porque `CapacityMonitor` e os collectors concretos são conceitualmente vizinhos.

### 6.2 Mapeamento de flags

**Claude Code e Codex confirmados por execução real** (`spikes/claude-code.md`, `spikes/codex.md`, M0.9/M0.10). **Gemini CLI permanece 🔬 não confirmado** — instalado, mas bloqueado na autenticação (`spikes/gemini.md`, M0.11); a coluna abaixo é só o que o `--help` documenta, sem nenhuma execução real por trás.

| Necessidade | Claude Code | Codex | Gemini CLI (🔬 não confirmado) |
|---|---|---|---|
| Modo headless | `claude -p --output-format json` | `codex exec --json -o <arquivo>` | `gemini -p` |
| Saída estruturada | `--output-format json` (resultado único) ou `--json-schema <schema>` para forçar formato — 10/10 válidas no spike | JSONL de eventos (`thread.started`, `item.*`, `turn.completed`); para resultado final tipado, `--output-schema <arquivo>` + `-o`. **Exige `additionalProperties: false` no nível raiz do schema** (modo strict da OpenAI — achado do M1.4, não do spike original; `spikes/codex.md` §2 foi corrigido). `CodexHarness` normaliza isso automaticamente, então `AgentExecutionInput.outputSchema` é o mesmo objeto para os dois harnesses | `-o/--output-format json` |
| Read-only | `--permission-mode plan` — bloqueio real; mecanismo é a ferramenta `ExitPlanMode` não existir em modo headless | `-s read-only` — bloqueio real confirmado | `--approval-mode plan` |
| Escrita restrita ao workspace | `--permission-prompts none` nega automaticamente escrita fora de `cwd`/`--add-dir`; negação aparece estruturada em `permission_denials` na saída JSON | `-s workspace-write` — **não confina de fato** (escreveu em `../` e em `/tmp` absoluto no spike); ver mitigação na seção 6.1 | `-s/--sandbox` é booleano (não enum); semântica exata não testada |
| Rede em modo de escrita | Não sandboxada por padrão — `pnpm install` funcionou sem flag extra | Bloqueada por padrão em `workspace-write` (confirmado); liberar com `-c 'sandbox_workspace_write.network_access=true'` | não testado |
| Sem prompts (YOLO) | `--dangerously-skip-permissions` (não testado ao vivo — baixo risco, já documentado no `--help`) | `--full-auto`/`--ask-for-approval never` **não existem em `codex exec`** (só no `codex` top-level); exec já é "sem prompts" por padrão; bypass total real é `--dangerously-bypass-approvals-and-sandbox` | `-y/--yolo` ou `--approval-mode yolo` |
| Isolar settings pessoais do operador | `--setting-sources` vazio (decisão M1, não testado ainda — ver 6.1) | `--ignore-user-config` (confirmado, neutraliza `~/.codex/config.toml`/`hooks.json`) | não avaliado |
| Modelo | `--model` | `-m/--model` | `-m/--model` |
| Resume nativo | `--resume <session_id>` — funciona após `kill`, mas resume é de **sessão**, não de **turno em andamento**: turno morto sem conteúdo persistido é reexecutado do zero | `codex exec resume <thread_id>` — funciona após `kill -9`; **não aceita `-s`**, sandbox/rede do resume devem ser re-especificados via `-c sandbox_mode="..."` e `-c sandbox_workspace_write.network_access=true`, senão herda a política mais restritiva | `-r/--resume <latest\|índice>` ou `--session-id <uuid>` na criação |
| Stdin | sem achado relevante | **sem stdin fechado explicitamente, `codex exec` trava indefinidamente** esperando EOF — `ProcessSupervisor` deve sempre redirecionar `< /dev/null` ao spawnar (precaução: aplicar aos três harnesses) | não avaliado |
| Usage/quota exposto | só por execução, campos `usage`/`total_cost_usd` na saída — sem medidor agregado de conta | só por turno, bloco `usage` em `turn.completed` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`) — sem endpoint de quota; `CapacityCollector` acumula localmente por Task | não avaliado |

**Daemon/infraestrutura compartilhada (Codex):** `codex exec` roda sobre um app-server daemon persistente por máquina (`~/.codex/app-server-daemon/`), independente de qualquer Task — matar o processo `codex exec` nunca derruba esse daemon (comportamento correto, confirmado). O `ProcessSupervisor` deve rastrear só o PID/PGID do processo `codex exec` que ele próprio spawnou, nunca o do daemon.

### 6.3 Protocolo de resultado do worker

**Onde o worker escreve o resultado — fora do repo.** O worker recebe a variável `APO_RESULT_PATH=~/.apo/runs/<attemptId>/result.json` (seção 3.2) e o prompt diz explicitamente: `Write your final structured report to $APO_RESULT_PATH`. Nunca `<worktree>/.apo/result.json` — isso arriscaria o arquivo operacional do APO entrar num commit ou PR do produto. O repo só contém código do produto; `~/.apo/` é todo o estado operacional do orchestrator.

Todo worker recebe no prompt a instrução de:

1. trabalhar apenas no diretório recebido;
2. fazer commit do trabalho na branch atual;
3. escrever o `WorkerReport` em `$APO_RESULT_PATH`.

```ts
interface WorkerReport {
  summary: string;
  commandsRun: string[];
  testsRun: string[];
  artifacts?: Record<string, unknown>;
  planChangeRequests?: PlanChangeRequest[];
  outgoingMessages?: Array<{ to: RoleId | PersonaId; type: "information" | "question"; content: string }>;
  blockedQuestion?: { to: PersonaId; content: string }; // só personas persistentes podem bloquear — seção 6.9
}
```

**Environment do worker — allowlist, não denylist.** O `ProcessSupervisor` nunca repassa `process.env` do daemon inteiro (o padrão do `execa` quando nada é passado). `buildWorkerEnvironment()` monta o environment do zero:

```ts
function buildWorkerEnvironment(project: ProjectConfig): Record<string, string> {
  const base = pick(process.env, ["HOME", "PATH", "SHELL", "TERM", "NODE_ENV"]);
  const authorized = pick(process.env, project.worker?.env?.allow ?? []);
  return { ...base, ...authorized, APO_RESULT_PATH: /* … */ };
}
```

Isso é especialmente importante em YOLO: sem allowlist, `DATABASE_URL`, `JEV_API_KEY`, `GITHUB_TOKEN` e o token do próprio daemon ficariam visíveis a um worker com permissão de executar comandos livremente. Nenhuma dessas credenciais tem motivo para existir no environment do worker — as operações que as usam (Postgres, Jev, criação de PR) são sempre feitas pelo daemon, nunca pelo worker.

Depois que o processo termina, o `WorkerManager` monta o `TaskOutcome` **deterministicamente**:

| Sinal | Fonte | Peso |
|---|---|---|
| Processo terminou com sucesso | exit code + classificação do adapter | necessário |
| Há commits novos na branch (Tasks `write`) | `git log base..HEAD` | necessário |
| Working tree limpa | `git status --porcelain` | se sujo, o `WorkerManager` faz um commit `wip` e marca a Task |
| `$APO_RESULT_PATH` válido | zod | opcional: ausente ou inválido gera aviso, não falha |
| Verificação local da Task | comando de teste, se a Task definir | necessário quando existir |

O `WorkerManager` também calcula `actualChangedPaths` a partir de `git diff --name-only base..HEAD` e persiste em `tasks.actual_changed_paths` — dado determinístico, não auto-relatado, usado para calibrar `expectedPaths` (seção 6.6) e, no M5, como memória de precisão de planejamento.

O `WorkerReport` alimenta handover, artefatos e mensagens, mas **nunca** decide sozinho que a Task concluiu (regra 8 do PLAN.md).

### 6.4 `TaskHandover`

Quando um attempt termina em `rate_limited`, `quota_exhausted`, `stalled`, `crash` ou `interrupted`, o agente que falhou **não pode** ser usado para resumir o próprio trabalho, porque ele está justamente sem quota ou morto. Por isso o handover é montado em duas camadas:

1. **Camada determinística (sempre):** `git diff base..HEAD`, `changedFiles`, comandos e testes extraídos do log estruturado do attempt, última mensagem do agente, `.apo/result.json` parcial se existir.
2. **Camada semântica (opcional):** se houver um provider disponível, o `LeadRunner` gera `completedWork`, `currentState` e `recommendedNextSteps` a partir da camada 1. Se não houver, o handover segue só com a camada determinística, e o novo worker recebe o diff e o log.

Antes de qualquer handover, o `WorkerManager` commita o estado da worktree como `apo: wip handover (attempt N)`, para que nada se perca.

### 6.5 `ExecutionTargetResolver`

Implementa a hierarquia da seção 14.1 do PLAN.md como função pura:

```text
preferência efetiva = primeira definida entre
  Task override → Feature override → Role preference (project.yaml) → (router) → global default

mode = forced    → usa o target. Indisponível → Task needs_human.
mode = preferred → usa o target se disponível; senão consulta o router e registra o motivo.
mode = auto      → consulta o router (RuleBasedRouter no M3, Jev no M5).
```

O resultado sempre registra `resolutionSource` e grava uma linha em `routing_decisions` (regra 7 do PLAN.md).

### 6.6 `FeatureOverlapCheck`

Resolve dependência **entre** Features (seção 4.4 do ROADMAP), não entre Tasks (isso já é a seção 11 do PLAN.md). Roda uma vez, antes de `plan_feature`, só para objetivos classificados como `bugfix`/`feature` pelo `IntentTriage`.

```ts
interface FeatureOverlapInput {
  projectId: string;
  objective: string;
  activeFeatures: Array<{
    featureId: string;
    objective: string;
    expectedPaths: string[];      // dos planos já gerados dessas Features — mesmo
                                   // campo que o planner (M2.5) agora produz
  }>;
}

interface FeatureOverlapResult {
  decision: "isolated" | "ask_user";  // nunca "absorbed" automaticamente — ver revisão
  overlappingFeatureId?: string;      // presente quando "ask_user"
  sharedPaths: string[];
}
```

**Revisão: sem auto-absorb.** A primeira versão tinha um terceiro resultado (`absorbed`) decidido automaticamente quando a camada semântica tinha confiança alta. Removido: a interseção de `expectedPaths` é um sinal fraco — dois arquivos colidirem no path não implica relação semântica real (`src/routes.ts` tocado por duas Features pode ser coincidência) — e absorver errado é caro de desfazer. O algoritmo agora só decide **se vale perguntar**, nunca o que fazer:

1. **Determinística:** interseção entre os `expectedPaths` de cada Feature ativa e os `expectedPaths` do objetivo novo (gerados pelo mesmo planner, M2.5 — não mais um grep ad hoc sobre o texto do objetivo). Interseção vazia → `isolated` direto, sem gastar uma chamada ao `AgentRunner`.
2. **Semântica (só se a camada 1 achar algo):** `AgentRunner` (persona `lead`) recebe o objetivo novo e o objetivo+paths da Feature que colidiu, e avalia se a interseção é relevante o suficiente para interromper o usuário, ou se é ruído (ex.: os dois tocam `src/routes.ts`, mas em rotas completamente diferentes). Relevante → `ask_user`. Ruído → `isolated`.

Query de Features ativas: `status IN (planning, executing, integrating, validating, reviewing, fixing)` do mesmo `projectId`. Uma Feature em `awaiting_approval`, `paused_capacity` ou `completed` não entra na comparação — a primeira porque já não aceita novas Tasks sem reabrir, as outras porque não têm branch de integração "viva" no sentido relevante aqui.

**Caminho `ask_user`:** síncrono, na CLI (`apo run` imprime o conflito e as duas opções) ou no `apo chat`. Não usa `interrupt()` do LangGraph porque nenhum graph foi iniciado ainda. A resposta do humano decide:

- **"Isolar"** → segue o fluxo normal do M1/M2, Feature nova, nada muda.
- **"Absorver"** → não cria `features` nova. Chama o mesmo primitivo de "anexar Tasks a uma Feature em execução" que o M2.8 já precisa (Task corretiva de conflito). As novas Tasks entram com `origin: "overlap_absorbed"` e `description` incluindo o objetivo original literal, para rastreabilidade. Emite `feature.request_absorbed` em `events`, com `{ originalObjective, intoFeatureId, taskIds }`.

**Caminho `isolated`:** segue o fluxo normal do M1/M2 — nada muda.

### 6.7 `Role` e `PromptBuilder`

Formaliza a seção 4.5 do ROADMAP. `Role` é dado de configuração, não um agente — reaproveita o campo que a hierarquia da seção 14.1 do PLAN.md já previa, dando a ele um segundo uso.

```ts
interface RoleDefinition {
  id: string;                               // "frontend-developer"
  displayName?: string;
  systemPrompt: string;                     // texto livre, injetado no prompt do worker
  executionPreference?: ExecutionPreference; // mesmo tipo da seção 14.1 do PLAN.md
}
```

**Origem e resolução**, nessa ordem — um id no Project substitui o default embutido por inteiro, sem merge parcial:

```text
packages/config/src/default-roles/*.yaml   (embutidos: generic, frontend-developer,
                                             backend-developer, qa-engineer, reviewer)
                ↓ sobrescrito por id
<repo>/.apo/roles/*.yaml                    (do Project, opcional)
                ↓
         RoleRegistry (carregado uma vez por Project, validado por zod)
```

Role desconhecido (o planner propôs um id fora do registry) → fallback para `generic` (`systemPrompt: ""`) + evento `task.unknown_role`. Nunca falha a Feature por isso (regra 6 do PLAN.md).

**`PromptBuilder`** monta o prompt final do worker nesta ordem fixa, cada camada com uma função diferente:

```text
1. Role.systemPrompt           — identidade/expertise (quem o worker é)
2. Contrato padrão do worker   — regras fixas e não-negociáveis: só o cwd recebido,
   (seção 6.3)                   commit na branch, escrever .apo/result.json
3. Contexto da Task             — título, descrição, requisitos, artefatos das
                                   Tasks dependentes (M2.9), handover (M3.7) se
                                   for retry, memória relevante (M5+)
```

A camada 2 é reforçada pelo sandbox do próprio harness (`--permission-mode`/`--sandbox`, seção 6.2), não só pelo texto do prompt — um `systemPrompt` de role nunca pode, na prática, autorizar escrita fora do workspace preparado, porque isso é imposto pelo adapter, não pela boa vontade do texto.

**Menção a skills do CLI** (ex.: "utilize a skill X"): fica dentro do `systemPrompt` como texto livre. Não existe um campo estruturado para isso na V1 — o Claude Code já expõe as skills disponíveis ao próprio modelo durante a execução, então mencionar o nome da skill no prompt é suficiente para o harness que a suporta. Harnesses sem conceito de skill (Codex, Gemini CLI, a confirmar no spike) simplesmente ignoram a menção. Se isso se mostrar pouco confiável em uso real, um campo estruturado por harness é a extensão natural — não construir antes de ter esse dado.

### 6.8 `AgentRunner` e `ProjectAgent`

Formaliza a seção 4.6 do ROADMAP. Generaliza o `LeadRunner` (seção 2.1) para múltiplas personas persistentes.

```ts
interface ProjectAgent {
  id: string;                 // "lead" | "product-owner" | "cto" | …
  projectId: string;
  roleId: string;             // aponta para um RoleDefinition (seção 6.7) — reaproveita systemPrompt
  lifecycle: "persistent" | "dynamic";
  executionPreference?: ExecutionPreference;
  memoryNamespace?: string;        // usado a partir do M5
  conversationThreadId?: string;   // usado a partir do M6 (apo chat)
  enabled: boolean;
}

interface AgentRunner {
  run(persona: string, input: AgentRunInput, signal: AbortSignal): Promise<AgentRunResult>;
}
```

`AgentRunner.run()` resolve `persona` → `ProjectAgent` → `RoleDefinition.systemPrompt` → `ExecutionTargetResolver` (mesmo resolver do M3.5, modo read-only) → `AgentHarness.execute()`. Cada chamada é um `execute()` novo — "persistente" nunca significa processo aberto, significa que `memoryNamespace`/`conversationThreadId` dão continuidade de contexto entre chamadas, não que exista uma sessão de CLI viva entre elas.

Só a persona `lead` tem autoridade de mutação: é a única cujo retorno pode disparar `create_task`, `update_requirement`, `set_preference`, etc. (mesmas ações da seção M6.3). As personas `product-owner` e `cto` só devolvem julgamento (texto estruturado); é sempre o Lead que decide o que fazer com ele.

**Onde entra:** `ProjectAgent`/`AgentRunner` com só a persona `lead` habilitada por padrão, no **M1** (é renomear o que seria `LeadRunner`, sem comportamento novo). `product-owner`/`cto` configuráveis via `team.yaml`, e `questionPolicy` por role (seção 6.9) roteando perguntas até eles, no **M3**.

### 6.9 `MessageBus` / `AgentInbox`

Formaliza a revisão da seção 4.2 do ROADMAP. Resolve `AgentMessage.to` em dois caminhos, nunca num canal ao vivo:

```ts
interface AgentMessage {
  id: string;
  from: { taskId?: string; agentId?: string }; // worker ou persona
  to: RoleId | PersonaId;
  featureId: string;
  taskId?: string;
  type: "information" | "question" | "plan_change_request" | "handoff" | "review_feedback";
  content: string;
  delivery: "mailbox" | "blocking";
  answer?: { content: string; by: PersonaId; confidence?: number };
  createdAt: Date;
}

// entrega rastreada por (mensagem, Task) — não por um campo único na
// mensagem, porque uma mensagem de role é broadcast (ver abaixo)
interface MessageDelivery {
  messageId: string;
  taskId: string;
  deliveredAt: Date;
}
```

```text
MessageBus.send(message)
 ↓
to resolve para RoleId (role dinâmica)?
 ↓ sim                                    ↓ não (PersonaId — lead/product-owner/cto)
delivery: "mailbox"                       delivery: "blocking" só se type === "question"
persiste em agent_messages,                ↓
não bloqueia quem enviou                  Task → awaiting_answer
 ↓                                         ↓
AgentInbox.pendingFor(role, task)         AgentRunner.run(persona, {question, contexto})
chamado pelo PromptBuilder (seção 6.7)     ↓
ao montar o prompt do PRÓXIMO worker       resposta persistida em agent_messages.answer
que nascer com aquela role/Task            ↓
                                           nova attempt da Task, resume
                                           (nativo se o harness suportar, senão
                                           fresh execute com a resposta no contexto)
```

`type: "information"` e `type: "question"` endereçadas a uma role dinâmica são **sempre** `delivery: "mailbox"` — nunca bloqueiam quem envia, mesmo que o destinatário já tenha uma Task em andamento, porque esse destinatário pode nunca ter começado ou já ter terminado (o problema de viabilidade original desta seção). Só `question` endereçada a uma persona persistente pode ser `blocking`, porque esse destinatário está sempre disponível por construção (seção 6.8).

**Semântica de entrega da mailbox (revisão — detalhe que faltava):**

- **Broadcast por (Feature, role), não consumo único.** Uma mensagem endereçada a uma role dinâmica (ex.: `backend-developer`) é visível a **qualquer** Task daquela role na Feature que ainda não tenha uma linha em `message_deliveries` para ela — não só a primeira que passar. Se duas Tasks de backend nascerem depois da mensagem, as duas a veem. É mais parecido com um tópico escopado por (Feature, role) do que com uma fila ponto-a-ponto de consumidor único.
- **Ordem: FIFO por `created_at`.** `AgentInbox.pendingFor(role, task)` sempre devolve `ORDER BY created_at ASC`.
- **Teto por chamada.** No máximo `messageCapPerRole` (config, padrão 10) mensagens pendentes entram no prompt. Se houver mais, a nota `"+N mensagens mais antigas omitidas"` entra no lugar — nunca um prompt sem limite de tamanho.
- **Mensagem nunca entregue não desaparece em silêncio.** Quando a Feature entra em qualquer status terminal (`completed`, `failed`, `cancelled` — mesmo hook de `transition()` do M0.4, seção 5.2), uma verificação varre `agent_messages` sem nenhuma linha correspondente em `message_deliveries` e emite `messages.undelivered` por mensagem, visível no relatório final da Feature. Uma informação que devia ter chegado e não chegou é pior que um erro explícito.

`questionPolicy` (em `RoleDefinition`, estendendo o schema da seção 6.7) decide **qual persona** responde uma `question` bloqueante, por tópico:

```ts
interface RoleDefinition {
  // … campos existentes (seção 6.7)
  questionPolicy?: Record<string, "lead" | "product-owner" | "cto" | "human">;
}
```

```yaml
roles:
  qa-engineer:
    questionPolicy:
      scope: human        # escopo de produto sempre escala ao humano
      default: lead
  frontend-developer:
    questionPolicy:
      architecture: cto    # decisão arquitetural vai para a persona CTO
      default: lead
```

`human` força `Task → needs_human` (mesmo status já usado para `forced` indisponível e `maxFixIterations` excedido) em vez de invocar um `AgentRunner` — resolvido por `apo task answer <id> "resposta"`, que persiste a resposta e dispara a nova attempt.

**Onde entra:** `MessageBus`, `AgentInbox` e a tabela `agent_messages` (tipos `information`/`question`, resolvendo sempre para a persona `lead` quando bloqueante) no **M2** — mesmo milestone que já constrói `WorkerManager`/`PromptBuilder`, de quem isso é vizinho direto. `questionPolicy`, as personas PO/CTO e o roteamento por tópico chegam no **M3**, junto da extensão de `team.yaml` (seção 6.8). `plan_change_request` continua no M4 (depende do loop de correção e do Lead avaliando impacto, que só maduram ali).

---

### 6.10 `ExecutionEngine` (proposto — ADR 0003, não implementado)

Abstração acima do `AgentHarness`: a estratégia que executa uma Feature inteira. O `AgentHarness` (seção 6.1) não muda.

```ts
interface ExecutionEngine {
  id: string;
  getCapabilities(): EngineCapabilities;
  execute(input: EngineExecutionInput): Promise<ExecutionHandle>;
  getStatus(handle: ExecutionHandle): Promise<ExecutionStatus>;
  cancel(handle: ExecutionHandle): Promise<void>;
}
```

**Esse esboço não é contrato.** Ele só vira código quando um segundo engine real existir, seja o `ApoNativeEngine` (DAG do M2) ou um externo que passe no critério do ADR 0003. Com um único engine, a interface seria abstração sem uso (regra 3 do PLAN.md). Até lá:

- O `SingleAgentEngine` é o graph do M1 (`packages/orchestrator/src/feature-graph.ts`), chamado direto pelo `FeatureRunner` (`apps/daemon`).
- Quando entrar o segundo engine, o `FeatureRunner` passa a escolher o engine via um `ExecutionStrategyRouter`, e o schema ganha algo como `feature_executions(feature_id, engine_id, status, external_execution_id, graph_thread_id)`, com `graph_thread_id` nullable, já que só engines baseados em LangGraph o têm.
- O estado interno de um engine externo nunca é replicado no APO. Fica só a referência (`external_execution_id`) e o último status conhecido.

## 7. Estratégia de testes

| Camada | O que testa | Ferramentas | Nasce em |
|---|---|---|---|
| Unitário | state machines, resolver, capacity policy, DAG, IntentTriage, completion contract | Vitest, funções puras | M0 |
| Contrato de harness | os mesmos cenários rodam contra todos os adapters | suíte compartilhada, parametrizada por harness | M1 |
| Classificação de falhas | `classifyFailure` contra saídas reais gravadas | fixtures do spike em `harnesses/*/fixtures/` | M1 |
| Integração com banco | repositórios e checkpointer | Postgres do compose, um schema por execução de teste | M0 |
| Git | worktrees, merge, conflitos | repositórios temporários criados no teste | M2 |
| E2E determinístico | pipeline inteiro sem gastar quota | **`FakeHarness`** + `fixtures/sample-repo` | M1 |
| E2E real | pipeline com Claude Code e Codex de verdade | `pnpm test:e2e:real`, manual, fora do `pnpm test` | M1 |
| Arquitetura | `orchestrator`, `routing`, `workers` e `messaging` não importam adapters nem contêm literais de provider; nenhum `CapacityCollector` concreto vive fora de `packages/harnesses/*` | teste que varre os imports e o código-fonte | M1 (estendido no M3 para collectors) |

### 7.1 `FakeHarness`

É a peça que torna o projeto testável. É um harness roteirizado:

```ts
new FakeHarness("fake-a", {
  script: [
    { writeFile: "src/ProductCard.tsx", content: "…" },
    { commit: "feat: ProductCard" },
    { fail: "rate_limited", resetInMs: 60_000 },   // simula quota no meio da Task
  ],
});
```

Com ele, failover, recovery, paralelismo, conflitos de merge e loops de review são testados em segundos e sem custo. O cenário da seção 38 do PLAN.md roda primeiro inteiramente com `FakeHarness` e depois em versão real.

### 7.2 `fixtures/sample-repo`

É um projeto TypeScript mínimo com `build`, `lint`, `typecheck` e `test` funcionando, e um `.apo/project.yaml`. Nos testes, ele é copiado para um diretório temporário com `git init`, e serve de alvo para todo e2e.

---

## 8. Fases

Convenção: cada fase lista **entregas** (numeradas, cada uma do tamanho de um commit ou PR), **testes obrigatórios** e o **gate de saída**. As estimativas estão em semanas de um dev com agentes e somam o intervalo do ROADMAP.md.

**Ordem de execução revisada (ADR 0003, pós-M1):** M0 ✅ → M1 ✅ → M3 ✅ → M2 ✅ → M4 ✅ → M5 ✅ → M6 ✅ → **M7 (perguntas ao humano)** → **M8 (TUI)** → **M9 (interface web)**. Os números das entregas não mudaram, para manter válidas as referências cruzadas (`M2.3`, `M3.7` etc.). O que mudou de marco por causa da nova ordem:

| Entrega | De | Para | Motivo |
|---|---|---|---|
| `ProcessSupervisor` mínimo (process group, timeout, kill da árvore) | M2.3 | **M3**, como M3.0a | O failover troca o processo do worker no meio de uma Task |
| `buildWorkerEnvironment()` | M2.22 | **M3**, como M3.0b | O failover não pode rodar o worker sem a allowlist de environment |
| PO/CTO no `team.yaml` | M3.11 | depois do M2 | Depende do `RoleRegistry` (M2.15) |
| `questionPolicy` por role | M3.12 | depois do M2 | Depende das perguntas bloqueantes (M2.19) |
| `GeminiCliHarness` | M3.1 | sem marco fixo | Bloqueado na autenticação (`spikes/gemini.md`). Não bloqueia o M3: o failover é validado entre Claude Code e Codex |

---

### M0 — Spikes e fundação

**Objetivo:** projeto executável, arquitetura base, e as incertezas sobre os CLIs resolvidas com dados.
**Estimativa:** 1 semana.

#### Entregas

| # | Entrega | Detalhes |
|---|---|---|
| M0.1 | Repositório | `git init`, `.gitignore`, `README` curto, `docs/adr/0001-stack.md` com a seção 2 deste documento |
| M0.2 | Monorepo | `pnpm-workspace.yaml`, `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Biome, Vitest no workspace, scripts `build`, `test`, `lint`, `typecheck` e `check` (os quatro juntos) |
| M0.3 | Postgres | `docker/compose.yaml` com `pgvector/pgvector:pg17`, volume nomeado, healthcheck. `pnpm db:up` e `pnpm db:down` |
| M0.4 | `packages/domain` | Tipos de Project, Feature, Task, TaskAttempt e ExecutionPreference. State machines da seção 5.2 com testes de tabela |
| M0.5 | `packages/config` | Schemas zod de `config.yaml` e `project.yaml`, carga com defaults, erros legíveis |
| M0.6 | `packages/db` | Drizzle schema de `projects`, `features`, `tasks`, `task_attempts` e `events`. Primeira migration. Repositórios básicos |
| M0.7 | `packages/observability` | Logger pino com contexto (`featureId`, `taskId`, `attemptId`). `emitEvent()` que grava em `events` e loga |
| M0.8 | `fixtures/sample-repo` | Projeto TS mínimo com os 4 comandos de gate passando |
| M0.9 | Spike Claude Code | Ver protocolo abaixo. Relatório em `spikes/claude-code.md` |
| M0.10 | Spike Codex | Idem. `spikes/codex.md` |
| M0.11 | Spike Gemini | Instalar o Gemini CLI. Mesmo protocolo, versão reduzida. `spikes/gemini.md` |
| M0.12 | Spike MCP headless | Um CLI em modo headless consegue chamar uma ferramenta MCP local? Insumo para a seção 4.2 do ROADMAP |
| M0.13 | Fechamento | Atualizar as seções 6.1 e 6.2 deste documento com os dados reais. ADR `0002-agent-harness.md` |

#### Protocolo de spike (por CLI)

Cada spike é um script em `spikes/<cli>/run.ts` que roda contra uma cópia do `sample-repo` e registra:

1. **Execução headless:** uma tarefa trivial de escrita ("adicione a função `sum` com teste"). Capturar o formato exato da saída estruturada.
2. **Saída com schema:** pedir uma resposta JSON num schema dado. Medir a taxa de respostas válidas em 10 execuções.
3. **Read-only:** pedir explicitamente para editar um arquivo em modo read-only. **O arquivo não pode mudar.** Se mudar, o modo `shared` fica proibido para esse CLI (seção 4.1 do ROADMAP).
4. **Escrita restrita:** tentar escrever fora do `cwd`. Registrar se é bloqueado.
5. **Rede no modo de escrita:** `pnpm install` dentro da Task funciona?
6. **Cancelamento:** SIGTERM no process group no meio da execução. Algum processo filho sobrevive?
7. **Erro de quota/rate limit:** como ele não é provocável sob demanda, coletar formatos reais de erro (docs, issues, logs antigos) e registrar o que for possível. Rodar um `--model` inexistente e uma credencial inválida para ter fixtures de outros erros.
8. **Resume:** retomar uma sessão pelo id. Funciona após kill do processo?
9. **Usage/quota:** existe algum comando ou arquivo local que exponha uso ou reset? (Insumo para os collectors proativos, seção 16 do PLAN.md.)

#### Testes obrigatórios

- State machines: todas as transições válidas e uma amostra das inválidas.
- Config: YAML válido, campos faltando, tipos errados.
- Repositórios: CRUD contra o Postgres do compose.

#### Gate de saída

- [x] `pnpm check` passa (build, lint, typecheck, test) — 28/28 testes.
- [x] `pnpm db:up && pnpm db:migrate` funciona do zero.
- [x] Os relatórios dos 3 spikes existem. Claude Code e Codex respondem os 9 itens do protocolo por execução real. **Gemini CLI não** — bloqueado na autenticação (tier gratuito descontinuado para este client, `spikes/gemini.md`); fica como exceção aceita, não como item re-aberto, porque a decisão de roadmap já previa Gemini só a partir do M3.
- [x] A tabela 6.2 está atualizada com dados reais, sem "a confirmar" para Claude Code e Codex (Gemini permanece 🔬, consistente com o item anterior).
- [x] Decisão registrada: `shared` é permitido para Claude Code e Codex (ROADMAP.md §4.1); Gemini fica fora de `shared` até ser desbloqueado.

---

### M1 — Fatia vertical mínima

**Objetivo:** `apo run` leva um objetivo até código commitado num repo real, com Claude Code **ou** Codex, sobrevivendo a restart do daemon.
**Estimativa:** 1 a 2 semanas.

#### Entregas

| # | Entrega | Detalhes |
|---|---|---|
| M1.1 | `apps/daemon` (esqueleto) | Fastify no socket, `GET /health`, pidfile em `~/.apo/daemon.pid`, shutdown gracioso |
| M1.2 | `apo daemon start/status/stop` | `start` faz spawn destacado do daemon e espera o `/health`. `stop` manda SIGTERM e espera |
| M1.3 | `apps/cli` + projetos | `apo init` (cria `~/.apo/config.yaml`), `apo project add <path>` (valida que é repo git, lê `.apo/project.yaml`), `project list`, `project show` |
| M1.4 | `packages/harnesses` | Interface `AgentHarness`, `ClaudeCodeHarness`, `CodexHarness` e `FakeHarness`. `classifyFailure` com as fixtures do spike |
| M1.5 | Suíte de contrato | Os mesmos testes para os três harnesses: sucesso, falha, timeout, cancelamento, saída estruturada |
| M1.6 | `AgentRunner` | Generaliza o que seria `LeadRunner` (seção 2.1/6.8): chama um harness em read-only com `outputSchema`, valida com zod, nova tentativa automática se a saída for inválida. Só a persona `lead` existe nesta fase |
| M1.7 | `IntentTriage` | Regras determinísticas (seção 4.3 do ROADMAP). Caso ambíguo → classificação via `LeadRunner`. Override pela flag `--as question\|bugfix\|feature` |
| M1.8 | Caminho `question` | `LeadRunner` responde em read-only no repo do Project. Imprime a resposta e emite `query.answered` |
| M1.9 | Graph mínimo | `triage → plan → execute → verify → complete` com `PostgresSaver`. O `plan` cria **uma** Task igual ao objetivo, sem LLM |
| M1.10 | Workspace mínimo | Uma worktree por Feature (`git worktree add`), branch `apo/f<id>/main`. O `WorktreeManager` completo só vem no M2 |
| M1.11 | `verify` mínimo | Há commits novos + o comando `tests` do `project.yaml` passa na worktree |
| M1.12 | Comandos de leitura | `apo feature list/show`, `apo task list/show`, `apo status`, `apo logs <feature> [-f]` (SSE) |
| M1.13 | Recovery | Na subida do daemon: attempts `working` → `interrupted`. Features ativas retomam do checkpoint. A Task interrompida roda de novo na mesma worktree (o handover completo só vem no M3) |
| M1.14 | Teste de arquitetura | Varre `orchestrator`: nenhum import de adapter, nenhum literal `"codex"`, `"claude"` ou `"gemini"` |
| M1.15 | `ProjectAgent` mínimo | Tabela `project_agents` (seção 5.1) com só o registro `lead` por Project, criado junto do Project. `team.yaml` com PO/CTO fica desabilitado até o M3 |
| M1.16 | `apo pause` / `apo resume` / `apo cancel <feature>` | Lacuna do PLAN.md §7 nunca atribuída a uma fase — fechada aqui. `pause`/`resume` só mudam o status da Feature e param/retomam o scheduler. `cancel` usa o `AbortSignal` já previsto em `AgentHarness.execute()` (seção 6.1) para interromper o attempt ativo. Cancelamento robusto de árvore de processos (mais de um processo filho) só é garantido a partir do `ProcessSupervisor` (M2.3) |

#### Testes obrigatórios

- E2E com `FakeHarness`: `apo run` → Feature `completed` → commit na branch.
- E2E com `FakeHarness`: matar o daemon durante `execute` → reiniciar → Feature conclui.
- `IntentTriage`: tabela com pelo menos 30 frases reais em português e inglês.
- E2E real (manual): a mesma Feature no `sample-repo` com `--harness claude-code` e com `--harness codex`.

#### Gate de saída

- [x] A mesma Feature conclui com os dois harnesses reais. Validado manualmente (`sample-repo` copiado para fora do monorepo, `.git` próprio): `--harness claude-code` e `--harness codex` completam, com commit real na branch de cada um.
- [x] O restart do daemon no meio da execução não perde a Feature. Validado tanto via `FakeHarness` (`feature-graph.test.ts`) quanto com Claude Code real: uma Feature que ficou presa em `executing` (ver achado sobre `cancelSignal` abaixo) foi retomada por `apo daemon start` e completou.
- [x] Uma pergunta é respondida sem criar Feature, e o evento `query.answered` existe. Validado: `apo run "pergunta..."` responde direto, `apo feature list` confirma que nenhuma Feature nova foi criada.
- [x] O teste de arquitetura passa.
- [x] Nenhum agente escreveu no working tree principal do repo durante os testes (todas as escritas ficaram em `~/.apo/worktrees/<featureId>/`).
- [x] `apo pause`/`apo resume`/`apo cancel` mudam o status da Feature corretamente; `cancel` interrompe o attempt em execução via `AbortSignal`. Validado com Claude Code real — processo morto confirmado sem órfãos (`ps aux` limpo).

**Achado real durante a validação manual, não previsto no design original:** o `AbortSignal` do cancelamento não pode ir no campo `signal` de nível top de `graph.invoke()` — esse campo é interpretado pelo próprio LangGraph, que aborta a invocação **inteira** quando ele dispara, pulando `verify`/`complete` e deixando a Feature presa em `executing` para sempre (só um restart do daemon, via recovery, resolvia). O cancelamento tem que viajar por `configurable.cancelSignal` (não interpretado pelo runtime do LangGraph, só lido manualmente pelo node `execute`), para que o resto do graph sempre rode e grave um status terminal. Ver `apps/daemon/src/feature-runner.ts` e `packages/orchestrator/src/feature-graph.ts`. **Relevante para o M2.3** (`ProcessSupervisor`): qualquer `AbortSignal` usado para cancelar uma Task individual dentro de um graph maior precisa do mesmo cuidado — nunca no `signal` de `invoke()`/`stream()`.

**Dois outros achados reais, já corrigidos:** (1) git/commit é responsabilidade determinística do `WorkerManager`, não do agente — confirmado necessário: o Claude Code real escreveu os arquivos certos mas não comitou por conta própria (`commitIfDirty()` em `worktree.ts`, exatamente como a seção 6.3 já previa, mas que não estava implementado no node `execute` do M1.9 original). (2) `fixtures/sample-repo` tinha uma configuração de `allowScripts` no `package.json` que não é lida por versões recentes do pnpm (`pnpm.allowedBuiltDependencies`/`allowBuilds` migraram de lugar) — qualquer cópia fresca do fixture travava em `ERR_PNPM_IGNORED_BUILDS` ao rodar `pnpm install` dentro de uma Task real. Corrigido com um `pnpm-workspace.yaml` próprio no fixture.

---

### M2 — Worktrees, workers, paralelismo e política de workspace

> **M2.0 (triage) ✅ — escopo ajustado.** Resultado em `spikes/execution-engines/comparison.md`; ADR 0003 aceito. Nenhum engine externo entra na V1. **M2.18–M2.21 (mensageria e perguntas bloqueantes) estão adiadas** até um caso real exigir: os artefatos tipados (M2.9) cobrem a passagem de informação entre Tasks. **Entra M2.23, `AntigravityHarness`.** M2.3 (mínimo) e M2.22 já foram entregues no M3; do M2.3 resta só a detecção de `stalled`.
>
> **M2 ✅ (2026-10-10).** ApoNativeEngine em ondas sobre o failover do M3. Detecção de `stalled` entregue (stdout/stderr + escrita em disco; no Claude Code, o transcript da sessão conta como sinal de vida). Gate abaixo com evidências.

**Objetivo:** uma Feature vira um DAG de Tasks executado em paralelo, em worktrees isoladas, e integrado numa branch. Features distintas e sem relação rodam ao mesmo tempo sem colidir; Features que colidem sempre perguntam ao usuário antes de isolar ou absorver. Cada Task carrega um role, que injeta identidade e convenções no prompt do worker que a executa, e pode trocar mensagens assíncronas com outras roles ou perguntas bloqueantes com o Lead.
**Estimativa:** 2,5 a 4 semanas (cresceu com o `FeatureOverlapCheck`, `RoleRegistry`/`PromptBuilder`, mensageria e sanitização de environment).

#### Entregas

| # | Entrega | Detalhes |
|---|---|---|
| M2.1 | `packages/git`: `WorktreeManager` | `create(task, baseRef)`, `prepare` (instala dependências se `project.yaml` mandar), `cleanup`, `list`, detecção de órfãs. Branch `apo/f<feature>/t<n>-<slug>` |
| M2.2 | `WorkspacePolicy` | Função pura `(task, project, spikeCapabilities) → shared \| isolated`, com as regras da seção 4.1 do ROADMAP. `shared` aponta para a worktree de integração, nunca para o repo principal |
| M2.3 | `packages/workers`: `ProcessSupervisor` | Spawn em process group, timeout, detecção de `stalled` (sem saída e sem mudança em disco por N minutos, configurável), kill da árvore, log por attempt. A partir daqui `apo cancel` (M1.16) garante matar toda a árvore de processos, não só o processo principal |
| M2.4 | `WorkerManager` | Ciclo da seção 13 do PLAN.md: resolve workspace → monta prompt → spawn → coleta → monta `TaskOutcome` (seção 6.3) → persiste attempt. Semáforos `maxGlobalWorkers` e `maxWorkersPerProvider` |
| M2.5 | Planner via LLM | O `plan` passa a usar `AgentRunner("lead", …)` com schema de Tasks (título, descrição, `kind`, `role`, `expectedPaths`, dependências, artefatos esperados). O prompt do planner recebe a lista de ids válidos do `RoleRegistry`. Valida o DAG deterministicamente: ids únicos, dependências existentes, sem ciclo. `role` fora do registry → fallback `generic` + evento (ver M2.15) |
| M2.6 | Scheduler + fan-out | O node `schedule` calcula as Tasks `ready` dentro dos limites e devolve um `Send` por Task. `collect` agrega. O loop segue até não haver Task pendente |
| M2.7 | Integração incremental | Branch `apo/f<id>/integration`. Ao fim de cada onda, as Tasks concluídas são mergeadas (`--no-ff`) em ordem topológica. **As Tasks da onda seguinte nascem do HEAD de integração**, para enxergar o código das dependências |
| M2.8 | Conflitos | Em caso de conflito, `merge --abort` e cria uma Task corretiva (`origin: conflict`) que roda na worktree de integração com as duas branches como contexto |
| M2.9 | Artefatos tipados | `WorkerReport.artifacts` é persistido em `tasks.artifacts` e injetado no prompt das Tasks dependentes |
| M2.10 | Templates de workflow | `feature` e `bugfix` (seção 21 do PLAN.md) como dados, que orientam o prompt do planner |
| M2.11 | Anexar Tasks a uma Feature em execução | Primitivo usado por M2.8 (Task corretiva de conflito) e reaproveitado por M2.13: insere Tasks novas no DAG de uma Feature já `executing`, recalcula `ready` e segue o loop do scheduler sem recriar a Feature |
| M2.12 | `FeatureOverlapCheck` — camada determinística | Seção 6.6 (revisada): interseção de `expectedPaths` (M2.5) entre a Feature nova e as Features ativas do Project. Interseção vazia → `isolated` sem chamar o Lead |
| M2.13 | `FeatureOverlapCheck` — camada semântica e `ask_user` | `AgentRunner("lead", …)` avalia se a interseção é relevante o suficiente para interromper o usuário, ou é ruído. Relevante → `ask_user`, prompt síncrono na CLI antes de criar a Feature, com as opções "isolar" ou "absorver" (usa M2.11 quando o humano escolhe absorver). Nunca decide `absorbed` sozinho |
| M2.14 | Teste de concorrência entre Features | Duas Features **sem** overlap, disparadas quase ao mesmo tempo no mesmo Project, cada uma com sua worktree e branch de integração, concluindo sem nenhuma colisão de arquivo ou de estado |
| M2.15 | `RoleRegistry` | Carrega `default-roles/` embutidos, sobrepõe com `<repo>/.apo/roles/*.yaml` por id, valida com zod. Role desconhecido no plano → fallback `generic` + evento `task.unknown_role` |
| M2.16 | `PromptBuilder` | Monta o prompt do worker na ordem fixa da seção 6.7: `Role.systemPrompt` → contrato padrão do worker → contexto da Task. Usado pelo `WorkerManager` (M2.4) |
| M2.17 | `apo role list` / `apo role show <id>` | Lista os roles resolvidos (embutidos + overrides do Project) e mostra o `systemPrompt` e a `executionPreference` efetivos de um id |
| M2.18 | `packages/messaging`: `MessageBus`, `MessageRepository`, `AgentInbox` | **Adiado (triage M2.0).** Tabelas `agent_messages` e `message_deliveries` (tipos `information`/`question` nesta fase). `AgentInbox.pendingFor(role, task)` consultado pelo `PromptBuilder` (M2.16) ao montar o prompt de um worker novo — broadcast por (Feature, role), FIFO, com teto `messageCapPerRole` (seção 6.9) |
| M2.18b | `messages.undelivered` | **Adiado (triage M2.0).** Hook no `transition()` (M0.4): ao entrar em status terminal, varre `agent_messages` sem linha em `message_deliveries` e emite o evento por mensagem |
| M2.19 | Pergunta bloqueante ao agente persistente | **Absorvido no M7** (perguntas ao humano, com o Lead como delegado). Texto original: `WorkerReport.blockedQuestion` → Task `awaiting_answer` → `AgentRunner.run("lead", …)` responde usando requirements + artefatos da Feature. Confiança baixa (sem `questionPolicy` ainda — isso é M3) → `needs_human` |
| M2.20 | Resume pós-resposta | **Absorvido no M7 (M7.6).** Texto original: Task retomada preferindo `harness.resume(sessionId)` nativo; sem isso, nova attempt com a pergunta+resposta injetada no contexto (mesmo envelope do `TaskHandover`, seção 6.4) |
| M2.21 | `apo task answer <id> "resposta"` | **Absorvido no M7 (M7.5).** Texto original: Persiste a resposta humana em `agent_messages.answer`, Task `awaiting_answer`/`needs_human` → nova attempt |
| M2.22 | `buildWorkerEnvironment()` | ✅ entregue no M3 (M3.0b) |
| M2.23 | `AntigravityHarness` | `agy -p` como harness single-agent (provider `google`, modelos Gemini via conta Google). Passa pelo protocolo de spike do M0 (headless, saída estruturada, read-only real, escrita restrita, cancelamento, erros) e pela suíte de contrato do M1.5. Substitui o `GeminiCliHarness` bloqueado (M3.1) |

#### Limitação conhecida: barreira de onda

No LangGraph, os `Send` de um superstep terminam juntos antes do próximo passo. Se T2 termina em 2 minutos e T3 em 20, a T4 (que depende só de T2) espera os 20 minutos.

**Decisão para a V1:** aceitar a execução por ondas. Ela é determinística, simples de testar e se encaixa na integração incremental (M2.7). Se o custo aparecer em uso real, a otimização é um node `execute_dag` que delega o agendamento contínuo ao `WorkerManager`. Isso fica registrado num ADR e não entra no M2.

#### Testes obrigatórios

- DAG: ciclo, dependência inexistente, diamante, Tasks independentes.
- Scheduler: respeita `maxGlobalWorkers` e `maxWorkersPerProvider`.
- Git: duas Tasks escrevendo no mesmo arquivo → conflito → Task corretiva criada.
- `WorkspacePolicy`: tabela de casos (read, write, alto risco, CLI sem read-only confiável).
- `ProcessSupervisor`: timeout e stall matam a árvore inteira, sem processo órfão.
- E2E com `FakeHarness`: Feature com 3 Tasks paralelas e 1 dependente → integração → `completed`.
- `FeatureOverlapCheck`: tabela de casos — sem overlap, overlap relevante → `ask_user`, overlap que é ruído → `isolated`, Feature candidata em `completed` (deve ser ignorada).
- E2E com `FakeHarness`: duas solicitações que colidem em arquivo → `ask_user` é emitido; respondendo "absorver", a segunda é absorvida na primeira sem `features` nova, e o evento `feature.request_absorbed` existe.
- `RoleRegistry`: um role do Project substitui o default embutido de mesmo id; um id ausente nos dois cai em `generic` sem falhar.
- `PromptBuilder`: a ordem das três camadas é respeitada; o `systemPrompt` de um role de teste aparece literalmente no prompt enviado ao `FakeHarness`.
- `MessageBus`: mensagem `information`/`question` para role dinâmica nunca bloqueia o chamador; aparece no `AgentInbox` e é entregue no próximo worker daquela role.
- `AgentInbox`: a mesma mensagem é entregue a **duas** Tasks diferentes da mesma role (broadcast, não consumo único); a ordem respeita FIFO; acima de `messageCapPerRole` aparece a nota de omissão.
- `messages.undelivered`: uma mensagem sem nenhuma Task da role correspondente antes do fim da Feature gera o evento ao entrar em status terminal.
- Pergunta bloqueante ao `AgentRunner("lead", …)`: Task vai a `awaiting_answer`, resposta persistida, nova attempt resume com a resposta no contexto.
- `buildWorkerEnvironment()`: o processo filho não recebe `DATABASE_URL`, `JEV_API_KEY` nem `GITHUB_TOKEN` do ambiente do daemon de teste.

#### Gate de saída

- [x] 3 Tasks rodam ao mesmo tempo, cada uma na sua worktree (verificado pelos timestamps dos attempts) — `feature-graph.test.ts`; no E2E real, 2 Tasks paralelas no Claude Code.
- [x] A Task dependente enxerga o código das dependências — nasce do HEAD de integração; no E2E real, `src/index.ts` reexporta o que as duas Tasks anteriores criaram.
- [x] Um conflito real é resolvido por Task corretiva — E2E real: a absorção de um pedido sobreposto gerou conflito em `src/modulo.ts`; a Task corretiva (`origin: conflict`, worktree de integração) resolveu e a Feature fechou `completed` com testes passando.
- [x] Uma Task `read` roda em `shared` sem criar worktree — `feature-graph.test.ts` (FakeHarness; só vale quando todos os targets têm read-only confiável).
- [x] `apo task show` mostra worktree, branch, attempts e artefatos.
- [x] Duas Features **sem** overlap rodam ao mesmo tempo no mesmo Project, cada uma isolada, sem colisão de worktree, branch ou estado — `feature-graph.test.ts` (M2.14).
- [x] Uma segunda solicitação que colide com uma Feature ativa gera `ask_user`; escolhendo "absorver", ela entra na Feature existente sem criar Feature nova, e isso aparece em `events` — E2E real (Lead julgou a interseção relevante; `--on-overlap absorb` anexou 2 Tasks; `feature.request_absorbed`).
- [x] Uma Task com `role: frontend-developer` chega ao `FakeHarness` com o `systemPrompt` configurado, antes do contrato padrão e do contexto da Task, nessa ordem.
- [x] `apo role list` mostra os embutidos e os overrides do Project corretamente mesclados (merge coberto em `roles.test.ts`).
- ~~Uma mensagem `information` de uma role para outra é entregue no worker seguinte daquela role, sem travar quem enviou.~~ — adiado (triage M2.0).
- ~~A mesma mensagem é vista por duas Tasks diferentes da mesma role (broadcast), em ordem FIFO.~~ — adiado (triage M2.0).
- ~~Uma mensagem sem Task correspondente até o fim da Feature aparece como `messages.undelivered` no relatório final.~~ — adiado (triage M2.0).
- ~~Uma pergunta bloqueante de um worker é respondida pelo `AgentRunner("lead", …)` e a Task resume sem intervenção humana — ou escala para `needs_human` quando a confiança é baixa.~~ — adiado (triage M2.0).
- [x] O processo do worker não tem acesso a nenhuma variável de ambiente do daemon fora da allowlist (entregue e verificado no M3).
- [x] Uma Task dependente recebe no prompt os artefatos (`WorkerReport.artifacts`) da Task de que depende.
- [x] O `AntigravityHarness` passa na suíte de contrato ao vivo e conclui uma Task real com um modelo Gemini (`gemini-3.1-pro-high`, `--harness antigravity`, Feature `completed`). Limitações em `spikes/antigravity.md`: só edita arquivos, não confina escrita, sem saída estruturada (fica fora do roteamento do Lead) — por isso é opt-in. Comandos de shell podem ser liberados por target com `dangerouslySkipPermissions: true` (default `false`); verificado em E2E real.

**Achados do E2E real:**
- Task de escrita **sem mudanças** não é falha: num DAG o trabalho pode já ter vindo da dependência (a Task "testes" encontrou os testes escritos pela anterior e derrubava a Feature). Agora conclui com evento `task.no_changes`; "Feature que não fez nada" continua barrada no verify da integração.
- `--on-overlap absorb` sem alvo (CLI não interativa) faz o daemon descobrir a Feature sobreposta.

---

### M3 — Multi-provider e failover

**Objetivo:** cumprir o critério central da V1. Uma Task que perde o provider no meio continua em outro, sem humano.
**Estimativa:** 1,5 a 2,5 semanas.

> **Próximo marco (ADR 0003): roda antes do M2**, em cima do `SingleAgentEngine` do M1, com uma Task por Feature e uma worktree por Feature. Tudo abaixo vale nesse contexto; a generalização para N Tasks vem com o M2. Durante a validação do M1, o Codex bateu no limite de uso no meio de uma Feature real ("You've hit your usage limit... try again at 3:58 PM"). O `CodexHarness` atual classificou isso como `crash`, não como `quota_exhausted` (confirmado em `task_attempts.failure_kind`). Não verificamos se a mensagem veio por `turn.failed` ou pelo stderr; o M3.4 começa capturando o formato exato. **Ajustar esse classificador com essa fixture real faz parte do M3.4.**

#### Entregas

| # | Entrega | Detalhes |
|---|---|---|
| M3.0a | `ProcessSupervisor` mínimo (vinda do M2.3) | Process group, timeout, kill da árvore, log por attempt em `~/.apo/logs/`. Hoje isso está espalhado entre o `execa` (`killDescendants`) e o `FeatureRunner`. A detecção de `stalled` fica para o M2 |
| M3.0b | `buildWorkerEnvironment()` (vinda do M2.22) | Allowlist da seção 6.3. Hoje os harnesses repassam o `process.env` do daemon inteiro |
| M3.1 | `GeminiCliHarness` | **Bloqueado na autenticação, não bloqueia o marco.** Passa na suíte de contrato do M1.5 quando a autenticação for resolvida |
| M3.2 | `packages/routing`: `ProviderRegistry` | Targets disponíveis vindos do `config.yaml`: provider, harness, modelos, capacidades e limites de concorrência |
| M3.3 | `CapacityMonitor` | Estado por provider, atualizado **de forma reativa**: `rate_limited` → `degraded` + `resetAt`; `quota_exhausted` → `exhausted`; após o `resetAt`, volta a `unknown`. `usagePercent` só é preenchido se um collector oficial existir (seção 15 do PLAN.md). Emite `provider.degraded` e `provider.exhausted` |
| M3.4 | `CapacityCollector` por harness (seção 6.1) | Implementado dentro de `packages/harnesses/<provider>/capacity-collector.ts`, nunca em `packages/routing`. Apenas os que o spike (item 9) mostrou viáveis. Sem fonte oficial, o provider fica `unknown` |
| M3.5 | `ExecutionTargetResolver` | Seção 6.5 deste documento, como função pura |
| M3.6 | `RuleBasedRouter` | Fluxo da seção 18 do PLAN.md, passos 1, 2, 3, 6 e 7: elimina indisponíveis e incapazes, depois aplica a capacity policy (`degradedAt`, `avoidAt`, `preferLowerUsageDifference`). Com `usagePercent` desconhecido, desempata por `activeWorkers` e histórico recente de falhas |
| M3.7 | Handover | Seção 6.4: commit `wip`, camada determinística, camada semântica opcional, persistência em `handovers` |
| M3.8 | Reroute automático | No node de falha: classifica o erro → atualiza a capacidade → gera o handover → Task `retrying` → resolver → novo attempt na **mesma worktree e branch**. Limite `maxAttemptsPerTask` |
| M3.9 | `paused_capacity` | Todos os targets indisponíveis → Feature `paused_capacity` + evento. Um timer no daemon retoma ao passar o menor `resetAt`. Não chama API paga |
| M3.10 | Comandos | `apo providers`, `apo task assign`, `apo task preference`, `apo feature preference`, `apo task reroute` (manual: pausa → handover → stop → novo target) |
| M3.11 | `team.yaml`: PO e CTO | **Adiado para depois do M2** (depende do `RoleRegistry`, M2.15). `ProjectAgent` para `product-owner` e `cto`, com `RoleDefinition` própria (seção 6.7/6.8). Desabilitados por padrão — o usuário habilita no `project.yaml` |
| M3.12 | `questionPolicy` por role | **Substituído pelos modos do M7** (`ask_human` / `lead_first` / `auto`, por Feature, global ou Project). Roteamento por tópico para PO/CTO volta junto com o M3.11, se um dia fizer sentido. Texto original: depende das perguntas bloqueantes, M2.19. Estende `RoleDefinition` (seção 6.9). Uma pergunta bloqueante passa a resolver por tópico: `lead`/`product-owner`/`cto`/`human`, em vez de sempre `lead` (comportamento do M2) |

#### Testes obrigatórios

- Resolver: matriz de `forced`, `preferred` e `auto` × disponível, degradado e esgotado.
- Router: os casos da Phase 6 do PLAN.md, com regras. Em especial: **A em 80% e B em 40%, equivalentes → B**.
- Failover e2e com `FakeHarness`: fake-a falha com `rate_limited` no meio → handover → fake-b conclui → as alterações de fake-a continuam na branch.
- Todos esgotados → `paused_capacity` → avançar o relógio → retoma.
- Reroute manual no meio da execução preserva a worktree.
- `forced` com target esgotado → `needs_human`, sem trocar de provider.
- `questionPolicy` (só depois do M2, junto com M3.12): uma pergunta de tópico com policy `human` escala direto, sem consultar nenhum `AgentRunner`; uma com policy `cto` é respondida pela persona CTO, não pelo Lead genérico.
- `buildWorkerEnvironment()`: o processo do worker não enxerga `DATABASE_URL` nem nenhuma variável fora da allowlist.
- Classificação da mensagem real de limite de uso do Codex (fixture do M1) como `quota_exhausted`, não `crash`.

#### Gate de saída

- [x] O failover simulado passa sem intervenção humana (`feature-graph.test.ts`: rate limit em `fake-a` → handover → `fake-b` conclui, e o trabalho de A continua na branch).
- [x] `apo providers` mostra `unknown` quando não há dado. Nenhum percentual inventado ("uso: desconhecido").
- [x] Toda escolha de target tem linha em `routing_decisions` com `resolutionSource` (visível em `apo task show`).
- [x] Um failover real foi observado com Claude Code e Codex, **sem precisar provocar**: o Codex estava de fato sem quota. `apo run --prefer codex` → attempt 1 no Codex falhou com `quota_exhausted` (resetAt 02:27 extraído da mensagem real) → handover → attempt 2 no Claude Code concluiu, com os testes passando na branch. O reroute manual (`apo task reroute`) foi validado só com `FakeHarness`: com o Codex esgotado, não havia um segundo provider real disponível para trocar.
- [x] O worker roda com a allowlist de environment, nunca com o `process.env` do daemon. A autenticação OAuth dos dois CLIs funciona com a allowlist (Claude Code completou Features reais; Codex autenticou e só parou no limite de uso).
- [ ] ~~Uma pergunta roteada por `questionPolicy` para `cto` é respondida pela persona CTO~~ — movido para depois do M2, junto com M3.12.

**Fora do M3 por decisão:**
- **Camada semântica do handover** (opcional pela seção 6.4) — só a determinística existe: diff, arquivos alterados, falhas e última mensagem.
- `commandsRun`/`testsRun` ficam vazios, porque extraí-los exigiria um parser por CLI.
- `apo task assign`, `apo task preference`: cobertos por `apo task reroute` e `apo feature preference`.
- Detecção de `stalled`: fica para o `ProcessSupervisor` completo do M2.
- `CapacityCollector` proativo (M3.4): nenhum dos dois CLIs expõe uso agregado (spikes M0.9/M0.10). A capacidade é só reativa, a partir das falhas classificadas.

**Achados reais da validação do M3:**
- A mensagem de limite do Codex vem em dois formatos de horário: "try again at 3:58 PM" e "try again at Oct 10th, 2026 2:27 AM". Os dois agora viram `quota_exhausted` com `resetAt` correto. Antes, os dois viravam `crash` e o failover nunca disparava.
- O forced do `--harness` não deve valer para o Lead, que só faz julgamento. Com o provider forçado esgotado, ele barrava a criação da Feature com 503, em vez de a Feature ir para `needs_human`. O Lead agora trata a escolha como preferência.

---

### M4 — Quality gates, review, mudança de plano e entrega

> **M4 ✅ (2026-10-10).** Graph: `execute_wave → handle_plan_changes → quality → review → prepare_delivery → await_approval → create_pr → complete`, com loop de correção (`fixing`) até `review.maxFixIterations`. Gate abaixo com evidências.

**Objetivo:** o cenário da seção 38 do PLAN.md roda de ponta a ponta, sem Jev e sem memória.
**Estimativa:** 1 a 2 semanas.

#### Entregas

| # | Entrega | Detalhes |
|---|---|---|
| M4.1 | `packages/quality`: `QualityGateRunner` | Roda os comandos do `project.yaml` na worktree de integração, em ordem fixa (build → lint → typecheck → tests). Persiste em `quality_results` |
| M4.2 | Verificação de requisitos | `LeadRunner` compara requisitos e diff e devolve uma lista estruturada de atendidos e faltantes |
| M4.3 | Reviewer | Task `read` em `shared` sobre a integração. O resolver recebe a dica `preferDifferentProviderFrom` (o provider que mais implementou). Saída: `ReviewFinding[]` validado por zod |
| M4.4 | Completion contract | Função pura da seção 26 do PLAN.md sobre `quality_results`, requisitos e findings. É a **única** forma de chegar a `awaiting_approval` |
| M4.5 | Loop de correção | Gate falhou ou finding com severidade a partir de `review.blockingSeverity` (padrão `medium`) → Tasks corretivas → `fixing` → nova onda. `maxFixIterations` estourado → `needs_human` |
| M4.6 | `planChangeRequests` | Node `handle_plan_changes`: o Lead avalia cada pedido do `WorkerReport` e decide criar Task, rejeitar com motivo ou pedir ao humano. Tudo registrado em `agent_messages` (`type: "plan_change_request"`, seção 6.9) |
| M4.7 | `prepare_delivery` | Resumo da Feature, lista de mudanças, relatório de gates, relatório de review |
| M4.8 | Aprovação | `interrupt()` do LangGraph. `apo approve <feature>` / `apo reject <feature> --reason` retomam com `Command({ resume })`. Evento `feature.awaiting_pr_approval` |
| M4.9 | `create_pr` | `git push` da branch de integração e `gh pr create` com o resumo. Salva `pr_url`. Nunca faz merge (seção 27 do PLAN.md) |

#### Testes obrigatórios

- Completion contract: cada condição falhando isoladamente impede `ready`.
- Loop de correção: o fake reviewer devolve 2 findings → 2 Tasks → corrigidas → os gates passam.
- `maxFixIterations` → `needs_human`.
- Aprovação: o daemon reinicia enquanto espera aprovação → `apo approve` depois do restart funciona.
- **E2E da seção 38 com `FakeHarness`**: todos os passos, incluindo quota no meio e reviewer com 2 problemas.

#### Gate de saída

- [x] O cenário da seção 38 passa com `FakeHarness` no `pnpm test` — `feature-graph.test.ts` ("E2E seção 38"): 3 Tasks paralelas, quota no meio de uma delas, handover para o outro provider, gates, reviewer com 2 problemas, 2 Tasks corretivas, gates de novo, aprovação, PR.
- [x] O cenário da seção 38 passa uma vez com harnesses reais no `sample-repo`, gerando um PR de verdade num repo de teste — `Jejugo/apo-e2e-sample` (privado), PR #1: DAG de 2 Tasks no Claude Code, 4 gates reais (`tsc`, `biome`, `vitest`), requisitos (Lead) e review no **Codex** (provider diferente do que implementou), restart do daemon com a Feature parada na aprovação, `apo reject --reason` virando Task de ajuste e nova rodada, `apo approve` → push + `gh pr create`. PR aberto, sem merge. Quota e findings não foram provocados no real (não dá para forçar); estão cobertos pelo E2E com FakeHarness.
- [x] Nenhum caminho do código leva a `awaiting_approval` sem passar pelo completion contract — teste de arquitetura varre `packages/*/src` e `apps/*/src`: uma única escrita do status, no `prepare_delivery`, depois de `evaluateCompletion(...)` e do `if (!verdict.ready)`.

**Achados do E2E real:**
- **Schema estrito do Codex, de novo.** O `--output-schema` exige que todo campo esteja em `required` (o review tem `file`/`suggestedFix` opcionais) — o review falhava com 400. O `CodexHarness` agora normaliza o schema recursivamente (todo campo obrigatório, os opcionais aceitam `null`) e remove da resposta os `null` que ele introduziu. Quem chama continua escrevendo um schema só.
- **Sucesso atrasado limpava a quota esgotada.** No E2E com FakeHarness, Tasks paralelas que já estavam rodando no provider terminaram bem depois que outra bateu a quota, e o `recordSuccess` marcava o provider como `available` de novo — a retentativa voltava para um provider sem quota. Agora um sucesso só limpa `degraded`/`exhausted` se o trabalho começou depois da falha.
- **Reject e absorção entram nos requisitos.** A verificação de requisitos passou a receber, além do objetivo, os motivos de reject e os pedidos absorvidos — senão ela aprovaria um ajuste humano que não foi feito.
- **Falha ao abrir o PR** (sem remote, sem `gh auth`) vira `needs_human` com o motivo, em vez de deixar a Feature presa em `delivering`.
- `apo logs -f` para em `awaiting_approval` e pergunta "Feature pronta. Deseja abrir o Pull Request?".
- Limitação conhecida: o `prepare` (`pnpm install`) pode gerar um lockfile numa worktree e ele entra no commit da Task. No `sample-repo` (sem lockfile versionado) o PR levou um `pnpm-lock.yaml`; num repo real com lockfile versionado isso não muda nada.

---

### M5 — Jev e memória

> ⚠️ **Antes de começar:** pedir ao usuário o endpoint do Jev e configurar a API key. (Feito: endpoint OpenRouter Decisions, key em `~/.apo/secrets.env`.)
>
> **M5 ✅ (2026-10-11).** `JevTaskRouter` + capacity policy por cima (com degradação para o RuleBasedRouter) e memória do Project (pgvector, embeddings locais, ingestão incremental, retrieval no planner e em cada Task, `MemoryWriter` ao concluir a Feature). Gate abaixo com evidências.

**Objetivo:** roteamento semântico e contexto de projeto, sem que nenhum dos dois vire requisito estrutural.
**Estimativa:** 1,5 a 2,5 semanas.

#### Entregas — Jev

| # | Entrega | Detalhes |
|---|---|---|
| M5.1 | Credenciais | Endpoint e API key no `config.yaml`, com a chave lida de variável de ambiente e nunca gravada no repo |
| M5.2 | `JevTaskRouter` | Monta o input da seção 17 do PLAN.md (Task, pistas de complexidade e risco, módulos, candidatos com capacidade). Valida a resposta com zod |
| M5.3 | Capacity policy por cima | A decisão do Jev passa pelo mesmo validador do M3.6. Se a política sobrescrever, `overridden_by_policy = true` |
| M5.4 | Degradação | Jev com timeout, erro ou resposta inválida → `RuleBasedRouter` assume e o evento é registrado. O Jev **não** pode ser requisito estrutural (regra 5 do PLAN.md) |
| M5.5 | `RoutingAudit` | `apo task show` explica a decisão: candidatos, Jev, política, target final e confiança |

#### Entregas — memória

| # | Entrega | Detalhes |
|---|---|---|
| M5.6 | pgvector | Migration `CREATE EXTENSION vector` + tabela `memories` com índice HNSW |
| M5.7 | `EmbeddingProvider` | Interface + implementação local. Decidir no início da fase entre Ollama (serviço separado, já reaproveitável na VM) e transformers.js (no próprio processo). Registrar num ADR |
| M5.8 | Ingestão | README, AGENTS.md, CLAUDE.md, `docs/`, ADRs e manifests. Chunking por seção, `content_hash` para não reindexar o que não mudou (seção 22 do PLAN.md) |
| M5.9 | Retrieval | Antes do `plan` (por objetivo) e antes de cada Task (por descrição e arquivos). Top-k com limite de tokens no prompt |
| M5.10 | `MemoryWriter` | Ao concluir a Feature, o `LeadRunner` destila decisões, padrões que funcionaram, tentativas que falharam e correções do usuário em memórias categorizadas |

#### Testes obrigatórios

- Os 6 casos de routing da Phase 6 do PLAN.md, com o Jev mockado e depois com o Jev real.
- Jev fora do ar → a Feature conclui pelo `RuleBasedRouter`.
- Ingestão idempotente: rodar duas vezes não duplica.
- Retrieval: uma memória plantada sobre uma convenção aparece no prompt da Task relevante.

#### Gate de saída

- [x] Com A em 80% e B em 40% equivalentes, o sistema tende a B também com o Jev (seção 18 do PLAN.md) — Jev real (`jev.live.test.ts`): escolheu B com probabilidade 1.0 por conta própria; a capacity policy também troca para B quando o Jev os vê como equivalentes (margem de 0.15) e ele não troca.
- [x] O Jev desligado não quebra nenhum teste do M4 — os testes do M4 rodam sem `taskRouter`; "Jev fora do ar" (exceção no router) conclui a Feature pelo RuleBasedRouter, com `routing.semantic_failed` e `semanticError` no RoutingAudit.
- [x] Uma convenção registrada em memória é seguida numa Feature real sem ser repetida no objetivo — `apo memory add` ("toda função exportada tem JSDoc em português com @example"); Feature real pedindo `slugify` sem mencionar documentação → `src/slug.ts` saiu com JSDoc em português e `@example`. Controle: `src/price.ts`, feito pelo mesmo harness no M4 sem a memória, não tem JSDoc nenhum.

**Achados:**
- **API do Jev** (OpenRouter Decisions, confirmada contra a API real): três tipos de pergunta — `noul` (probabilidade), `choice` (opção + probabilidade de cada opção + confiança) e `score` (nível + probabilidades). O APO pergunta complexidade e risco (`score`), o target (`choice`) e se precisa de review (`noul`). O `choice` com probabilidades por target é o que a capacity policy usa para decidir quando dois targets são "equivalentes". ~US$ 0,00002 por decisão.
- **`score` vem fracionado** (valor esperado entre níveis, ex.: 1.6). A primeira versão exigia inteiro e rejeitava a resposta — a degradação do M5.4 fez o papel dela (cairia no RuleBasedRouter). Agora arredonda para o nível mais próximo.
- **Viés de posição do Jev:** com dois targets idênticos e sem dado de uso, ele dá ~0.9 ao primeiro da lista. Como o uso real quase nunca é conhecido (sem fonte oficial, seção 15), o primeiro target do `config.yaml` tende a receber a maior parte das Tasks. Não corrigido; candidato a mitigação (embaralhar a ordem dos candidatos, ou mandar `active_workers` com mais peso).
- **Segredos:** a key fica em `~/.apo/secrets.env` (chmod 600), carregada só no processo do daemon; o `config.yaml` guarda só o nome da variável (`jev.apiKeyEnv`). Os workers não a recebem (allowlist de ambiente do M3).
- **Embeddings:** ADR 0004 (transformers.js, `multilingual-e5-small`, 384 dimensões).
- **MemoryWriter real:** ao aprovar a Feature do `slugify` (PR #2 no repo de teste), o Lead destilou 3 memórias — duas convenções e a falha de lint daquela Feature ("Biome rejeita faixa de combining marks literal em regex"), que é exatamente o tipo de tentativa falha que não deve se repetir.

---

### M6 — Lead conversacional e homelab

> **M6 ✅ (2026-10-11).** `apo chat` com ações estruturadas e replan; APO rodando na VM do homelab como serviço systemd (usuário `apo`, Postgres nativo, acesso pelo Tailscale com token, recovery no boot). Runbook em `docs/homelab.md`. Gate abaixo com evidências.

**Objetivo:** usar o APO de verdade, conversando com o Lead, rodando na VM de forma resiliente.
**Estimativa:** 1,5 a 2,5 semanas.

#### Entregas — chat

| # | Entrega | Detalhes |
|---|---|---|
| M6.1 | Threads | `conversation_threads` por Project. O histórico é resumido quando passa de um limite |
| M6.2 | `apo chat` | REPL que fala com o daemon. Cada mensagem passa pelo `IntentTriage` |
| M6.3 | Ações do Lead | O `LeadRunner` devolve uma **ação estruturada** (`create_feature`, `update_requirement`, `set_preference`, `cancel_task`, `replan`, `explain_routing`, `answer`). O daemon executa a ação de forma determinística. O LLM nunca altera estado diretamente |
| M6.4 | Replan | Mudança de requisito numa Feature em execução → cancela as Tasks afetadas que ainda não começaram e replaneja o restante |

#### Entregas — homelab

| # | Entrega | Detalhes |
|---|---|---|
| M6.5 | VM | Ubuntu na Proxmox, usuário `apo` sem sudo, `/home/apo/projects` e `/home/apo/worktrees`. Docker rootless ou Postgres nativo, para não expor o socket do Docker (seção 33 do PLAN.md). Runbook em `docs/homelab.md` |
| M6.6 | systemd | `apo.service` com `Restart=on-failure`, `User=apo` e hardening (`ProtectSystem=strict`, `ReadWritePaths` só para os diretórios do APO) |
| M6.7 | Rede | O daemon escuta no socket e no IP Tailscale, com token. Nada exposto na internet |
| M6.8 | Recovery no boot | Recovery do M1.13 + limpeza de worktrees órfãs + kill de process groups órfãos |
| M6.9 | Operação | Rotação de logs, `pg_dump` diário com retenção, `GET /health` com o estado do Postgres e dos providers |
| M6.10 | Mensageria ao vivo entre workers rodando (condicional) | Residual depois do mailbox (M2) e das perguntas bloqueantes a agentes persistentes (M2/M3): só o caso de pedir resposta síncrona de um worker que está rodando *agora*, sem esperar ele terminar. Construído apenas se o uso real mostrar que mailbox + pergunta bloqueante não bastam. Spike M0.12 (`spikes/mcp-headless.md`) confirma que é tecnicamente viável via MCP síncrono, mas não uniforme: limpo no Claude Code (`--allowedTools`), só viável no Codex abrindo mão de quase todo o sandbox da Task (`danger-full-access`) — se construído, é capacidade por-harness, nunca assumida como uniforme no `AgentHarness` |

#### Gate de saída

- [x] Reiniciar a VM no meio de uma Feature e, após o boot, a Feature retoma sozinha — `sudo systemctl reboot` com o worker da Task #1 rodando; a VM voltou em <30 s, Postgres/Tailscale/`apo.service` subiram sozinhos, o recovery marcou o attempt como `interrupted` e retomou a Feature com um attempt novo na mesma Task; ela seguiu por gates, review (Codex achou corte de emoji ao meio em UTF-16), correção, e chegou a `awaiting_approval`.
- [x] Uma Feature completa é criada, ajustada e aprovada só pelo `apo chat` — E2E real: `isPalindrome` criada pelo chat, requisito alterado com a Feature rodando (replan segurou e cancelou a Task não iniciada e criou as novas), review no Codex achou um bug real (contagem UTF-16), correção, aprovação pelo chat → PR #3.
- [x] O usuário `apo` não consegue ler `/home/jeff` nem usar sudo — verificado na VM: `Permission denied` em `/home/jeff`, sudo negado, sem acesso ao socket do Docker; dentro do sandbox do serviço, `/home` só mostra `apo` e o sistema é somente leitura (`systemd-analyze security`: 5.8).

**Achados:**
- **Janela do replan:** cancelar antes de o Lead planejar (~20 s) deixava o graph concluir sem o trabalho replanejado. Agora o replan segura as Tasks (`pending`), o graph espera dentro do node, e só depois de anexar as novas as seguradas são canceladas. Transições runner × replan são atômicas (`transitionIf`).
- **Correções em paralelo** sobre os mesmos arquivos geravam uma cascata de conflitos. As Tasks corretivas de uma rodada agora rodam em sequência.
- **`recursionLimit`:** o padrão do LangGraph (25 passos) estouraria numa Feature com muitas ondas; agora 1000.
- **VM:** Node do sistema é 22; o APO usa Node 24 isolado em `/opt/node24`. CPU da VM precisava ser `host` no Proxmox (AVX/PCLMUL para `agy` e embeddings). DNS da VM oscilou durante o `apt` — downloads do instalador com retry.
- **Hardening × sandbox do Codex:** `RestrictNamespaces=yes` na unit impedia o `bwrap` (sandbox de escrita do Codex) de criar namespaces; o worker não escrevia nada e mesmo assim terminava com sucesso (`task.no_changes` em todas as Tasks, até estourar as rodadas de correção). Diretiva removida; o resto do hardening continua. O review pegou o problema ("src/capitalize.ts não existe"), o que mostra o valor de verificar requisitos contra o código e não contra o que o worker diz.
- **CLIs do APO isolados:** o `claude` global da VM (2.1.251) não tinha flags que o harness usa; o APO tem os próprios `claude`/`codex`/`pnpm` em `/opt/node24`, com versão fixada no `install.sh`, sem tocar nos do usuário.
- **Visão ao vivo (pós-M6):** `apo watch <feature>` (painel interativo: Tasks, agentes, tempo, eventos; número + Enter abre o agente) e `apo task tail <task> [-f]` (arquivos, comandos, mensagens e custo do agente, ao vivo, trocando de attempt em failover). O Claude Code passou a `--output-format stream-json --verbose` (o evento final `result` é o mesmo objeto do modo `json`), e o log do attempt é gravado enquanto o CLI roda.
- **Worker do Claude não rodava comandos (achado pelo `task tail`):** com `--permission-prompts none` e `acceptEdits`, todo Bash era negado desde o M1 — o worker entregava sem testar e só os quality gates pegavam os erros. Agora o worker de escrita recebe `--allowedTools Bash`; Lead, Reviewer e Tasks read continuam sem comandos. Na VM o sandbox do systemd confina a escrita a `/home/apo`; no daemon local do Mac (desenvolvimento) não há esse confinamento.
- M6.10 (mensageria ao vivo) não construído: condicional e nenhum uso real pediu.

---

### M7 — Perguntas ao humano

**Objetivo:** quando um worker precisa de uma decisão que não é dele (produto, UX, ambiguidade no pedido), ele pergunta — e a pergunta chega **ao usuário**, que responde, ou delega ao Lead ("decida você"). Um interruptor (`auto`) faz o Lead decidir tudo sozinho, para deixar os agentes rodando sem supervisão (ex.: a noite toda).
**Estimativa:** ~1 semana.
**Absorve:** M2.19–M2.21 (perguntas bloqueantes e resume pós-resposta) e substitui o M3.12 (`questionPolicy`). M2.18 (mensageria entre agentes) e M3.11 (PO/CTO) continuam adiados.

#### Como funciona

Os CLIs rodam em modo não interativo: o worker não consegue esperar uma resposta no meio da sessão. Ele **encerra o turno** com a pergunta no `WorkerReport`, a Task vai para `awaiting_answer` (worktree e sessão preservadas) e o resto da Feature segue — só esperam as Tasks que dependem dela. A resposta retoma **a mesma sessão** do agente.

```
❓ O worker de UI (Task #3, frontend-developer) está perguntando:
   "O filtro por categoria deve aceitar várias categorias ao mesmo tempo?"
   a) Uma categoria por vez        b) Várias, com checkboxes  ← recomendado
   c) Várias, com chips removíveis
Responda: apo task answer <task> b   |   apo task answer <task> --delegate  ("decida você")
```

#### Modos

| Modo | Comportamento |
|---|---|
| `ask_human` (**padrão**) | A pergunta vai para o usuário. "Decida você" delega ao Lead |
| `lead_first` | O Lead tenta responder; só pergunta ao usuário se não tiver confiança |
| `auto` | O Lead sempre decide, na hora (o "autoResolveQuestions") |

Níveis, do mais específico para o mais geral: **Feature** (`apo run --auto-resolve`, `apo feature questions <id> <modo>`) → **global/runtime** (`apo questions auto on|off`, ou pelo chat — liga e desliga sem editar arquivo nem commitar) → **Project** (`questions.mode` no `.apo/project.yaml`). Ligar `auto` com perguntas pendentes resolve as pendentes na hora.

O modo **não** muda a aprovação do PR: Features prontas continuam esperando o "Abrir o PR?" humano (aprovação automática é outro assunto — YOLO, seção 28 do PLAN.md). Gates, verificação de requisitos e review continuam rodando sobre o que o Lead decidiu.

#### Entregas

| # | Entrega | Detalhes |
|---|---|---|
| M7.1 | Contrato do worker | `WorkerReport.question`: `{ question, options: [{ id, label, description? }], recommended?, context }`. O PromptBuilder instrui: perguntar só quando há impacto de produto/UX ou ambiguidade real; detalhe técnico o worker decide e anota no `summary`. Teto `questions.maxPerTask` (padrão 2) — acima disso, decide sozinho |
| M7.2 | Estado `awaiting_answer` | A Task para com a pergunta, preservando worktree e `sessionId`. O `execute_wave` não roda dependentes dela e não conclui a Feature com pergunta pendente (espera dentro do node, como o replan do M6.4). Sobrevive a restart (estado no banco) |
| M7.3 | Persistência | `agent_messages` (`type: "question"`): status `pending` → `answered` / `delegated` / `auto`; resposta, quem respondeu (`human` / `lead`), motivo da decisão do Lead, opções e recomendação originais |
| M7.4 | Modos e interruptor | Resolução Feature → global (runtime, persistido no banco) → Project. CLI: `apo questions auto on\|off`, `apo questions status`, `apo feature questions <id> <modo>`, `apo run --auto-resolve`. Ações correspondentes no `apo chat` |
| M7.5 | Responder | `apo task answer <task> "<opção ou texto livre>"`, `apo task answer <task> --delegate`; `apo questions list` (pendentes de todos os Projects). No chat: "vai de b", "decida você". O Lead decide com objetivo + requisitos + artefatos + memória e registra o motivo |
| M7.6 | Retomada | `harness.resume(sessionId)` com a resposta (Claude Code `--resume`, Codex `exec resume`); se falhar, novo attempt na mesma worktree com pergunta + resposta no contexto (envelope do handover) |
| M7.7 | Aviso | Evento `task.question`; destaque no `apo logs -f`, no `apo watch` e no contexto do `apo chat`; a skill `apo` reporta perguntas pendentes ao acompanhar uma Feature |
| M7.8 | Prazo opcional | `questions.timeoutHours` (sem padrão = espera para sempre): passado o prazo, o Lead decide e marca como decisão por prazo |
| M7.9 | Registro | Decisões viram memória (`decision`) do Project, para a mesma dúvida não voltar. `apo feature report` e o corpo do PR ganham a seção "Decisões tomadas" (por você / pelo Lead, com motivo) |

#### Testes obrigatórios

- Worker pergunta → Task `awaiting_answer`; Tasks independentes seguem; a dependente espera; a Feature não conclui.
- Resposta humana → retomada na mesma sessão com a resposta no prompt; fallback para attempt novo quando o resume falha.
- `--delegate` → o Lead decide, a resposta e o motivo ficam registrados.
- Modo `auto` (por Feature e global) → nenhuma espera humana; ligar `auto` com pendentes resolve as pendentes.
- `lead_first` com confiança baixa → pergunta chega ao humano.
- Teto por Task respeitado; restart do daemon com pergunta pendente → continua pendente e responde depois.

#### Gate de saída

- [ ] Real: um worker pergunta, a pergunta aparece no `apo chat`/`apo watch`, o usuário responde e o worker retoma **a mesma sessão** usando a resposta.
- [ ] Real: "decida você" → o Lead decide, o motivo aparece no report e no PR.
- [ ] Real: com `apo questions auto on`, uma Feature com pergunta vai até "Abrir o PR?" sem nenhuma interação humana, e o report lista as decisões tomadas pelo Lead.

---

### M8 — TUI

**Objetivo:** operar o APO por uma tela de terminal navegável — ver tudo e agir sem decorar comandos. Evolução do `apo watch` (pós-M6) e Phase 14 do PLAN.md.
**Estimativa:** 1 a 1,5 semana.
**Pré-requisito:** M7 (perguntas ao humano), para a TUI já nascer mostrando e respondendo perguntas; fora isso, só as APIs que o daemon já expõe.

#### Entregas

| # | Entrega | Detalhes |
|---|---|---|
| M8.1 | Base da TUI | Decidir a biblioteca no início (ADR): Ink (React para terminal, testável com `ink-testing-library`) ou renderização ANSI própria como o `apo watch`. Comando `apo tui`. Funciona com `APO_URL` (remoto) e por SSH; respeita redimensionamento e `NO_COLOR` |
| M8.2 | Navegação | Colunas Projects → Features → Tasks, com status, agente, tempo e dependências. Atualização por polling curto ou SSE de eventos (reaproveitar `GET /features/:id/board`; criar um endpoint de visão geral por Project se o polling pesar) |
| M8.3 | Providers e eventos | Painel de providers (`/health`, `apo providers`: disponibilidade, workers ativos, reset, Jev) e fluxo dos eventos da Feature selecionada |
| M8.4 | Agente ao vivo | A Task selecionada mostra o stream de `GET /tasks/:id/live` com o mesmo formatador do `apo task tail` (`apps/cli/src/live/format.ts`) |
| M8.5 | Ações | Nova Feature/bugfix (formulário com objetivo, intent, preferência), aprovar, rejeitar com motivo, cancelar, pausar/retomar, reroute de Task, preferência da Feature, `memory add`. Confirmação explícita em aprovar/rejeitar/cancelar |
| M8.6 | Chat com o Lead | Painel com `POST /projects/:id/chat`; o resultado da ação aparece na lista sem recarregar |

#### Testes obrigatórios

- Renderização dos estados principais (Feature em execução, `awaiting_approval`, `needs_human`, failover) com dados de fixture.
- Cada ação chama a rota certa com o payload certo; ações destrutivas não disparam sem confirmação.
- Daemon fora do ar / token inválido → mensagem clara, sem travar a tela.

#### Gate de saída

- [ ] Uma Feature é criada, acompanhada (incluindo o agente ao vivo) e aprovada só pela TUI.
- [ ] Funciona do Mac pelo Tailscale (`APO_URL`) e por SSH na VM.
- [ ] Nenhuma regra de negócio nova: toda ação passa pelas rotas que a CLI já usa.

---

### M9 — Interface web

**Objetivo:** a operação da TUI no navegador, acessível só pelo Tailscale — inclusive do celular — para acompanhar e aprovar longe do terminal.
**Estimativa:** 2 a 3 semanas.
**Pré-requisito:** M8 (as telas e ações já validadas na TUI viram o escopo da web).

#### Entregas

| # | Entrega | Detalhes |
|---|---|---|
| M9.1 | App web | `apps/web`, SPA buildada estática e servida pelo daemon **só no listener do Tailscale** (nunca no socket local, nunca na internet). Stack decidida no início (ADR); manter sem servidor próprio — o backend é o daemon |
| M9.2 | Autenticação | Tela de login com o `APO_REMOTE_TOKEN` trocado por sessão em cookie `HttpOnly`, `Secure` quando houver HTTPS (Tailscale serve/cert), `SameSite=Strict`, com expiração; proteção CSRF nas rotas de escrita. O token nunca vai para URL, `localStorage` ou log |
| M9.3 | Diff da integração | `GET /features/:id/diff` (diff da branch de integração contra a base, por arquivo, com limite de tamanho) |
| M9.4 | Telas | Projects; Features (lista com status); detalhe da Feature (DAG de Tasks, gates por iteração, requisitos, findings do review, resumo de entrega, diff, link do PR); agente ao vivo (SSE de `/tasks/:id/live`); providers/saúde; memória do Project |
| M9.5 | Ações | As mesmas do M8.5, com confirmação nas destrutivas; nova Feature/bugfix com o mesmo tratamento de sobreposição (`ask_user` → isolar/absorver) |
| M9.6 | Chat com o Lead | Conversa do Project (`/projects/:id/chat`), com histórico |
| M9.7 | Mobile | Layout mobile-first (celular no Tailscale). Notificação de "Feature pronta para PR" via web push é **condicional**: só se o uso mostrar que abrir a página não basta |

#### Testes obrigatórios

- E2E (ex.: Playwright) contra um daemon de teste com FakeHarness: login, criar Feature, ver Tasks e agente ao vivo, aprovar → PR fake.
- Sem sessão → 401 em todas as rotas de escrita; CSRF rejeitado; sessão expirada pede login de novo.
- O app não é servido no socket local nem em interface que não seja a do Tailscale.

#### Gate de saída

- [ ] Pelo celular, uma Feature é criada, ajustada, revisada (gates, findings, diff) e aprovada até o PR, sem abrir terminal.
- [ ] Nada da interface acessível fora do Tailscale; token nunca exposto no navegador.
- [ ] Nenhuma regra de negócio nova: a web usa as mesmas rotas da CLI/TUI.

---

## 9. Trade-offs conhecidos

| Decisão | Custo aceito | Quando revisitar |
|---|---|---|
| Execução por ondas (M2) | Uma Task rápida espera a mais lenta da onda | Se o tempo ocioso medido passar de ~30% da duração da Feature |
| Restart mata os workers (M1/M3) | Trabalho em andamento é retomado por handover, não continuado | Se restarts forem frequentes na VM |
| Lead via harness, sem API (seção 2.1) | Latência maior e saída JSON menos confiável que numa API com tool use | Se a taxa de `invalid_output` do `LeadRunner` passar de ~10% |
| Capacidade reativa (M3) | O sistema só descobre que o provider esgotou quando uma Task falha | Quando houver collector oficial confiável |
| Merge sequencial (M2) | Mais conflitos que uma estratégia baseada em ownership de arquivos | Se Tasks corretivas de conflito forem frequentes |
| `FeatureOverlapCheck` heurístico (M2) | Pode não detectar overlap real (falso negativo) | O merge na branch de integração já pega a colisão de qualquer forma; revisitar se falsos negativos virarem frequentes em uso real |
| Mailbox em vez de canal ao vivo (M2) | Mensagem para role dinâmica só chega no próximo worker daquela role, nunca durante a execução atual | Se o uso mostrar necessidade real de resposta síncrona de um worker rodando agora |
| Sem auto-absorb no `FeatureOverlapCheck` (M2) | Todo overlap detectado interrompe o usuário com uma pergunta, mesmo quando a interseção seria inofensiva | Se o volume de perguntas se mostrar alto e os dados mostrarem que a camada semântica acerta de forma confiável |
| Workers de execução permanecem efêmeros (M2) | Sem continuidade implícita de conversa entre Tasks da mesma role | Troca: preserva paralelismo e portabilidade entre providers — ver seção 4.6 do ROADMAP para a análise completa |

---

## 10. Definition of Done de qualquer entrega

1. `pnpm check` passa.
2. Testes novos para o comportamento novo, com prioridade para os temas da regra 13 do PLAN.md: routing, failover, recovery, dependências, isolamento de worktree e quality gates.
3. Toda mudança de estado passa pela state machine e emite evento.
4. Nenhum código específico de provider fora de `packages/harnesses` — isso inclui collectors de capacidade/usage, não só os harnesses de execução.
5. Operação longa é retomável após restart, ou o motivo de não ser está registrado como trade-off.
6. Se a entrega muda um contrato da seção 6, este documento é atualizado no mesmo commit.
7. Nenhum processo de worker recebe environment além da allowlist de `buildWorkerEnvironment()`.

---

## 11. Referência de comandos (`apo`)

Lista consolidada de todo comando citado no PLAN.md e nos adendos deste roadmap, com a fase que o entrega. É a fonte única de consulta — as tabelas de entregas de cada fase continuam sendo onde o comando é *implementado*, esta seção é só o índice.

> **Pendente de confirmação:** todo comando que opera sobre um Project ainda não tem definido como resolve *qual* Project é o alvo. A proposta em discussão é resolver por `cwd` (sobe o diretório procurando `.apo/project.yaml`, como o git faz com `.git`), com `--project <nome>` como override explícito — necessário para rodar `apo run` em dois projetos ao mesmo tempo, em dois terminais. Ainda não adotado formalmente; ver conversa sobre multi-projeto simultâneo.

### Setup

| Comando | O que faz | Chega em |
|---|---|---|
| `apo init` | Cria `~/.apo/config.yaml` com defaults | M1.3 |
| `apo project add <path>` | Registra um Project; valida que é repo git e lê `.apo/project.yaml` | M1.3 |
| `apo project list` | Lista Projects registrados | M1.3 |
| `apo project show <name>` | Detalhe de um Project: config, gates, roles efetivos | M1.3 |

### Daemon

| Comando | O que faz | Chega em |
|---|---|---|
| `apo daemon start` | Spawn destacado do daemon, espera `/health` | M1.2 |
| `apo daemon status` | Consulta `/health` | M1.2 |
| `apo daemon stop` | SIGTERM gracioso, espera encerrar | M1.2 |

### Executar trabalho

| Comando | O que faz | Chega em |
|---|---|---|
| `apo run "<objetivo>" [--harness <id>] [--as question\|bugfix\|feature]` | Entrada principal. `--harness` força o harness (só M1, seleção manual); `--as` sobrescreve o `IntentTriage` | M1 (um Task/dois harnesses) → evolui com paralelismo (M2), failover (M3), quality/review completos (M4) |
| `apo chat` | REPL conversacional com o Lead, contexto persistente por Project | M6.2 |

### Consultar

| Comando | O que faz | Chega em |
|---|---|---|
| `apo status` | Resumo de Features ativas do Project | M1.12 |
| `apo feature list` | Lista Features | M1.12 |
| `apo feature show <id>` | Detalhe de uma Feature: status, Tasks, requirements, quality/review | M1.12 |
| `apo task list` | Lista Tasks | M1.12 |
| `apo task show <id>` | Detalhe de uma Task: worktree, branch, attempts, artefatos, routing decision | M1.12 |
| `apo logs <feature> [-f]` | Logs da Feature; `-f` segue via SSE | M1.12 |
| `apo providers` | Status/usage por provider (seção 15 do PLAN.md) | M3.10 |
| `apo role list` | Roles resolvidos (embutidos + overrides do Project) | M2.17 |
| `apo role show <id>` | `systemPrompt` e `executionPreference` efetivos de um role | M2.17 |

### Controlar execução

| Comando | O que faz | Chega em |
|---|---|---|
| `apo pause <feature>` | Para o scheduler de criar novos attempts; attempts em execução seguem até o fim | M1.16 |
| `apo resume <feature>` | Retoma o scheduler | M1.16 |
| `apo cancel <feature>` | Interrompe attempts ativos (`AbortSignal`) e marca a Feature `cancelled` | M1.16 (robustez total de kill de processo a partir do M2.3) |
| `apo task reroute <id> --provider <p>` | Reroute manual: pausa → handover → stop → novo target, mesma worktree/branch | M3.10 |
| `apo task answer <id> "<resposta>"` | Responde uma Task em `awaiting_answer`/`needs_human`, dispara nova attempt | M2.21 |

### Overrides de execução (seção 14.1 do PLAN.md)

| Comando | O que faz | Chega em |
|---|---|---|
| `apo task assign <id> --provider <p> --harness <h> [--model <m>]` | Define `ExecutionPreference.mode = "forced"` na Task | M3.10 |
| `apo task preference <id> --mode auto\|preferred\|forced` | Ajusta o modo de preferência sem mudar o target | M3.10 |
| `apo feature preference <feature> --provider <p> --harness <h>` | Define preferência no nível da Feature (sobrescrita por Task override) | M3.10 |

### Entrega

| Comando | O que faz | Chega em |
|---|---|---|
| `apo approve <feature>` | Resume o `interrupt()` de aprovação, dispara `create_pr` | M4.8 |
| `apo reject <feature> --reason "<motivo>"` | Resume o `interrupt()` recusando; Feature volta a `fixing` ou fica `rejected` | M4.8 |
