# APO Agent Orchestrator

## 1. Visão do produto

Construir um sistema local de orquestração agentic para desenvolvimento de software.

O usuário fornece um objetivo de alto nível, por exemplo:

> Crie uma página para apresentar os produtos da empresa.

O sistema deve ser capaz de:

1. analisar o projeto;
2. recuperar contexto e memória relevante;
3. transformar o objetivo em uma Feature;
4. decompor a Feature em Tasks;
5. identificar dependências entre Tasks;
6. detectar quais Tasks podem ser executadas em paralelo;
7. classificar complexidade e risco;
8. escolher dinamicamente provider + modelo;
9. executar workers em worktrees isoladas;
10. acompanhar execução;
11. substituir workers que falharem ou atingirem quota;
12. integrar os resultados;
13. executar quality gates;
14. fazer code review;
15. corrigir problemas encontrados;
16. preparar a entrega;
17. pedir autorização humana antes de abrir o Pull Request.

O objetivo da V1 não é criar uma empresa completamente autônoma.

O objetivo é criar uma:

**Autonomous Software Factory local e provider-agnostic.**

---

# 2. Princípios fundamentais

## 2.1 Provider agnostic

Claude, Codex e Gemini são recursos substituíveis.

Nenhuma regra de negócio pode depender diretamente deles.

Usar abstrações como:

```ts
interface AgentHarness {
  id: string;
  provider: ProviderId;

  execute(input: AgentExecutionInput): Promise<AgentExecutionResult>;
  resume(input: ResumeExecutionInput): Promise<AgentExecutionResult>;

  getCapabilities(): AgentCapabilities;
  getCapacity(): Promise<ProviderCapacitySnapshot>;
}
```

Implementações iniciais:

```text
ClaudeCodeHarness
CodexHarness
GeminiCliHarness
```

Futuramente:

```text
OpenHandsHarness
ApiHarness
LocalModelHarness
RemoteWorkerHarness
```

---

## 2.2 LangGraph é o orchestration runtime

Não implementar engine próprio de state machine, checkpoint ou graph execution na V1.

LangGraph deve controlar:

```text
state
branching
parallelism
retry
resume
interrupts
human-in-the-loop
subgraphs
```

As regras do APO pertencem ao projeto.

LangGraph apenas executa essas regras.

---

# 3. Modelo conceitual

Usar:

```text
Project
└── Feature
    └── Task
```

## Project

Representa um repositório/produto.

Exemplo:

```text
Project:
Orbit Jobs
```

Contém:

```text
repo
configuração
memória
workflows
provider preferences
quality gates
histórico
```

---

## Feature

Representa um objetivo completo solicitado pelo usuário.

Exemplo:

```text
Feature:
Criar página de produtos
```

Uma Feature possui:

```text
status
objective
requirements
workflow
tasks
dependencies
history
quality result
PR status
```

Estados iniciais:

```text
created
planning
executing
integrating
validating
reviewing
awaiting_user
ready
failed
paused
completed
```

---

## Task

Menor unidade distribuível para um worker.

Exemplo:

```text
Feature: Página de produtos

Tasks:

T1 analisar estrutura atual
T2 criar ProductCard
T3 criar ProductsPage
T4 integrar API
T5 criar testes
T6 validar responsividade
```

Cada Task contém:

```ts
type Task = {
  id: string;
  featureId: string;

  title: string;
  description: string;

  dependencies: string[];

  status: TaskStatus;

  complexity?: Complexity;
  risk?: Risk;

  assignedTarget?: ExecutionTarget;

  worktree?: string;
  branch?: string;

  attempts: TaskAttempt[];
};
```

---

# 4. Modelo dos agentes

Usar arquitetura híbrida.

## Lead

Persistente por Project.

Responsabilidades:

```text
entender objetivos
conversar com usuário
planejar
decompor Features
adaptar workflows
criar Tasks
interpretar resultados
resolver ambiguidades
acompanhar execução
decidir replanning
```

"Persistente" significa principalmente:

```text
identidade persistente
conversation/thread persistente
memory persistente
state persistente
```

