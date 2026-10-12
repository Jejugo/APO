# APO — Roadmap de implementação

Este documento traduz o [PLAN.md](./PLAN.md) em um plano de execução factível. Ele não substitui o PLAN.md como fonte de verdade arquitetural — reordena e corta escopo para chegar ao cenário da seção 38 o mais rápido possível, com o maior risco técnico validado primeiro.

O detalhamento técnico de cada marco (stack, contratos, modelo de dados, entregas e gates de saída) está em [TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md).

---

## 1. Por que reordenar

O PLAN.md tem 14 fases sequenciais. Seguidas na ordem literal, o failover automático — o critério central da V1 (seção 38) — só aparece na Phase 8, depois de Jev, usage collectors e todo o roteamento. Isso adia a validação do maior risco do projeto para o fim.

Este roadmap reagrupa as 14 fases em **7 marcos**, antecipando:

- os spikes de automação dos 3 CLIs (maior incerteza técnica);
- o failover entre providers (critério central);
- a integração de branches (não tinha fase própria no PLAN.md).

E adiando:

- Jev (depende de serviço externo);
- memória/pgvector (otimização sobre um sistema que já funciona);
- TUI e interface web (só depois do motor estar estável — agora M8 e M9).

---

## 2. Riscos identificados e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| **Automatizar CLIs de terceiros** (`claude -p`, `codex exec`, `gemini -p`). Formato de saída, sinal de erro e semântica de "resume" próprios de cada um. | Maior fator de incerteza do projeto. | Spike de 1–2 dias por CLI antes de desenhar `AgentHarness`. A interface nasce do que os CLIs realmente fazem, não do contrário. |
| **Usage/quota (seção 16).** Provavelmente não existe API oficial estável para os três providers. | `UsageCollector` pode virar scraping frágil. | Começar **reativo**: detectar `rate_limited`/`exhausted` pelo erro do CLI, resto fica `unknown`. Collectors proativos só onde houver fonte oficial. |
| **Merge/integração de branches.** Está no graph (`integration`) mas nenhuma fase do PLAN.md cobre isso. | Com Tasks paralelas, conflitos reais aparecem rápido. | Fase explícita no M2. V1 pode ser merge sequencial em branch de feature, com Task corretiva para conflito. |
| **Detecção de overlap entre Features (seção 4.4) é heurística, não garantida.** Duas Features que de fato colidem podem passar pelo `FeatureOverlapCheck` sem alerta. | Falso negativo gera trabalho duplicado ou conflito tardio. | O merge na branch de integração (M2.7/M2.8) já é a rede de segurança determinística: mesmo se o overlap check errar, o `git merge` detecta a colisão real e abre Task corretiva. O overlap check é otimização sobre essa rede, não substituto dela. |
| **Resume entre providers.** Na prática é sempre uma nova execução com handover, não um `resume()` nativo cross-provider. | A interface `resume()` só funciona dentro do mesmo provider. | Handover é o mecanismo principal. `resume` nativo é otimização dentro do mesmo harness. |
| **YOLO mode** rodando no ambiente de desenvolvimento local. | Risco real para a máquina de desenvolvimento. | Desenvolver com repos descartáveis até o M4. YOLO "de verdade" só na VM com usuário `apo` dedicado (seção 33). |
| **Jev** depende de serviço externo (TypeSafe System One). | Pode bloquear o roteamento se acoplado cedo. | `TaskRouter` como interface desde o início. Começar com `RuleBasedRouter`; Jev entra depois sem tocar no resto. |
| **CLI não suporta modo read-only de verdade.** | `WorkspaceMode: shared` fica inseguro — agente pode escrever mesmo sendo "read-only". | Validar no spike do M0. Se o CLI não suportar flag de read-only confiável, essa Task sempre recebe worktree. |
| **Mensageria peer-to-peer ao vivo entre workers efêmeros.** | Workers são processos CLI headless e efêmeros: não há inbox, o destinatário pode não estar rodando, bloquear para esperar resposta gasta quota. Sandbox de CLIs (ex: Codex) pode bloquear sockets locais, como já observado com o Maestri. | Resolvido com mailbox assíncrona (M2, seção 4.2): mensagem para role dinâmica nunca bloqueia quem envia, é entregue no próximo worker daquela role. Só pergunta para agente persistente (Lead/PO/CTO, seção 4.6) pode bloquear, porque esse destinatário está sempre disponível por construção. O canal "ao vivo" entre workers que estão rodando ao mesmo tempo continua adiado, condicionado ao spike M0.12. |
| **Reconstruir infraestrutura de "time de agentes" que já existe em runtimes externos** (Claude Code Agent Teams, multi-agente do Codex, Antigravity Teamwork). | Muito código próprio para manter (mensageria, ciclo de vida de teammates) competindo com produtos que evoluem rápido. | ADR 0003 / seção 4.7: APO como control plane, M2 congelado até um triage dos runtimes externos. Ao contrário, depender de um runtime externo custa o failover entre providers naquela Feature. Por isso o failover (M3) vem primeiro: ele vale nos dois cenários. |
| **Environment do worker herda segredos do daemon.** `execa` repassa `process.env` por padrão — `DATABASE_URL`, `JEV_API_KEY`, `GITHUB_TOKEN` ficariam visíveis a um worker em YOLO. | Allowlist explícita em `buildWorkerEnvironment()` (M2, `ProcessSupervisor`): só variáveis básicas (`HOME`, `PATH`, `SHELL`, `TERM`, `NODE_ENV`) + o que o Project autorizar explicitamente. Nunca denylist. |

---

## 3. Marcos

> **Ordem de execução revisada (ADR 0003, pós-M1):** M0 ✅ → M1 ✅ → M3 ✅ → M2 ✅ → M4 ✅ → M5 ✅ → M6 ✅ → M7 ✅ → **M8 (TUI)** → **M9 (interface web)**.
>
> O failover entre providers (M3) passa na frente do DAG multi-task (M2). É o diferencial que nenhum runtime externo de agent teams oferece, e funciona já em cima do graph do M1, que na prática é o `SingleAgentEngine` (ver seção 4.7). O M2 fica congelado até um triage rápido decidir se o `ApoNativeEngine` precisa mesmo da infraestrutura de times própria ou se parte dela pode vir de um runtime externo.
>
> Os números dos marcos não mudaram de propósito: o TECHNICAL_PLAN.md referencia entregas como `M2.3` e `M3.7` em dezenas de lugares, e renumerar só criaria inconsistência.

