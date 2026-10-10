# ADR 0003 — APO como control plane sobre execution engines

**Status:** proposto (não aceito). Vira "aceito" ou é revisto quando o triage de engines externos rodar, no início do M2.
**Contexto:** pós-M1. Revisão da premissa de que o APO constrói internamente todo o runtime multi-agente.

## Contexto

O plano original assumia que o APO implementaria sozinho toda a colaboração entre agentes: DAG de Tasks, `WorkerManager`, `MessageBus`/`AgentInbox`, `WorktreeManager` completo. Desde então surgiram runtimes que já fazem parte disso. Uma pesquisa rápida (sem teste empírico) mostrou o seguinte:

| Runtime | O que é | Controle headless |
|---|---|---|
| Claude Code Agent Teams | Feature experimental do próprio Claude Code (flag experimental, v2.1.32+). Lead + teammates em worktrees separadas, comunicação direta entre eles | Não confirmado. `claude -p` é sólido para uma sessão, mas nada documenta que crie e controle um time. "Remote Control" existe, mas não está claro se cobre Agent Teams |
| Multi-agente nativo do Codex | Experimental, habilitado via `/experimental` no Codex CLI | Não confirmado |
| `codex-teams` | **Plugin de terceiro**, não oficial (`GekkoQuest/codex-teams`), que coordena os subagents nativos do Codex via MCP | Não confirmado. Três camadas de risco: flag experimental da OpenAI + plugin de terceiro + manutenção de repo pessoal |
| Antigravity Teamwork (`/teamwork-preview`) | Liberado para planos pagos, alto consumo de tokens | Não confirmado. É um slash command de sessão interativa; o `agy -p` existe, mas nada indica que aceite esse comando |
| AgentScope | Framework Python de multi-agente (Alibaba), com padrões leader-worker no 2.0. Não existe um módulo chamado "AgentTeams" | Não se aplica: é framework, não runtime pronto. Serve só como referência arquitetural |

## Decisão (proposta)

1. **O APO é um control plane.** Princípio: *o APO decide o quê executar, onde e sob quais políticas; o engine decide como a execução acontece internamente.* Ficam com o APO: Project, Feature, memória, políticas, aprovações, capacidade de provider, `ExecutionPreference`, Jev, observabilidade, histórico, auditoria e interação humana.

2. **Nova abstração `ExecutionEngine`, acima do `AgentHarness`.** O `AgentHarness` não muda e continua sendo a unidade "um coding agent". O `ExecutionEngine` é a estratégia que executa uma Feature inteira. Esboço, **a refinar só quando existir um segundo engine real**:

   ```ts
   interface ExecutionEngine {
     id: string;
     getCapabilities(): EngineCapabilities;
     execute(input: EngineExecutionInput): Promise<ExecutionHandle>;
     getStatus(handle: ExecutionHandle): Promise<ExecutionStatus>;
     cancel(handle: ExecutionHandle): Promise<void>;
   }
   ```

   Engines candidatos:

   | Engine | Situação |
   |---|---|
   | `SingleAgentEngine` | **Já existe na prática**: é o graph do M1 (uma Task, um harness, LangGraph + `PostgresSaver`) |
   | `ApoNativeEngine` | DAG multi-task, multi-provider por Task. Era o M2 original. Congelado até o triage |
   | Engines externos | Adiados. Entram só se passarem no critério abaixo |

3. **Roteamento em dois níveis, sem heurística por enquanto.** Primeiro um `ExecutionStrategyRouter` escolhe o engine por Feature. Se o escolhido for o `ApoNativeEngine`, o roteamento por Task (`RuleBasedRouter`/Jev) escolhe o provider de cada Task. Na V1 a escolha de engine é fixa: `SingleAgentEngine`.

4. **Estado externo não é estado do APO.** O APO persiste só a referência, algo como `FeatureExecution { featureId, engineId, status, externalExecutionId?, graphThreadId? }`. `graphThreadId` só existe para engines baseados em LangGraph. Nenhum conceito do domínio (Project, Feature, Task, Execution) depende de um runtime externo: engines externos são adapters.

5. **LangGraph continua**, só que mais restrito: workflows do control plane, `SingleAgentEngine`/`ApoNativeEngine`, interrupts humanos e recovery. Um engine externo vira, no máximo, um node `execute_external_engine` que dispara, acompanha e coleta o resultado. O APO nunca replica a state machine interna de outro runtime.

6. **Nenhuma infraestrutura genérica de time sem evidência.** `MessageBus`, `AgentInbox`, protocolos de colaboração e ciclo de vida de teammates não são construídos até que o triage mostre que o `ApoNativeEngine` precisa deles e que nenhum runtime externo os entrega.

## Critério para um engine externo entrar

Todos os itens abaixo, confirmados empiricamente:

1. Invocável de forma programática/headless.
2. Status observável.
3. Cancelável ou minimamente controlável.
4. Resultado detectável (commits/diff verificáveis pelos gates do APO).
5. Integração razoavelmente determinística.
6. Reduz de forma significativa o código que teríamos de manter.
7. Não compromete os requisitos de segurança (sandbox, environment, credenciais).
8. Não exige infraestrutura desproporcional para um homelab (sem Kubernetes, Matrix, MinIO etc.).

## Consequências

- **Limitação aceita, e importante:** uma Feature delegada a um engine externo **perde o failover entre providers do APO**. Se o provider usado internamente esgotar a quota no meio, o APO não tem como fazer handover para dentro da caixa-preta de outro runtime. É a troca: menos infraestrutura própria por menos controle. Por isso engines externos nunca substituem o `ApoNativeEngine` para Features que dependem desse failover.
- **O failover entre providers vira prioridade.** Ele é o diferencial que nenhum runtime avaliado oferece, e vale qualquer que seja o resultado do triage: funciona no `SingleAgentEngine` de hoje e no `ApoNativeEngine` de amanhã. Por isso o M3 (failover) passa a ser executado **antes** do M2 (DAG multi-task) — ver ROADMAP.md.
- **Nada do M0/M1 é removido.** Auditoria:

  | Item | Classificação |
  |---|---|
  | `packages/harnesses`, `domain`, `config`, `db`, `observability` | KEEP |
  | `packages/orchestrator` (graph do M1) | KEEP, passa a ser reconhecido como `SingleAgentEngine` |
  | `apps/daemon` `FeatureRunner` | ADAPT, quando houver um segundo engine: passa a escolher engine em vez de chamar o graph direto |
  | Schema do banco | ADD (`FeatureExecution` ou colunas equivalentes), quando houver um segundo engine |
  | M2 original (DAG, `WorktreeManager` completo, mensageria) | Congelado no ROADMAP. Não é DEPRECATE: não existe código para remover |

- **O contrato de `ExecutionEngine` não é implementado agora.** Com um engine só, a interface seria abstração sem uso real (regra 3 do PLAN.md). Ela nasce quando o segundo engine (`ApoNativeEngine` ou um externo) for implementado.

## Próximo passo de revisão

Primeiro item do M2: triage de 1–2 horas (feito pelo agente, não pelo usuário) com uma pergunta por candidato: "dá para disparar, acompanhar e cancelar via CLI, sem terminal interativo?". Ordem: Claude Code Agent Teams, multi-agente nativo do Codex (antes do `codex-teams`), Antigravity Teamwork. AgentScope fica só como leitura. Quem falhar sai da lista. Só quem passar recebe o benchmark completo (feature full-stack, comunicação entre agents, alterações paralelas, falha de worker, restart, intervenção humana). Com o resultado, este ADR muda para "aceito" ou é revisto.