Não é obrigatório manter um processo CLI eternamente aberto.

---

## Workers

Efêmeros.

Criados sob demanda para executar uma Task.

Exemplo:

```text
Task criada
↓
router seleciona Codex
↓
WorkerManager cria CodexWorker
↓
cria worktree
↓
worker executa
↓
resultado persistido
↓
worker é encerrado
```

Não criar conceitos fixos como:

```text
FrontendAgent
BackendAgent
CSSAgent
```

O papel deve vir da Task.

Um worker pode hoje trabalhar com React e amanhã com backend.

---

## Reviewer

Inicialmente pode ser worker efêmero especializado em review.

Idealmente deve usar provider/modelo diferente do executor quando houver capacidade.

Exemplo:

```text
implementation: Codex
review: Claude
```

---

# 5. Arquitetura geral

```text
                   User
                    │
             CLI / Chat Session
                    │
                    ▼
             APO Application
                    │
             Persistent Lead
                    │
                    ▼
               LangGraph
                    │
      ┌─────────────┼──────────────┐
      │             │              │
 Planning      Task Routing     Recovery
      │             │              │
      │            Jev             │
      │             │              │
      └─────────────┼──────────────┘
                    │
             Worker Manager
                    │
        ┌───────────┼────────────┐
        │           │            │
     Claude       Codex       Gemini
      Code          CLI          CLI
        │           │            │
        └─────── worktrees ──────┘
                    │
             Quality Gates
                    │
                Reviewer
                    │
              PR Approval
                    │
                  GitHub
```

---

# 6. Componentes

Separar os módulos explicitamente.

```text
apps/
  cli/
  daemon/

packages/
  core/
  orchestrator/
  domain/
  providers/
  router/
  workers/
  workflows/
  memory/
  git/
  quality/
  persistence/
  observability/
  config/
```

Preferir monorepo pnpm.

---

# 7. CLI

A V1 deve possuir:

```bash
apo init

apo project add
apo project list
apo project show

apo run "Crie uma página de produtos"

apo chat

apo feature list
apo feature show <id>

apo task list
apo task show <id>

apo status

apo providers

apo resume <feature>
apo pause <feature>
apo cancel <feature>

apo logs <feature>
```

## Experiência conversacional

Também deve existir:

```bash
apo chat
```

Exemplo:

```text
APO > Crie uma página para mostrar os produtos.

Lead > Analisei o projeto e criei a feature...

Lead > Foram identificadas 4 tasks...
```

O usuário deve poder continuar:

```text
APO > Não altere o backend.
```

O Lead atualiza a Feature/plan existente.

---

# 8. Daemon

Criar:

```bash
apo daemon start
apo daemon status
apo daemon stop
```

Em produção no homelab:

```text
systemd
└── apo.service
```

O daemon mantém:

```text
LangGraph runs
worker processes
task scheduling
provider health
retry
feature recovery
event stream
```

O CLI deve conversar com o daemon.

Não executar toda a lógica diretamente dentro do processo CLI.

---

# 9. Estado LangGraph

Criar um `FeatureState`.

Exemplo:

```ts
interface FeatureState {
  projectId: string;
  featureId: string;

  objective: string;

  requirements: Requirement[];

  tasks: Task[];

  workflow: WorkflowInstance;

  projectContext: ProjectContext;

  providerCapacity: ProviderCapacitySnapshot[];

  executionResults: ExecutionResult[];

  qualityResults: QualityResult[];

  reviewFindings: ReviewFinding[];

  iteration: number;

  status: FeatureStatus;
}
```

---

# 10. Graph principal

Implementar inicialmente:

```text
START
  ↓
load_project
  ↓
retrieve_memory
  ↓
understand_feature
  ↓
plan_feature
  ↓
create_tasks
  ↓
resolve_dependencies
  ↓
route_tasks
  ↓
execute_ready_tasks
  ↓
wait_for_results
  ↓
handle_failures
  ↓
integration
  ↓
quality_gates
  ↓
review
  ↓
       ┌── problems ──→ fix_tasks ──┐
       │                            │
       └──────────── loop ──────────┘
  ↓
prepare_delivery
  ↓
interrupt: PR approval
  ↓
create_pr
  ↓
END
```