### M0 — Spikes e fundação (~1 semana)

- Monorepo pnpm reduzido: `domain`, `db` (Postgres + migrations), `harnesses`, `orchestrator`, `cli`, `daemon`. Os demais pacotes da seção 6/34 do PLAN.md só nascem quando houver código real (regra 3 do PLAN.md).
- Spike dos 3 CLIs: rodar headless numa worktree, capturar saída estruturada, simular rate limit, testar cancelamento, **e testar se cada um suporta um modo read-only confiável** (`--permission-mode plan` no Claude Code, `--sandbox read-only` no Codex, equivalente no Gemini).
- Spike de chamada de ferramenta externa a partir do modo headless (MCP ou equivalente) — insumo para decidir o timing da mensageria peer-to-peer (seção 4).
- Postgres via Docker desde o início (o checkpointer do LangGraph precisa dele). **pgvector fica fora por enquanto.**
- Logging estruturado e tabela `events` básica desde já — custo baixo, evita retrabalho.

**Aceite:** `pnpm build && pnpm test` passam. Um script roda os 3 CLIs e grava o resultado, incluindo se o modo read-only de cada um é confiável.

---

### M1 — Fatia vertical mínima (≈ Phases 1 e 2 do PLAN.md)

- `apo run "x"` → daemon → graph `plan → execute → verify → complete` → **dois** harnesses, `ClaudeCodeHarness` e `CodexHarness`, ambos atrás da interface `AgentHarness` → repo real.
- **Decisão (confirmada pelo usuário):** M1 já sai com os dois, não com um só. Isso muda o motivo original da fase — a abstração `AgentHarness` é validada contra 2 implementações reais desde o início, em vez de ser desenhada a partir de um único exemplo e só testada contra o segundo provider no M3. Reduz o risco de a interface carregar vício de um CLI específico.
- Seleção de harness nesta fase é **manual** (`ExecutionPreference.mode = "forced"`, flag `--harness` na CLI), não roteamento automático — isso continua reservado para o `RuleBasedRouter` no M3. O objetivo do M1 não é decidir, é provar que os dois adapters obedecem o mesmo contrato.
- Plano pode ser fixo ou de uma Task só. Objetivo: provar `APO → LangGraph → agente → repo`, com qualquer um dos dois harnesses.
- Persistência de Project, Feature e Task. Restart do daemon mantém tudo.
- **`IntentTriage`** (ver seção 4.3 abaixo): antes de criar Feature, classifica o input em `question`, `bugfix` ou `feature`. Só `bugfix`/`feature` entram no graph completo; `question` é respondida direto, sem Feature/Task/worktree.

**Aceite:** a mesma Feature simples é concluída tanto com `--harness claude-code` quanto com `--harness codex`, provando que nenhum código do orchestrator depende de um provider específico (regra 4 do PLAN.md) fora do próprio adapter. Matar o daemon no meio e reiniciar retoma a execução. Uma pergunta read-only ("o que faz esse módulo?") é respondida sem criar Feature nem Task.

---

### M2 — Worktrees, workers, paralelismo e política de workspace (≈ Phases 3 e 7 do PLAN.md)

> **Em andamento (pós-triage, ADR 0003 aceito).** O triage do M2.0 (`spikes/execution-engines/`) concluiu que nenhum engine externo entra na V1. O que eles oferecem é paralelismo e mensagem dentro de um único provider, e o Antigravity Teamwork custa ~10 min para uma tarefa trivial. Escopo ajustado com o usuário:
> - **Fica:** DAG multi-task com provider por Task, worktree por Task, integração de branches com Task corretiva, artefatos tipados entre Tasks, roles + `PromptBuilder`, `FeatureOverlapCheck`, `WorkspacePolicy`.
> - **Adiado até um caso real:** mailbox entre roles e perguntas bloqueantes (M2.18–M2.21). Os artefatos via DAG cobrem a passagem de informação entre Tasks de providers diferentes.
> - **Entra:** `AntigravityHarness` (`agy -p`, um agente só) como terceiro provider. A conta Google funciona no `agy` e dá acesso a modelos Gemini, que o Gemini CLI tinha recusado.
> - `ProcessSupervisor` mínimo (M2.3) e `buildWorkerEnvironment()` (M2.22) já foram entregues no M3.

- `WorktreeManager`, `WorkerManager`, `ProcessSupervisor`, `TaskAttempt`.
- Planner gera Tasks com dependências; graph faz fan-out/fan-in via `Send`.
- Limites `maxGlobalWorkers` e `maxWorkersPerProvider`.
- **`WorkspacePolicy`** (ver seção 4.1 abaixo): decide `shared` vs `isolated` por Task, aplicada pelo orchestrator antes de o worker existir.
- **Artefatos tipados entre Tasks**: o resultado de uma Task pode incluir artefatos estruturados (ex: contrato de API) que são entregues à Task dependente via DAG, reduzindo a necessidade de pergunta ao vivo entre workers.
- **Integração de branches**: merge sequencial em branch de feature, com Task corretiva para conflito.
- **`FeatureOverlapCheck`** (ver seção 4.4 abaixo): antes de criar uma Feature nova, verifica se ela colide com uma Feature já ativa no Project. Sem colisão, segue isolada; com colisão, **pergunta ao usuário** — nunca absorve automaticamente (ver revisão na seção 4.4).
- **Roles com prompt injetável** (ver seção 4.5 abaixo): o planner atribui um `role` a cada Task; o `WorkerManager` injeta o `systemPrompt` desse role no prompt do worker, antes do contrato padrão e do conteúdo da Task.
- ~~**Mailbox entre roles**~~ — **adiado** (triage M2.0). O desenho da seção 4.2 continua válido para quando um caso real pedir.
- **`buildWorkerEnvironment()`**: o `ProcessSupervisor` passa ao worker só uma allowlist de variáveis (`HOME`, `PATH`, `SHELL`, `TERM`, `NODE_ENV` + autorizadas pelo Project) — nunca o environment completo do daemon. Segredos do daemon (Postgres, Jev, GitHub) ficam invisíveis ao worker.