---

# 11. Paralelismo

Tasks devem formar um DAG.

Exemplo:

```text
         ┌── T2 frontend ───┐
T1 plan ─┼── T3 backend ────┼→ T5 integration
         └── T4 tests setup ┘
```

Quando:

```text
dependencies(task) == completed
```

a Task fica:

```text
READY
```

Todos os READY tasks podem ser executados paralelamente respeitando:

```text
maxGlobalWorkers
maxWorkersPerProvider
provider availability
resource limits
dependency constraints
```

---

# 12. Git isolation

Cada coding Task deve receber seu próprio worktree.

Exemplo:

```text
/repos/orbit-jobs/main

/worktrees/
  feature-123-task-1/
  feature-123-task-2/
  feature-123-task-3/
```

Branches:

```text
apo/f123/t1-product-card
apo/f123/t2-products-page
```

Criar `WorktreeManager`.

Responsabilidades:

```text
create
prepare
cleanup
merge/rebase
detect conflicts
```

Nunca permitir dois workers editarem diretamente a mesma working tree.

---

# 13. Worker lifecycle

```text
Task READY
↓
Router
↓
ExecutionTarget escolhido
↓
Worktree criada
↓
Worker spawned
↓
Worker executa
↓
captura resultado
↓
persistência
↓
worker finalizado
```

Estados:

```text
starting
working
completed
failed
rate_limited
stalled
cancelled
```

---

# 14. Provider/model abstraction

Separar:

```text
Provider
Model
Harness
```

Exemplo:

```text
Provider: OpenAI
Harness: Codex CLI
Model: GPT-x-Codex
```

O router escolhe um `ExecutionTarget`:

```ts
type ExecutionTarget = {
  provider: ProviderId;
  harness: HarnessId;
  model: string;

  capabilities: string[];

  capacity: ProviderCapacitySnapshot;
};
```

## 14.1. Execution Preferences and Manual Overrides

Role, Provider, Harness e Model são conceitos independentes.

Um agente não deve ser identificado pelo modelo que o executa.

Exemplo:

```text
Role: backend-developer
ExecutionPreference: preferred Claude
ExecutionTarget: Claude Code + modelo selecionado
```

Toda Task deve possuir ou herdar uma `ExecutionPreference`.

```ts
type ExecutionMode = "auto" | "preferred" | "forced";

interface ExecutionPreference {
  mode: ExecutionMode;

  provider?: ProviderId;
  harness?: HarnessId;
  model?: string;
}
```

### Modos

`auto`

O sistema escolhe completamente o ExecutionTarget usando o router configurado, incluindo Jev, disponibilidade, usage, capacidade e regras do projeto.

`preferred`

O sistema tenta utilizar o target indicado, mas pode selecionar outro provider/modelo se existir motivo operacional, como:

- quota esgotada;
- rate limit;
- indisponibilidade;
- incapacidade técnica;
- diferença relevante de capacidade disponível.

`forced`

O sistema deve utilizar o target explicitamente escolhido.

Caso ele não esteja disponível, a Task deve pausar ou solicitar intervenção, em vez de automaticamente selecionar outro provider.

---

### Hierarquia de resolução

Preferências mais específicas sobrescrevem preferências mais gerais.

```text
Task explicit override
        ↓
Feature override
        ↓
Project Role preference
        ↓
Jev / automatic router
        ↓
Global default
```

Uma escolha manual explícita nunca deve ser silenciosamente sobrescrita pelo Jev.

---

### ExecutionTarget

A `ExecutionPreference` representa intenção.

O `ExecutionTarget` representa a decisão efetiva de execução.

```ts
interface ExecutionTarget {
  provider: ProviderId;
  harness: HarnessId;
  model: string;

  capabilities: string[];

  resolutionSource:
    | "task_override"
    | "feature_override"
    | "role_preference"
    | "jev"
    | "rule_router"
    | "global_default";

  capacity: ProviderCapacitySnapshot;
}
```