**Aceite:** 3 Tasks em paralelo, sem compartilhar working tree, integradas numa branch. Uma Task read-only roda em modo `shared` sem criar worktree; qualquer Task que escreve recebe worktree isolada. Duas Features **sem** overlap rodam ao mesmo tempo, cada uma com worktree e branch de integração próprias, sem colisão. Uma segunda solicitação que colide com uma Feature em andamento gera uma pergunta ao usuário, nunca é absorvida sem confirmação. Uma Task com `role: frontend-developer` recebe, no prompt do worker, o `systemPrompt` configurado para esse role — verificável no log do attempt. Uma Task dependente recebe os artefatos da Task de que depende. Uma Task pode rodar no Gemini via `AntigravityHarness`. O processo do worker não enxerga nenhuma credencial do daemon.

---

### M3 — Multi-provider e failover (≈ Phases 4, 5 e 8 — a parte mais valiosa)

> ✅ **Concluído.** Failover real observado: Codex sem quota → handover → Claude Code concluiu, sem intervenção humana. Detalhes no gate do M3 do TECHNICAL_PLAN.md. **Próximo:** M2, começando pelo triage de engines externos (M2.0).
>
> **Roda antes do M2 (ADR 0003)**, em cima do `SingleAgentEngine` do M1, com uma Task por Feature. Ajustes por causa disso:
> - **Entra:** `ProcessSupervisor` mínimo (M2.3: process group, timeout, kill da árvore) e `buildWorkerEnvironment()` (M2.22), puxados do M2. O failover troca o processo do worker; sem isso, ele roda sem allowlist de environment.
> - **Sai, e vai para depois do M2:** PO/CTO no `team.yaml` e `questionPolicy`. Os dois dependem do `RoleRegistry` e das perguntas bloqueantes do M2.
> - **Gemini:** o `GeminiCliHarness` segue bloqueado na autenticação (`spikes/gemini.md`). O failover é validado entre Claude Code e Codex. O Gemini entra quando a autenticação for resolvida, sem bloquear o marco.
> - **Evidência a favor da prioridade:** durante a validação do M1, o Codex bateu no limite de uso no meio de uma Feature real. É exatamente o cenário que este marco resolve.

- Terceiro adapter, `GeminiCliHarness` — `ClaudeCodeHarness` e `CodexHarness` já vêm validados do M1. Testes de contrato nos três: execute, cancel, timeout, falha, resultado estruturado.
- Detecção reativa de quota/rate limit via `CapacityCollector` **dentro de cada harness** (`packages/harnesses/<provider>/`, nunca em `packages/routing`), `ProviderCapacitySnapshot` com `unknown` como padrão, `apo providers`.
- `TaskHandover`, reroute automático, `RuleBasedRouter` (capacity-aware, regra 80% vs 40% da seção 18).
- `ExecutionPreference` com `auto`, `preferred`, `forced` (seção 14.1).
- A política de workspace é estendida ao reroute: worktree e branch são preservados na troca de worker.
- **PO e CTO ficam configuráveis** no `team.yaml` (ver seção 4.6 abaixo): `questionPolicy` por role decide se uma pergunta bloqueante (seção 4.2) é resolvida pelo Lead, pelo PO, pelo CTO ou escalada ao humano.

**Aceite:** simular rate limit no meio de uma Task. Handover é gerado e outro provider conclui, sem intervenção humana. (O critério de `questionPolicy` foi para depois do M2, junto com a entrega correspondente.)

---

### M4 — Quality gates, review, mudança de plano e entrega (≈ Phases 10 e 11)

- Gates configuráveis por Project (build, lint, typecheck, tests) e Completion Contract (seção 26).
- Reviewer com findings estruturados, Tasks corretivas, `maxFixIterations` → `needs_human`.
- **`planChangeRequests`** no resultado do worker (ver seção 4.2): pedido estruturado de mudança de plano, avaliado pelo Lead, que decide criar ou não uma nova Task.
- **Tabela `agent_messages`** persistida, para auditoria e consulta pelo Lead (sem canal ao vivo ainda).
- `interrupt` do LangGraph para aprovação humana, `apo approve` / `apo reject`, criação de PR via `gh`.

**Aceite:** o cenário completo da seção 38 do PLAN.md roda de ponta a ponta, **sem Jev e sem memória**.

---

### M5 — Jev + memória (≈ Phases 6 e 9)

> ⚠️ **Antes de começar esta fase:** pedir ao usuário o endpoint do Jev e configurar a API key. Acesso já existe (confirmado), só falta a credencial no momento de implementar.

- `JevTaskRouter` atrás da interface `TaskRouter` já existente, com `RoutingAudit`; política determinística valida a decisão do Jev.
- pgvector, `EmbeddingProvider` local, ingestão seletiva (README, AGENTS.md, CLAUDE.md, ADRs — seção 22), retrieval antes do planning e antes de cada Task.

**Aceite:** casos de teste de routing da Phase 6 do PLAN.md passam; memória melhora o plano de forma observável.

---

### M6 — Lead conversacional e homelab (≈ Phases 12 e 13)

- `apo chat` com contexto persistente por Project.
- systemd, health endpoint, recovery no boot, cleanup de worktrees órfãs, acesso via Tailscale.
- **Se os dados do M4/M5 justificarem**, mensageria peer-to-peer ao vivo (ver seção 4.3).

**Aceite:** reiniciar a VM no meio de uma execução; a Feature é retomável.

---

### M7 — Perguntas ao humano (~1 semana) ✅

Quando um worker precisa de uma decisão que não é dele (produto, UX, pedido ambíguo), ele pergunta — e a pergunta chega a você, com opções e a recomendação do worker. Você responde, ou diz "decida você" e o Lead decide registrando o motivo. Absorve as perguntas bloqueantes adiadas do M2 (M2.19–M2.21).