O processo deve ser:

```text
Task
 ↓
ExecutionPreference
 ↓
ExecutionTargetResolver
 ↓
ExecutionTarget
 ↓
Worker
```

Jev é apenas uma estratégia utilizada pelo `ExecutionTargetResolver` quando o modo permite seleção automática.

---

### Overrides manuais

A CLI deve permitir alterar preferências explicitamente.

Exemplos:

```bash
apo task assign T-123 --provider anthropic --harness claude-code

apo task assign T-123 \
  --provider openai \
  --harness codex \
  --model <model>

apo feature preference F-42 --provider google --harness gemini

apo task preference T-123 --mode auto
```

Também deve ser possível realizar override através da interface conversacional.

Exemplo:

```text
User:
Use Claude para as próximas tasks de backend desta Feature.

Lead:
Execution preference atualizada para esta Feature.
```

---

### Manual reroute durante execução

Uma Task em andamento também pode ser transferida manualmente.

Exemplo:

```bash
apo task reroute T-123 --provider anthropic
```

Fluxo:

```text
current worker
 ↓
pause execution
 ↓
create structured handover
 ↓
persist current state
 ↓
stop current worker
 ↓
resolve new ExecutionTarget
 ↓
start new worker
 ↓
resume using same Task/worktree
```

Devem ser preservados:

- Task state;
- worktree;
- branch;
- git diff;
- arquivos modificados;
- logs relevantes;
- comandos executados;
- testes executados;
- handover;
- project memory relevante.

---

### Regra arquitetural

Nenhum agente deve ser definido como:

```text
ClaudeBackendAgent
CodexReviewer
GeminiFrontendAgent
```

O modelo correto é:

```text
Role
 ↓
ExecutionPreference
 ↓
ExecutionTarget
 ↓
Provider / Harness / Model
```

Isso permite trocar modelos e providers sem alterar a identidade, memória, responsabilidade ou configuração funcional do agente.

---

# 15. Provider capacity

Criar:

```ts
interface ProviderCapacitySnapshot {
  provider: ProviderId;

  availability:
    | "available"
    | "degraded"
    | "exhausted"
    | "unknown";

  usagePercent?: number;

  resetAt?: Date;

  activeWorkers: number;

  maxConcurrentWorkers?: number;

  capturedAt: Date;
}
```

Muito importante:

`usagePercent` é opcional.

Nunca inventar percentuais quando o provider não os disponibilizar.

---

# 16. Usage collectors

Criar:

```text
CodexUsageCollector
ClaudeUsageCollector
GeminiUsageCollector
```

Cada collector tenta obter:

```text
usage
quota
reset
rate limit
availability
```

através da interface oficial disponível.

Fallback:

```text
dados exatos indisponíveis
→ availability = unknown
```

Se ocorrer erro de quota:

```text
availability = exhausted
```

Se ocorrer rate-limit temporário:

```text
availability = degraded
resetAt = ...
```

O sistema deve continuar funcionando mesmo sem percentual exato.

---

# 17. Jev Routing Engine

Jev deve ser implementado através de uma interface:

```ts
interface TaskRouter {
  route(input: RoutingInput): Promise<RoutingDecision>;
}
```

Implementações previstas:

```text
JevTaskRouter
RuleBasedRouter
```

Jev é requisito da V1, mas não pode ficar acoplado ao restante do sistema.

---

## Input do Jev

Enviar:

```text
task
task type
complexity clues
risk clues
files/modules envolvidos
project information

available execution targets

para cada target:
provider
model
capabilities
usage %
availability
active workers
reset time
```

---

## Jev deve avaliar

```text
complexity
risk
required reasoning level
expected duration
best target
fallback target
review requirement
confidence
```

Exemplo conceitual:

```json
{
  "complexity": "medium",
  "risk": "low",
  "preferredTarget": "gemini-worker",
  "fallbackTarget": "claude-worker",
  "requiresReview": true,
  "confidence": 0.91
}
```

---

# 18. Capacity-aware routing

A seleção não pode depender apenas de inteligência do modelo.

Exemplo:

```text
Codex:
usage 80%

Claude:
usage 40%

ambos adequados à Task
```

Preferir Claude.

Regras determinísticas devem complementar Jev.

Fluxo:

```text
1. eliminar providers unavailable/exhausted
2. eliminar modelos incapazes da Task
3. coletar capacidade atual
4. enviar candidatos + Task para Jev
5. Jev classifica
6. capacity policy valida a decisão
7. target final escolhido
```

Configuração inicial:

```yaml
routing:
  capacityAware: true

  degradedAt: 80
  avoidAt: 95

  preferLowerUsageDifference: 20
```

Esses valores devem ser configuráveis.

Jev pode preferir um modelo mais ocupado caso exista diferença significativa de capacidade técnica, mas deve receber explicitamente usage/headroom como parte do estado.

---

# 19. Failure e automatic handoff

Caso um worker falhe:

```text
Worker A
↓
rate limited / quota / crash / stall
↓
persist task progress
↓
Task → retrying
↓
router reexecutado
↓
Worker B
↓
resume
```

Priorizar outro provider com mais capacidade disponível.

Nunca deixar uma Feature permanentemente bloqueada porque um único provider atingiu quota.

Se todos estiverem indisponíveis:

```text
Feature → paused_capacity
```

Notificar usuário.

Não usar API paga automaticamente na V1.

---

# 20. Handover context

Antes de trocar worker, criar `TaskHandover`.

```ts
interface TaskHandover {
  taskId: string;

  objective: string;

  completedWork: string[];

  changedFiles: string[];

  currentState: string;

  commandsRun: string[];

  testsRun: string[];

  failures: string[];

  recommendedNextSteps: string[];
}
```

O novo worker recebe:

```text
original task
+
handover
+
git diff
+
relevant project memory
```

Não passar conversation history gigante se um resumo estruturado for suficiente.

---

# 21. Workflow templates

Criar templates adaptáveis.

Inicialmente:

## Feature

```text
PLAN
→ IMPLEMENT
→ INTEGRATE
→ TEST
→ REVIEW
→ FIX
→ DELIVERY
```

## Bugfix

```text
REPRODUCE
→ DIAGNOSE
→ FIX
→ TEST
→ REVIEW
```

## Refactor

```text
ANALYZE
→ PLAN
→ IMPLEMENT
→ REGRESSION TEST
→ REVIEW
```

O Lead pode:

```text
remover etapas
adicionar etapas
reordenar
criar Tasks adicionais
```

Workflow é guideline estruturado, não prisão.

---

# 22. Project Memory

Usar memória persistente.

Stack:

```text
PostgreSQL
+
pgvector
```

Evitar banco vetorial separado na V1.

Categorias de memória:

```text
architecture
conventions
decisions
known_problems
successful_patterns
failed_attempts
preferences
module_summaries
```

---

## Memory ingestion

Gerar memória a partir de:

```text
README
AGENTS.md
CLAUDE.md
docs/
ADRs
package manifests
important source summaries
completed Features
review findings
failures
user corrections
```

Não indexar indiscriminadamente todo arquivo a cada execução.

---

## Embeddings

Abstrair:

```ts
interface EmbeddingProvider
```

Preferir inicialmente embeddings locais no homelab para não introduzir custo obrigatório de API.

---

# 23. Memory retrieval

Antes do planning:

```text
Feature
↓
semantic search
↓
relevant Project Memory
↓
Lead
```

Antes de uma Task:

```text
Task
↓
semantic search
↓
module-specific memory
↓
Worker
```

---

# 24. Quality Gates

Feature só pode avançar para entrega quando os gates obrigatórios passarem.

Core gates:

```text
build
lint
typecheck
tests
requirements verification
review
```

Configuração por Project:

```yaml
quality:
  commands:
    build: pnpm build
    lint: pnpm lint
    typecheck: pnpm typecheck
    tests: pnpm test
```