- O worker encerra o turno com a pergunta; a Task espera (`awaiting_answer`) e o resto da Feature segue. A resposta retoma a mesma sessão do agente.
- Modos: `ask_human` (padrão), `lead_first` (o Lead tenta antes) e `auto` (o Lead sempre decide). **Interruptor de "noite toda":** `apo questions auto on|off`, ou por Feature (`apo run --auto-resolve`), ou por Project (`.apo/project.yaml`) — liga e desliga sem commit.
- Com `auto`, nada para por pergunta, mas o PR continua esperando sua aprovação; de manhã, o report e o PR listam as decisões tomadas pelo Lead.
- Decisões viram memória do Project, para a mesma dúvida não voltar.

**Aceite:** uma pergunta real chega ao chat/painel, é respondida e o worker retoma usando a resposta; "decida você" e o modo `auto` levam a Feature até "Abrir o PR?" com as decisões registradas.

---

### M8 — TUI (~1 a 1,5 semana)

Interface de terminal completa, evolução do `apo watch` (Phase 14 do PLAN.md). Hoje a visão é só leitura e as ações são comandos soltos; a TUI junta as duas coisas numa tela navegável por teclado.

- Colunas Projects → Features → Tasks, painel de providers (capacidade, workers ativos, reset) e fluxo de eventos.
- Agente da Task selecionada ao vivo (o mesmo stream do `apo task tail`).
- Ações na própria tela: nova Feature/bugfix, aprovar, rejeitar com motivo, cancelar, pausar/retomar, reroute, preferência; chat com o Lead num painel.
- Funciona local e remoto (`APO_URL`, Tailscale) e por SSH.
- **Regra:** consome as mesmas APIs/eventos da CLI; nenhuma regra de negócio nova. Ações destrutivas (aprovar, rejeitar, cancelar) pedem confirmação.

**Aceite:** uma Feature é criada, acompanhada (incluindo o agente ao vivo) e aprovada só pela TUI, do Mac e por SSH na VM.

---

### M9 — Interface web (~2 a 3 semanas)

A mesma operação da TUI no navegador, servida pelo próprio daemon e acessível só pelo Tailscale — inclusive do celular. O ganho principal é aprovar e acompanhar longe do terminal.

- SPA servida pelo daemon no listener do Tailscale (nunca na internet).
- Login com o token do APO trocado por uma sessão em cookie `HttpOnly`/`SameSite=Strict`; o token nunca fica em URL nem em `localStorage`.
- Telas: Projects, Features, detalhe da Feature (DAG de Tasks, gates por iteração, findings do review, requisitos, resumo de entrega, diff da integração, link do PR), agente ao vivo, providers/saúde, memória, chat com o Lead.
- Ações: as mesmas da TUI, com confirmação nas destrutivas.
- Mobile-first. Notificação quando uma Feature chega a "pronta para PR" (web push) é condicional, se o uso pedir.

**Aceite:** pelo celular, uma Feature é criada, ajustada, revisada (gates, findings, diff) e aprovada até o PR, sem abrir terminal; nada acessível fora do Tailscale.

---

## 4. Adendos arquiteturais

### 4.1 Política de workspace (`WorkspacePolicy`)

Workers não devem sempre executar em worktrees isoladas. A decisão é do orchestrator, nunca do worker:

```text
Task
 ↓
WorkspacePolicy
 ↓
WorktreeManager
 ↓
workspace preparado
 ↓
Worker
```

```ts
type WorkspaceMode =
  | "shared"
  | "isolated"
  | "auto";
```

Regra adotada (mais restritiva que a proposta original, para eliminar uma corrida):

- **Toda Task que escreve código usa worktree isolada.** Não existe "escrita simples sem concorrência" em modo `shared` — se a Task A começa sozinha no workspace principal e a Task B fica `READY` em seguida, A já sujou a working tree antes de qualquer verificação de concorrência rodar. Eliminar essa classe pela raiz é mais simples do que detectar a corrida.
- **`shared` é exclusivo para Tasks read-only** (análise, planejamento, pesquisa, review) — e precisa ser read-only de fato, não apenas por convenção. O adapter aplica a restrição no nível do CLI (flag de modo read-only, validada no spike do M0). Se o CLI não suportar isso de forma confiável, a Task recebe worktree mesmo sendo leitura.

  **Decisão registrada (spike M0.9/M0.10, `spikes/claude-code.md` §3, `spikes/codex.md` §3): `shared` é permitido para Claude Code (`--permission-mode plan`) e Codex (`-s read-only`)** — os dois bloquearam escrita de fato em teste real, não só por documentação da flag. **Gemini CLI permanece fora de `shared`** até um spike real confirmar (`spikes/gemini.md` — bloqueado na autenticação); até lá, toda Task roteada para Gemini recebe worktree isolada mesmo sendo read-only, por aplicação direta desta mesma regra ("se o CLI não suportar isso de forma confiável, a Task recebe worktree mesmo sendo leitura").
- **Tasks de alto risco recebem worktree isolada** mesmo sendo as únicas em execução, por decisão de política do Project.
- **O workspace principal nunca é usado por um worker.** É o working tree do próprio desenvolvedor; usá-lo para qualquer escrita de agente conflita com o trabalho humano em andamento.
- **Leitura em `shared` deve apontar para a worktree de integração**, não para `main`, quando o objetivo é review ou quality gates — senão o agente lê um snapshot desatualizado.

Isso mantém Git e isolamento como responsabilidade determinística de infraestrutura (regra 10 do PLAN.md), e o agente recebe apenas um diretório pronto.

---

### 4.2 Comunicação entre agentes

Agentes devem poder trocar informação, mas sem virar chat livre que crie trabalho informal fora de `Project → Feature → Task`. A regra central continua:

> Agentes podem trocar informação diretamente, mas mudanças no plano de trabalho continuam sendo controladas pelo orchestrator.

**Revisão desta seção.** A primeira versão deste adendo adiava toda mensageria real para pós-V1 (M6, condicional). Isso foi revisto — `packages/messaging/` chega já no **M2** — mas não como canal ao vivo. A distinção que resolve o problema de viabilidade original (workers são CLIs headless e efêmeros: não há inbox, o destinatário pode não estar rodando, sandbox de CLI pode bloquear sockets) é **para quem a mensagem vai**:

```text
destinatário é uma role dinâmica (frontend-developer, backend-developer, qa-engineer…)
 → SEMPRE assíncrono. Quem envia nunca bloqueia.
   Fica na AgentInbox e é entregue no prompt do PRÓXIMO worker
   que nascer com aquela role/Task — o mesmo mecanismo que já
   injeta artefatos tipados (M2.9).
   "Reviewer → feedback → Developer" é exatamente isso: o
   reviewer termina, a Task corretiva nasce e já lê o feedback.

destinatário é um agente persistente (lead/product-owner/cto, seção 4.6)
 → PODE bloquear quem envia, porque esse destinatário está
   sempre disponível por construção — é invocado on-demand via
   AgentRunner, não precisa estar "rodando" para responder.
   A Task pausa, o agente persistente responde, uma nova
   attempt retoma com a resposta no contexto.
```

Isso resolve os dois exemplos centrais sem precisar de canal ao vivo nem do spike M0.12 como bloqueante:

- **"Frontend pergunta a Backend"** → mensagem assíncrona, entregue na próxima Task de backend. A frontend não trava.
- **"QA pergunta ao PO o que a feature engloba"** → pergunta bloqueante ao agente persistente PO, porque PO está sempre disponível (seção 4.6).

**Mecanismo, sem infraestrutura de comunicação ao vivo:**

```text
Worker, no meio da Task, sem informação suficiente
 ↓
escreve a pergunta no WorkerReport (outgoingMessages / blockedQuestion),
commita o trabalho parcial, e PARA — isso é só uma instrução no
PromptBuilder (seção 6.7 do TECHNICAL_PLAN), nenhum canal novo
 ↓
WorkerManager lê o WorkerReport ao final do attempt
 ↓
destinatário = role dinâmica          destinatário = agente persistente
 ↓                                     ↓
AgentInbox (fila), entregue no        Task → awaiting_answer
próximo worker daquela role            ↓
                                       AgentRunner(persona) responde,
                                       usando requirements + artefatos +
                                       (M5+) memória
                                        ↓
                                       política do role manda escalar,
                                       ou confiança baixa → needs_human
                                        ↓
                                       resposta persistida em agent_messages
                                        ↓
                                       nova attempt, resume (nativo se o
                                       harness suportar, senão fresh
                                       execute com a resposta no contexto)
```

O canal verdadeiramente ao vivo — pedir resposta síncrona de um worker que está rodando *agora*, sem esperar ele terminar — continua fora da V1, só construído se a combinação de mailbox + pergunta bloqueante ao agente persistente deixar lacuna real em uso.

**Spike M0.12 (executado, `spikes/mcp-headless.md`): é tecnicamente viável, mas não uniforme entre harnesses.** Um worker headless consegue chamar uma ferramenta MCP local síncrona e esperar a resposta de verdade (testado com um delay artificial de 8s, sem timeout implícito) — mas:

- **Claude Code:** caminho limpo. Basta listar a ferramenta em `--allowedTools`, sem abrir mão de nenhum outro controle de sandbox/permissão da Task.
- **Codex:** caminho caro. A chamada MCP só é aprovada abrindo mão de quase todo o sandbox da Task (`-s danger-full-access` ou o bypass equivalente) — não existe hoje uma forma de confiar num servidor MCP específico sem destravar a Task inteira. E mais grave: quando a chamada falha por aprovação negada, **o agente respondeu "feito" mesmo sem a ferramenta ter sido chamada** — um falso-positivo só detectável porque o spike tinha um log externo independente confirmando a não-chamada. Isso é exatamente o motivo pelo qual a regra 8 do PLAN.md e a seção 6.3 do TECHNICAL_PLAN já dizem que o `WorkerReport` nunca decide sozinho que uma Task concluiu — o spike confirma essa regra com um caso real, não só por precaução.

Isso reforça, com dados reais, a decisão de manter esse canal como condicional (M6.10): mesmo que seja construído, teria que ser **por-harness** — oferecido quando o harness permitir de forma segura (Claude Code hoje), negado ou degradado para mailbox quando não (Codex hoje, a menos que o usuário aceite o trade-off de segurança numa Task específica). Nunca uma capacidade uniforme do `AgentHarness`.

**Tipos de mensagem:**

```ts
type AgentMessageType =
  | "information"         // M2 — mailbox, fire-and-forget
  | "question"             // M2 — mailbox (role dinâmica) ou bloqueante (agente persistente)
  | "plan_change_request"  // M4 — avaliado pelo Lead, pode criar Task
  | "handoff"               // já existe via TaskHandover (seção 20 do PLAN.md)
  | "review_feedback";      // já existe via ReviewFinding (seção 25 do PLAN.md)
```

`handoff` e `review_feedback` continuam sem canal próprio — já têm estrutura (`TaskHandover`, `ReviewFinding`). `plan_change_request` é o caso "preciso que trabalho novo seja feito" (antes cogitado como `work_request`): sempre avaliado pelo Lead, nunca peer-to-peer.

O pacote `packages/messaging/` (`MessageBus`, `MessageRepository`, `AgentInbox`) e a tabela `agent_messages` nascem no **M2** (tipos `information`/`question`); `plan_change_request` chega no M4, quando o loop de correção e a avaliação de impacto pelo Lead já existem.

**É uma fila, mas não uma tecnologia de fila.** A mailbox é persistida em Postgres (sobrevive a crash do daemon de graça) e atrás de uma interface (`MessageBus`/`AgentInbox`) — não há motivo para Redis/RabbitMQ/BullMQ aqui, seria desproporcional ao volume real (regra 12 do PLAN.md). O que precisava ser explícito, e não estava: entrega é **broadcast por (Feature, role)**, não consumo único — duas Tasks da mesma role veem a mesma mensagem; a ordem é FIFO; há um teto de mensagens injetadas por prompt; e uma mensagem nunca lida até o fim da Feature gera evento (`messages.undelivered`) em vez de desaparecer em silêncio. Detalhamento completo em `TECHNICAL_PLAN.md`, seção 6.9.