Todos os resultados devem ser persistidos.

---

# 25. Reviewer

Depois da integração:

```text
diff
requirements
test output
memory
```

são enviados ao Reviewer.

O reviewer deve procurar:

```text
bugs
requirement gaps
regressions
security problems
unnecessary complexity
architecture violations
missing tests
```

Findings precisam ser estruturados:

```ts
interface ReviewFinding {
  severity: "low" | "medium" | "high" | "critical";
  file?: string;
  description: string;
  suggestedFix?: string;
}
```

Findings relevantes geram novas Tasks automaticamente.

---

# 26. Completion contract

Uma Feature só pode ser `ready` quando:

```text
requirements satisfied
AND
build passed
AND
lint passed
AND
typecheck passed
AND
tests passed
AND
review accepted
```

O Lead não pode declarar sucesso apenas porque um worker disse "done".

---

# 27. PR approval

Configuração:

```yaml
git:
  requirePrApproval: true
```

Fluxo default:

```text
Feature pronta
↓
branch preparada
↓
summary gerado
↓
APO pergunta:

"Feature pronta. Abrir PR?"

↓
human approval
↓
PR criado
```

Merge nunca será automático na V1.

Adicionar futuramente:

```yaml
requirePrApproval: false
```

---

# 28. YOLO mode

V1 usa:

```text
mode = yolo
```

O agente pode automaticamente:

```text
editar arquivos
executar comandos
instalar dependências
criar worktrees
criar branches
commit
push
```

PR ainda segue sua configuração própria.

Arquitetura deve reservar:

```text
safe
standard
yolo
```

mas apenas `yolo` precisa funcionar inicialmente.

Mesmo em YOLO:

```text
não permitir acesso irrestrito ao host inteiro
```

Workers devem ficar restritos ao workspace/repo.

---

# 29. Persistência

PostgreSQL deve armazenar:

```text
projects
features
tasks
task_attempts
workers
provider_capacity
workflow_instances
review_findings
quality_results
events
memories
conversation_threads
```

LangGraph deve usar checkpointer persistente.

Process restart não pode perder Feature em andamento.

---

# 30. Event log

Toda mudança importante deve produzir evento:

```text
feature.created
feature.planned

task.created
task.assigned
task.started
task.completed
task.failed
task.rerouted

provider.degraded
provider.exhausted

worker.spawned
worker.stopped

quality.failed
review.completed

feature.awaiting_pr_approval
```

Isso será base futura para:

```text
TUI
Web UI
analytics
debugging
audit
```

---

# 31. Observability

Desde a V1 registrar:

```text
duration
provider
model
worker
retries
failures
routing decision
Jev confidence
quality failures
usage before/after
```

Não construir dashboard complexo inicialmente.

Structured logging é suficiente.

---

# 32. Homelab deployment

Target inicial:

```text
Proxmox
└── Ubuntu VM
    ├── APO daemon
    ├── Claude Code
    ├── Codex CLI
    ├── Gemini CLI
    │
    └── Docker
        └── PostgreSQL + pgvector
```

APO daemon:

```text
systemd
```

Acesso remoto:

```text
Tailscale
```

Não expor publicamente na internet na V1.

---

# 33. Segurança do host

Criar usuário Linux dedicado:

```text
apo
```

Workspace:

```text
/home/apo/projects
/home/apo/worktrees
```

Não dar:

```text
sudo irrestrito
/home/jeff
secrets do homelab
Docker socket irrestrito
```

A capacidade agentic deve ficar limitada ao ambiente de desenvolvimento.

---

# 34. Estrutura sugerida do repo

```text
apo/
├── apps/
│   ├── cli/
│   └── daemon/
│
├── packages/
│   ├── core/
│   ├── domain/
│   ├── orchestrator/
│   ├── providers/
│   │   ├── claude-code/
│   │   ├── codex/
│   │   └── gemini/
│   ├── routing/
│   │   ├── jev/
│   │   └── rules/
│   ├── workers/
│   ├── workflows/
│   ├── memory/
│   ├── git/
│   ├── quality/
│   ├── persistence/
│   ├── observability/
│   └── config/
│
├── migrations/
├── docs/
├── docker/
├── pnpm-workspace.yaml
└── package.json
```

---

# 35. Fases de desenvolvimento

## Phase 0 — Foundation

Objetivo:

projeto executável e arquitetura limpa.

Implementar:

```text
pnpm monorepo
TypeScript strict
lint
tests
config
logging
Postgres
migrations
domain models
```

Critério de aceite:

```bash
pnpm test
pnpm build
```

passam.

---

## Phase 1 — Project + Feature persistence

Implementar:

```bash
apo project add
apo project list

apo run "objetivo"
apo feature list
apo feature show
```

Ainda sem LLM.

Criar Features e Tasks fake/manuais.

Critério:

restart do daemon mantém tudo.

---

## Phase 2 — First LangGraph vertical slice

Implementar graph mínimo:

```text
objective
→ plan
→ task
→ execute
→ verify
→ complete
```

Usar inicialmente apenas um harness.

Preferência:

```text
CodexHarness
```

ou o CLI que estiver mais simples de automatizar.

Objetivo da fase:

provar:

```text
APO → LangGraph → coding agent → repo
```

---

## Phase 3 — Worktrees + Worker Manager

Implementar:

```text
WorkerManager
WorktreeManager
ProcessSupervisor
TaskAttempt
```

Workers devem ser efêmeros.

Critério:

duas Tasks independentes podem executar simultaneamente sem compartilhar working tree.

---

## Phase 4 — Claude + Codex + Gemini

Implementar três adapters.

Todos devem obedecer o mesmo `AgentHarness`.

Testes contratuais:

```text
execute
resume
timeout
cancel
failure
structured result
```

Nenhum código do orchestrator deve conter:

```text
if (provider === "codex")
```

fora da camada de adapters.

---

## Phase 5 — Provider health + usage

Implementar:

```text
UsageCollector
ProviderRegistry
CapacityMonitor
```

CLI:

```bash
apo providers
```

Exemplo:

```text
PROVIDER   STATUS       USAGE
Claude     available    42%
Codex      degraded     82%
Gemini     available    37%
```

Quando percentual não estiver disponível:

```text
unknown
```

---

## Phase 6 — Jev Router

Integrar Jev.

Implementar:

```text
JevTaskRouter
RoutingDecision
RoutingAudit
```

Testar casos:

```text
simple task
complex task
high-risk task
provider near quota
provider exhausted
provider unknown
```

Critério principal:

com dois targets equivalentes:

```text
A usage 80%
B usage 40%
```

o sistema deve tender a selecionar B.

---

## Phase 7 — Parallel task DAG

Planner passa a gerar:

```text
Tasks
+
dependencies
```

LangGraph executa ready tasks em paralelo.

Implementar:

```text
fan-out
fan-in
dependency resolution
global concurrency
provider concurrency
```

---

## Phase 8 — Failover

Simular:

```text
Codex começa Task
↓
rate limit
```

Sistema deve:

```text
gerar handover
marcar attempt failed/rate_limited
consultar capacity
rerotear
Claude/Gemini assumir
continuar
```

Sem intervenção humana.

Esse é um dos critérios centrais da V1.

---

## Phase 9 — Project Memory

Adicionar:

```text
pgvector
EmbeddingProvider
MemoryRepository
MemoryRetriever
MemoryWriter
```

Planejamento e execução devem receber memories relevantes.

Persistir aprendizados após Feature.

---

## Phase 10 — Quality + Review loops

Implementar gates:

```text
build
lint
types
tests
requirements
review
```

Falha gera Task corretiva.

Limitar loop:

```text
maxFixIterations
```

Se exceder:

```text
feature → needs_human
```

---

## Phase 11 — PR delivery

Implementar GitHub integration.

Fluxo:

```text
summary
changes
quality report
review report
↓
human approval
↓
push/open PR
```

CLI:

```bash
apo approve <feature>
apo reject <feature>
```

---

## Phase 12 — Conversational Lead