---

### 4.3 Triagem de intenção (`IntentTriage`)

O pipeline `Project → Feature → Task → Worktree → Worker → Quality Gates → Review → PR` foi desenhado para **mudanças de código**. Ele cobre bem o espectro de bug pequeno até feature grande — a diferença entre os dois é só o tamanho do DAG e o template de workflow (seção 21 do PLAN.md), não a arquitetura. Mas nem toda solicitação ao sistema é uma mudança.

Perguntas genéricas sobre o repo ("o que faz esse módulo?", "por que esse endpoint retorna 404?", "qual foi a decisão de routing da última Task?") são leitura, não mudança. Forçá-las pelo graph completo — criar Feature, Task, worktree, rodar quality gates, esperar aprovação de PR — é desproporcional e distorce o uso real do `apo chat` (seção 7) e do `apo run`.

A correção é um passo de triagem **antes** de `understand_feature`, que classifica o input:

```text
input do usuário
 ↓
IntentTriage
 ↓
┌──────────────┬───────────────────┬───────────────────┐
│   question    │      bugfix        │      feature       │
│  (read-only)  │  (change request)  │  (change request)  │
└──────────────┴───────────────────┴───────────────────┘
       ↓                  ↓                    ↓
   responde           Feature pipeline    Feature pipeline
   direto,             (1 Task, template   (N Tasks, DAG
   sem Feature         Bugfix, gates e      completo, gates
                        PR approval)         e PR approval)
```

- **`question`**: o Lead responde usando leitura do repo e memória — o modo `shared` da `WorkspacePolicy` (seção 4.1) já serve para isso. **Não cria Feature nem Task.** Para manter rastreabilidade sem o aparato completo, a resposta gera um evento leve (`query.answered`) na tabela `events` já prevista desde o M0 (seção 30 do PLAN.md), com o input, um resumo da resposta e os arquivos consultados — suficiente para auditoria futura, sem o custo de persistir Feature/Task/worktree para algo que não alterou nada.
- **`bugfix` / `feature`**: entram no pipeline normal. A diferença entre os dois é o template de workflow e o tamanho esperado do DAG, não a arquitetura de execução.

A classificação pode começar simples: regra determinística sobre o verbo do input ("crie", "corrija", "adicione" → change request; "o que", "por que", "como", "qual" → question), evoluindo para um classificador via Jev depois do M5, se necessário. Não é um componente novo de infraestrutura — é uma função de decisão antes da entrada no graph.

Isso mantém o princípio da regra 10 do PLAN.md (processos determinísticos para decisões estruturais) e evita que o critério de sucesso da V1 (seção 38) seja testado com ruído de perguntas triviais passando pelo pipeline inteiro.

---

### 4.4 Dependência entre Features (`FeatureOverlapCheck`)

O PLAN.md resolve dependência **dentro** de uma Feature (Task A depende de Task B, seção 11). Ele não cobre dependência **entre** Features: se o usuário pede "crie a feature de checkout" enquanto "a feature de catálogo de produtos" ainda está em execução, e as duas tocam os mesmos módulos, nada detecta isso hoje. Cada Feature ganharia sua própria worktree e branch de integração (seção 3 deste roadmap) e colidiria na hora do merge — ou pior, duplicaria trabalho sem nunca colidir visivelmente.

A correção é um passo de verificação **antes** de criar a Feature nova, que decide entre isolar e absorver:

```text
novo objetivo (já classificado como bugfix/feature pelo IntentTriage)
 ↓
FeatureOverlapCheck
 ↓
consulta Features ativas do mesmo Project
(status em planning, executing, integrating, validating, reviewing, fixing)
 ↓
compara expectedPaths de cada Feature ativa contra o objetivo novo
(mesmo campo que o planner, M2.5, já produz — ver TECHNICAL_PLAN.md 6.6)
 ↓
┌───────────────┬────────────────────────────────────────────┐
│  sem overlap   │              overlap detectado               │
└───────────────┴────────────────────────────────────────────┘
       ↓                   ↓
  Feature nova,      pergunta ao usuário (CLI ou apo chat)
  isolada, com        — nunca decide sozinho
  worktree e                  ↓
  branch próprias      ┌──────┴──────┐
                        ↓             ↓
                    "isolar"      "absorver"
```

**Revisão: removido o auto-absorb.** A primeira versão decidia `absorbed` automaticamente quando a camada semântica tinha confiança alta. Isso é arriscado demais para o sinal que se tem: dois arquivos (`src/routes.ts`, por exemplo) podem colidir no path sem ter nenhuma relação semântica real, e absorver errado é caro de desfazer — mistura a proveniência dos requisitos entre Features, e "qual Feature pediu o quê" fica confuso. Perguntar custa uma confirmação rápida; absorver errado custa reconstruir a separação depois. Com essa assimetria, a V1 sempre pergunta quando há overlap — **"absorver" só acontece por escolha humana**, nunca automaticamente. Também cogitei uma terceira opção, duas Features com identidade própria compartilhando a mesma branch de integração, mas isso duplica quality gates, review e completion contract para o mesmo código, e cria ambiguidade sobre qual Feature é dona do merge e do PR — complexidade sem benefício claro na V1.

- **Sem overlap:** segue o fluxo normal do M2 — Feature isolada, worktree e branch próprias.
- **Overlap detectado → pergunta ao usuário.** Síncrono, antes de qualquer Feature existir, sem precisar de `interrupt()` do LangGraph (esse mecanismo só é necessário em aprovação de PR, seção 27 do PLAN.md, porque ali já há um graph em execução; aqui o graph nem começou).
  - **"Isolar"**: segue como se não houvesse overlap.
  - **"Absorver"**: não cria uma Feature nova. O objetivo novo entra como Task(s) adicionais no DAG da Feature já ativa (`tasks.origin = "overlap_absorbed"`), reaproveitando o **mesmo mecanismo que já precisa existir para anexar Tasks a uma Feature em execução** — usado pela primeira vez em Tasks corretivas de conflito de merge (M2.8), e depois reusado por Tasks corretivas de quality gate/review (M4) e por mudanças de requisito via chat (M6.4). Gera o evento `feature.request_absorbed`, com o objetivo original preservado para auditoria.