Implementar:

```bash
apo chat
```

Lead mantém contexto persistente por Project.

Deve conseguir:

```text
criar Feature
alterar requirement
consultar status
cancelar Task
replanejar Feature
explicar decisão de routing
```

---

## Phase 13 — Homelab hardening

Adicionar:

```text
systemd
startup recovery
health endpoint
backup
log rotation
Tailscale access
process cleanup
orphan worktree cleanup
```

Teste:

reiniciar VM durante execução.

Após boot:

```text
Feature deve ser retomável.
```

---

## Phase 14 — TUI

Somente depois do motor estar estável.

Exibir:

```text
Projects

Features
Products Page       EXECUTING
Auth Refactor       REVIEWING

Tasks
T1 ✓
T2 Claude working
T3 Gemini working
T4 Codex rate-limited

Providers
Claude  41%
Codex   89%
Gemini  34%

Workers
...
```

A TUI consome os mesmos APIs/events usados pela CLI.

Não duplicar regras de negócio.

---

# 36. O que NÃO construir na V1

Não implementar ainda:

```text
multi-user
cloud SaaS
billing
mobile app
complex RBAC
distributed cluster
Kubernetes
automatic production deploy
automatic PR merge
generic business agents
marketing agents
self-modifying orchestration
custom orchestration engine
```

Manter escopo:

**uma excelente software factory pessoal.**

---

# 37. Regras para a IA que estiver desenvolvendo

1. Não antecipar fases sem terminar critérios de aceite da atual.

2. Fazer vertical slices pequenos.

3. Não criar abstrações sem uso real.

4. Provider-specific code deve ficar apenas dentro de adapters/collectors.

5. Nenhum provider pode ser requisito estrutural do sistema.

6. Toda operação long-running precisa ser persistível/recoverable.

7. Toda decisão importante de routing deve ser auditável.

8. Nunca marcar Task como concluída baseado apenas no texto do agent.

9. Quality gates são autoridade de conclusão.

10. Preferir processos determinísticos para:
   - Git;
   - checks;
   - dependency resolution;
   - capacity rules;
   - state transitions.

11. Usar LLM/Jev apenas onde julgamento semântico agrega valor.

12. Antes de adicionar nova dependência, justificar por que código simples não resolve.

13. Escrever testes especialmente para:
   - routing;
   - failover;
   - recovery;
   - task dependencies;
   - worktree isolation;
   - quality gates.

---

# 38. Critério de sucesso da V1

A V1 estará concluída quando este cenário funcionar:

```text
User:
apo run "Crie uma página para apresentar nossos produtos"

↓

Lead analisa repo + memory

↓

Feature criada

↓

Tasks criadas com dependências

↓

Jev classifica Tasks

↓

Provider capacity consultada

↓

Claude/Codex/Gemini selecionados

↓

3 Tasks executadas em paralelo em worktrees

↓

Codex atinge quota durante uma Task

↓

APO detecta

↓

handover criado

↓

Task é transferida para Claude/Gemini

↓

implementação termina

↓

branches integradas

↓

build
lint
typecheck
tests
passam

↓

Reviewer encontra 2 problemas

↓

Tasks corretivas são criadas

↓

workers corrigem

↓

quality gates passam novamente

↓

APO informa:

"Feature pronta. Deseja abrir o Pull Request?"

↓

usuário aprova

↓

PR criado
```

Esse cenário é o principal end-to-end test do projeto.

---

# 39. Regra arquitetural central

O sistema deve manter esta separação:

```text
WHAT
Project / Feature / Task

HOW
Workflow

WHO
Lead / Dynamic Workers

WHERE
Worktrees

WITH WHAT
Claude / Codex / Gemini

WHICH ONE
Jev + Capacity Router

STATE
LangGraph + PostgreSQL

KNOWLEDGE
Project Memory + pgvector

CORRECTNESS
Quality Gates + Reviewer
```

Se essa separação continuar clara durante o desenvolvimento, o sistema poderá crescer futuramente de uma software factory para o APO completo sem precisar ser reescrito.