A detecção em si começa simples (interseção de `expectedPaths` previstos) porque uma detecção imperfeita tem rede de segurança: o merge na branch de integração (M2.7) detecta a colisão real de qualquer forma, mesmo que o `FeatureOverlapCheck` nem chegue a perguntar (ver risco correspondente na seção 2).

---

### 4.5 Roles com prompt injetável

Isto **não** é uma reversão da seção 4 do PLAN.md ("Não criar conceitos fixos como FrontendAgent, BackendAgent"). É outra coisa: o worker continua nascendo por Task e morrendo ao final (seção 4 do PLAN.md); o que passa a existir é um **registro de configuração** — identidade e instruções conhecidas — que é injetado no prompt de qualquer worker efêmero cuja Task carregue aquele `role`. Não há processo, memória ou identidade persistente por role. A diferença para o que a seção 39 do PLAN.md proíbe:

```text
proibido:  Role = Agente fixo (processo, identidade, memória própria)
isto aqui: Role = dado de configuração (systemPrompt + preferência de execução)
           injetado num worker efêmero no momento em que ele nasce
```

Um `role` já era previsto implicitamente pela hierarquia da seção 14.1 do PLAN.md (`Role preference` no `project.yaml`, usada pelo `ExecutionTargetResolver`). A extensão é dar ao `role` um segundo uso: além de influenciar a escolha de provider/modelo, ele carrega um `systemPrompt` que entra na montagem do prompt do worker.

```text
Role (configuração, não agente)
 ├─ systemPrompt         → identidade/expertise injetada no prompt do worker
 └─ executionPreference  → já existia (seção 14.1 do PLAN.md)
       ↓
  Task (recebe um role do planner)
       ↓
  Worker efêmero (nasce, recebe o prompt montado, executa, morre)
```

Roles vivem em `<repo>/.apo/roles/*.yaml`, um arquivo por role, com fallback para um conjunto de defaults embutidos no próprio APO (`frontend-developer`, `backend-developer`, `qa-engineer`, `reviewer`, `generic`). Um arquivo do Project com o mesmo id **substitui** o default embutido por inteiro — não há merge parcial, para manter a resolução previsível.

Se o planner atribuir um `role` que não existe em nenhum dos dois conjuntos, a Task cai no role `generic` (sem `systemPrompt` próprio, só o contrato padrão do worker) e um evento de aviso é emitido — nunca falha a Feature por isso (regra 6 do PLAN.md: o sistema continua funcionando mesmo com dado incompleto).

O detalhamento do schema, da ordem de montagem do prompt e de como isso se encaixa no `WorkerManager` está no `TECHNICAL_PLAN.md`, seção 6.7.

---

### 4.6 Agentes persistentes do Project (Lead, PO, CTO)

A seção 4 do PLAN.md já previa um agente persistente — o Lead. A extensão (proposta pelo usuário, confirmada após discussão sobre se workers deveriam ser persistentes) é generalizar isso para um pequeno conjunto fixo de agentes persistentes **consultivos**, não só o Lead:

```text
team.yaml (por Project):

  lead:
    role: lead
    lifecycle: persistent

  product-owner:
    role: product-owner
    lifecycle: persistent

  cto:
    role: cto
    lifecycle: persistent

  frontend:
    role: frontend-developer
    lifecycle: dynamic    # continua efêmero — ver decisão abaixo

  backend:
    role: backend-developer
    lifecycle: dynamic

  qa:
    role: qa-engineer
    lifecycle: dynamic

  reviewer:
    role: reviewer
    lifecycle: dynamic
```

"Persistente" aqui **não significa processo sempre ligado** — nenhum dos CLIs que automatizamos tem esse modo. Significa identidade, `systemPrompt`, memória e thread de conversa persistentes, invocados on-demand via `AgentRunner` (generalização do que seria `LeadRunner`, seção 6.8 do `TECHNICAL_PLAN.md`) sempre que alguém precisa de um julgamento daquela persona.

**Regra de autoridade — só o Lead muta estado.** PO e CTO são consultivos: o Lead pode invocar o `AgentRunner` com a persona `product-owner` ou `cto` para obter um julgamento (escopo da feature, decisão de arquitetura), mas quem efetivamente cria Task, muda requisito, aprova routing ou decide replanning continua sendo sempre o Lead. Sem essa regra, "quem pode mudar o plano" (a regra central da seção 4.2) fica ambígua entre três agentes em vez de um.

#### Por que workers de execução continuam efêmeros

Consideramos — e descartamos — tornar frontend/backend/QA/reviewer também persistentes (uma "conversa" por role, continuada via `--resume` entre Tasks). Os motivos para manter esses efêmeros:

1. **Paralelismo e "um agente por role" são incompatíveis.** Uma conversa é inerentemente serial. Se duas Tasks de frontend ficam `READY` ao mesmo tempo (comportamento normal do M2), uma role persistente força serializar (perde o paralelismo) ou criar segunda instância — e nesse momento já é um worker efêmero de novo.
2. **Trocar de provider numa conversa persistente não é mais simples — é o mesmo handover, só mais arriscado.** Uma sessão do Claude Code não migra para o Codex. Continuar em outro provider exige reconstruir o essencial da conversa como contexto novo — exatamente o `TaskHandover` que já existe (seção 4.2/6.4 do `TECHNICAL_PLAN.md`), só aplicado a uma conversa inteira em vez de uma Task. Com worker efêmero, a troca de provider é o comportamento padrão do sistema, não uma situação especial a tratar.
3. **Conversa que cresce para sempre tem custo e teto de contexto.** Resolvido de forma mais limpa pela Project Memory (M5) — continuidade de conhecimento recuperada por busca, em vez de uma sessão opaca que só cresce e eventualmente precisa ser resumida de qualquer forma.

A continuidade que motivou a pergunta — sensação de "time que se lembra e se comunica" — vem de três peças que já estavam no plano, entregando **continuidade de conhecimento, não de processo**:

```text
Role.systemPrompt (M2)   → identidade e convenções, repetidas a cada worker novo
Project Memory (M5)      → decisões e padrões passados, recuperados por busca
AgentInbox/mailbox (M2)  → comunicação real entre roles, assíncrona e auditável
```

**Otimização aceita, com uma restrição rígida:** dentro de uma mesma Feature, se duas Tasks da mesma role são sequenciais (não concorrentes) e o provider ainda está saudável, o `WorkerManager` pode preferir `resume(sessionId)` do mesmo harness (interface já definida no M1) em vez de começar do zero — reduz custo de re-estabelecer contexto, sem os três problemas acima. A restrição: **isso nunca pode bloquear paralelismo.** Se duas Tasks da mesma role ficam `READY` ao mesmo tempo, cada uma recebe sua própria execução, nunca esperam uma pela outra para preservar uma conversa única.

#### Diagrama consolidado

```text
                        PROJECT
                           │
              ┌────────────┼────────────┐
              │            │            │
          Lead Agent     PO Agent     CTO Agent
          persistent     persistent    persistent
          (muta estado)  (consultivo)  (consultivo)
              │
              └────────────┬────────────┘
                           │
                        Feature
                           │
                     LangGraph
                           │
                        Tasks
              ┌────────────┼─────────────┐
              │            │             │
          frontend       backend       reviewer
           dynamic       dynamic        dynamic
          (worker        (worker        (worker
           efêmero)       efêmero)       efêmero)
              │            │
              └── AgentInbox (mailbox, M2) ──┘
                           │
                 ExecutionPreference
                           │
                ExecutionTargetResolver
                           │
                   ┌───────┴───────┐
                   │               │
               RuleRouter          Jev
                   │               │
                   └───────┬───────┘
                           │
                  Capacity Policy
                           │
               Claude / Codex / Gemini
                           │
                    WorkspacePolicy
                           │
                 shared / worktree
                           │
                        Git
                           │
                    Quality Gates
                           │
                       Review
                           │
                     PR Approval
```

**Onde entra:** `team.yaml` e `AgentRunner` (só a persona `lead`) no **M1**. PO/CTO configuráveis, `questionPolicy` e o roteamento de perguntas bloqueantes por tópico no **M3** — ver seção 4.2 e `TECHNICAL_PLAN.md`, seções 6.8 e 6.9.

---

### 4.7 APO como control plane sobre execution engines (proposto — ADR 0003)

Hoje existem runtimes que já fazem parte do trabalho de "time de agentes": Claude Code Agent Teams, o multi-agente nativo do Codex e plugins de terceiros sobre ele, e o Antigravity Teamwork. Não vale competir com eles sem necessidade. A regra nova:

> **O APO decide o quê executar, onde e sob quais políticas. O engine decide como a execução acontece internamente.**

```text
                         APO — control plane
     Project · Feature · Memória · Políticas · Aprovações
     Capacidade · Jev · Observabilidade · Histórico

                    ExecutionStrategyRouter
          ┌────────────────┼─────────────────────┐
          ▼                ▼                     ▼
   SingleAgentEngine   ApoNativeEngine     Engine externo
   (graph do M1,       (DAG multi-task,    (adiado — só entra
    1 Task, 1 harness)  provider por Task,  se passar no critério
                        failover — M2+M3)   do ADR 0003)
          │                │
      AgentHarness     vários AgentHarness
```

- `AgentHarness` não muda: continua sendo a unidade "um coding agent".
- `SingleAgentEngine` **já existe na prática**: é o graph do M1. Não há código novo para "criar" esse engine.
- O contrato `ExecutionEngine` **só vira código quando existir um segundo engine real.** Uma interface com uma implementação só seria abstração sem uso (regra 3 do PLAN.md).
- **Limitação aceita:** uma Feature entregue a um engine externo perde o failover entre providers do APO, porque não há handover para dentro da caixa-preta de outro runtime. Por isso nenhum engine externo substitui o `ApoNativeEngine` em Features que dependem do failover.
- LangGraph continua para o control plane e para os engines nativos. Um engine externo seria só um node que dispara, acompanha e coleta o resultado, sem replicar a state machine dele.
- Roteamento em dois níveis (engine por Feature, provider por Task) fica preparado conceitualmente. Sem heurística na V1: o engine é sempre o `SingleAgentEngine` até existir outro.

---

## 5. Decisões tomadas

1. **Harnesses do M1: Claude Code e Codex, os dois.** Não escolher um só — ver justificativa e impacto no M1 e M3 acima. Gemini fica para o M3.
2. **Ambiente de desenvolvimento: Mac**, com repos descartáveis até o M4. VM do homelab entra no M6.
3. **Acesso ao Jev: já existe.** Endpoint e API key serão fornecidos pelo usuário quando o M5 começar — ver aviso na seção do M5.
4. **Workers de execução continuam efêmeros.** Considerado e descartado tornar frontend/backend/QA/reviewer persistentes — ver seção 4.6 para a justificativa completa (paralelismo, troca de provider, custo de contexto). Só Lead/PO/CTO são persistentes (identidade+memória+thread, nunca um processo sempre ligado).
5. **APO como control plane, failover antes do DAG** (pós-M1, ADR 0003 ainda "proposto"). Introduzido o conceito de `ExecutionEngine` acima do `AgentHarness` (seção 4.7). Na ordem de execução, o M3 (failover) vem antes do M2 (DAG multi-task). O M2 fica congelado até um triage de 1–2 horas, feito pelo agente, sobre os runtimes externos de agent teams. Considerado e descartado: um "M0.5" com benchmark completo de 4 runtimes × 6 cenários antes de qualquer outro trabalho. O custo era alto, os runtimes são experimentais e mudam rápido, e nenhuma Feature real precisa deles hoje. Nada do M0/M1 foi removido.

---

## 6. Estimativa

M0–M4 (cenário completo da seção 38, sem Jev): **6 a 10 semanas** com um dev e agentes ajudando.
M5 + M6: **+3 a 5 semanas**.

São ordens de grandeza — o M0 deve calibrar o resto.
