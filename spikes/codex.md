# Spike M0.10 — Codex CLI

**Binário:** `codex` (codex-cli 0.161.0), subcomando `codex exec` para modo headless.
**Alvo:** cópias temporárias de `fixtures/sample-repo`, fora do repo `apo` (scratchpad da sessão).
**Autenticação:** ChatGPT (OAuth), `auth mode: chatgpt`.

## 1. Execução headless

`codex exec "<prompt>" --json -o <arquivo> -s workspace-write --skip-git-repo-check`.

- **Atenção de flag:** `-a/--ask-for-approval` existe no `codex` top-level, mas **não** no subcomando `codex exec` — passar `-a never` quebra com `error: unexpected argument '-a' found`. Em `exec`, a política de aprovação é implícita ao sandbox (não há prompts interativos possíveis em modo headless).
- **`--json` emite um JSONL** no stdout com eventos: `thread.started` (`thread_id`), `turn.started`, `item.started`/`item.completed` (tipos observados: `agent_message`, `command_execution`, `file_change`, `error`), `turn.completed` (inclui `usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`), `turn.failed`.
- **`-o/--output-last-message`** grava só o texto final do agente — é o campo prático para o `WorkerReport.summary`.
- **Achado crítico de ambiente:** mesmo sem `--add-dir` extra, o Codex carrega `~/.codex/config.toml` e `~/.codex/hooks.json` **por padrão**, inclusive hooks do usuário (neste caso, uma regra "sempre prefixe comandos com `rtk`"). O worker literalmente leu `~/.codex/RTK.md` do host e aplicou a convenção `rtk proxy <cmd>` nos comandos que rodou. **Isso é um vetor de poluição de ambiente equivalente ao do `process.env`** (seção 6.3 do TECHNICAL_PLAN) — a flag `--ignore-user-config` neutraliza (impede carregar `config.toml`; a autenticação continua vindo de `CODEX_HOME`). **Recomendação: todo spawn do `ProcessSupervisor` para Codex deve incluir `--ignore-user-config` por padrão**, análogo ao `buildWorkerEnvironment()` já planejado para variáveis de ambiente.
- **Achado de infraestrutura:** `codex exec` roda sobre um **app-server daemon compartilhado e persistente** por máquina (`~/.codex/app-server-daemon/daemon.pid`), iniciado independente de qualquer invocação de Task. Ele não é filho do processo `codex exec` — matar o cliente não afeta o daemon (ver ponto 6).
- **Achado operacional:** se o processo é spawnado sem stdin explicitamente fechado (ex.: herdando um pipe não-TTY que nunca envia EOF), `codex exec` imprime `Reading additional input from stdin...` e **trava indefinidamente** esperando EOF, mesmo com o prompt já passado como argumento. **O `ProcessSupervisor` do APO deve sempre redirecionar stdin de `/dev/null`** ao spawnar Codex (e, por precaução, Claude Code/Gemini também).

## 2. Saída com schema

`--output-schema <arquivo.json>` + `-o <arquivo>`. Schema usado: `{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}`, prompt trivial ("qual é a capital da França?").

**Correção pós-M1.4 (reproduzido manualmente ao implementar o `CodexHarness`): este schema, exatamente como registrado aqui, falha com 400** (`"Invalid schema for response_format 'codex_output_schema': 'schema.additionalProperties' is required to be supplied and to be false when strict is true"`) — testado de novo contra o mesmo binário (`codex-cli 0.161.0`), com e sem `--ignore-user-config`, em `read-only` e `workspace-write`. O `--output-schema` do Codex usa o modo *strict* da OpenAI, que exige `additionalProperties: false` no nível raiz do schema — algo que o Claude Code não exige para o `--json-schema` equivalente. Não há explicação confirmada para o "10/10 válidas" original deste relatório (o schema literal registrado não roda hoje); o resultado anterior não deve ser considerado confiável. **O `CodexHarness` real (`packages/harnesses/src/codex/temp-files.ts`) agora normaliza isso automaticamente** — injeta `additionalProperties: false` em qualquer `outputSchema` de objeto que não o declare, para que o mesmo schema funcione nos dois harnesses sem quem chama `AgentHarness.execute()` precisar saber dessa diferença. Com a normalização, a suíte de contrato real (`packages/harnesses/src/contract.test.ts`, `APO_LIVE_HARNESS_TESTS=1`) confirma sucesso.

## 3. Read-only

`-s read-only`, pedindo explicitamente para editar `src/sum.ts`.

- **Arquivo não mudou** (md5 idêntico antes/depois).
- O próprio agente respondeu: *"O ambiente está em modo somente leitura, então não consegui editar `src/sum.ts`"* — nem tentou um `file_change`/erro de permissão; parece que o modelo já é informado do sandbox e se autocontém, mas o teste 4 (abaixo) mostra que essa autocontenção **não é a única linha de defesa esperada** — então a confiança não deveria se basear só em "o modelo disse que não pode".
- **Confirma a hipótese do TECHNICAL_PLAN:** `-s read-only` é seguro para o modo `shared` do WorkspacePolicy, no que depende de bloquear escrita de arquivo local.

## 4. Escrita restrita — ACHADO CRÍTICO DE SEGURANÇA

Com `-s workspace-write` (sem `--add-dir` extra), pedi para escrever em `../fora-do-workspace.txt` (um nível acima do cwd) e em `/tmp/codex-spike-escape-absoluto.txt` (caminho absoluto).

**Os dois arquivos foram criados com sucesso.** `workspace-write` **não confinou a escrita ao workspace** nestas condições (macOS, Seatbelt) — nem um path relativo escapando do cwd nem um path absoluto totalmente fora foram bloqueados. Isso **contradiz a hipótese da tabela da seção 6.2** do TECHNICAL_PLAN, que assume que `--sandbox workspace-write` sozinho já restringe a escrita.

**Implicação para a arquitetura:** o `WorkspacePolicy` do APO **não pode depender só da flag de sandbox do Codex** para a garantia de isolamento entre Tasks/worktrees. É preciso ou (a) confirmar e documentar exatamente quais diretórios `workspace-write` de fato declara como raiz gravável nesta versão/plataforma (pode ser mais amplo que o cwd — ex.: inclui `$TMPDIR` por padrão, o que explica a escrita em `/tmp`, mas a escrita em `../` sugere que a raiz pode ser o repositório git inteiro, não o cwd), ou (b) tratar a confinamento de escrita como responsabilidade do `ProcessSupervisor`/sistema operacional (ex.: rodar o worker dentro de um container, ou usar `--add-dir` nunca, mais validação pós-execução do `git diff --name-only` contra os `expectedPaths` da Task, rejeitando a Task se algo fora do esperado mudou). **Recomendo a opção (b)** como defesa em profundidade, já que (a) depende de uma garantia do fornecedor que acabou de falhar no teste.

## 5. Rede no modo de escrita

Confirmado exatamente o ponto de atenção do TECHNICAL_PLAN: com `-s workspace-write` puro, `pnpm install` falhou com erro de DNS (`dns error: failed to lookup address information`) — rede bloqueada por padrão.

**Configuração que libera rede mantendo `workspace-write`:** `-c 'sandbox_workspace_write.network_access=true'`. Com essa flag, `pnpm install` baixou os pacotes com sucesso (o erro subsequente, `ERR_PNPM_IGNORED_BUILDS`, é uma política do próprio pnpm sobre scripts de build, não do sandbox do Codex).

**Confirmação para TECHNICAL_PLAN §6.2:** a config correta é `-s workspace-write -c 'sandbox_workspace_write.network_access=true'`, não apenas `--sandbox workspace-write`.

## 6. Cancelamento

Spawnei uma Task mais longa, esperei ~4s, enviei `SIGTERM`/`kill -9` ao PID do `codex exec`.

- O processo `codex exec` morreu limpo — nenhum processo filho remanescente sob seu PID/PGID.
- **O app-server daemon compartilhado (`~/.codex/app-server-daemon`) continuou rodando**, como esperado — ele não é filho do `codex exec` (tem PPID próprio, independente), é um recurso de longa duração por máquina, não por Task. **Isso não é um vazamento de processo por Task** — matar uma Task nunca deveria (e não derruba) o daemon compartilhado; só é preciso que o `ProcessSupervisor` não confunda o PID do daemon com o PID da Task ao decidir o que matar.

## 7. Erros de quota/rate limit (não provocados ao vivo)

Não tentei provocar rate-limit real. Capturei dois formatos de erro substitutos:

- **Modelo inexistente:** evento `turn.failed` com `error.message` contendo um JSON aninhado: `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'modelo-que-nao-existe-xyz' model is not supported when using Codex with a ChatGPT account."}}`.
- **Credencial inválida** (`CODEX_HOME` apontando para diretório sem auth): o cliente **tenta reconectar automaticamicamente 5 vezes** (via WebSocket, depois fallback para HTTPS, mais 5 tentativas) antes de emitir `turn.failed` com `401 Unauthorized`. **Importante para o failover do APO:** isso adiciona ~10-15s de latência antes do erro definitivo aparecer — o `AgentHarness` não deve interpretar "sem resposta ainda" como stall nesse intervalo, mas também precisa de um timeout superior a isso para não esperar indefinidamente em casos piores.
- Erro de quota/rate-limit real não foi provocado; nenhum log antigo com esse formato específico foi encontrado nesta sessão.

## 8. Resume

- `codex exec` imprime `thread_id` em `thread.started` logo no início — é o identificador a persistir em `task_attempts` (ou equivalente) para resume.
- Matei o processo no meio da execução (`kill -9`) e tentei `codex exec resume <thread_id> "<prompt>"`: **funcionou** — o resume localizou a sessão e manteve o contexto da conversa (sabia exatamente o que tinha e não tinha terminado).
- **Pegadinha de flag:** `codex exec resume` **não aceita `-s/--sandbox`** (`error: unexpected argument '-s' found`) — rodar sem overrides herda uma política mais restritiva (no meu teste, veio como read-only, e o agente recusou escrever). **A forma correta de re-conceder escrita no resume é via `-c`:** `-c 'sandbox_mode="workspace-write"'` (e, para rede, `-c 'sandbox_workspace_write.network_access=true'` de novo). Com isso, confirmei que o resume escreveu os dois arquivos pendentes (`notas.ts`, `notas2.ts`) corretamente, incluindo rodar `typecheck`/`biome check` antes de finalizar.
- **Confirmação para TECHNICAL_PLAN §6.2 / seção 2.1 (resume() do AgentRunner):** resume nativo do Codex funciona após kill de processo, mas o `AgentHarness.resume()` do APO precisa reconstruir explicitamente as flags de sandbox/rede via `-c`, não pode confiar em herdar o que a sessão original tinha.

## 9. Usage/quota

- Nenhum comando (`codex doctor`, `codex login status`) expõe quota restante ou uso agregado para contas ChatGPT. `codex login status` só confirma `"Logged in using ChatGPT"`.
- **Achado útil:** cada evento `turn.completed` do `--json` inclui um bloco `usage` por turno: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. **Isso é suficiente para o `CapacityCollector` de Codex construir um acumulador local de consumo por sessão/dia**, mesmo sem um endpoint de quota — basta somar esses campos a cada Task executada. Não há reset/limite exposto diretamente, só consumo.
- `~/.codex/` guarda sessões em `archived_sessions/` e rollout files (`codex doctor` apontou "264 active files · 1.38 GB" de rollouts) — não é quota, é histórico de conversas; relevante só como um lembrete de que o `CODEX_HOME` cresce e pode precisar de rotação/limpeza operacional no futuro, não é bloqueante para M0.

## Confirmações para TECHNICAL_PLAN §6.2 (linha Codex)

| Necessidade | Hipótese original | Confirmado no spike |
|---|---|---|
| Modo headless | `codex exec` | Confirmado. Mas `-a/--ask-for-approval` não existe em `exec` (só no `codex` top-level) |
| Saída estruturada | `--json` | Confirmado, formato JSONL de eventos (`thread.started`, `item.*`, `turn.completed` com `usage`, `turn.failed`). Para resultado final tipado, usar `--output-schema` + `-o` — **mas o schema precisa de `additionalProperties: false` no nível raiz** (modo strict da OpenAI), o que o `--json-schema` do Claude Code não exige; o `CodexHarness` normaliza isso automaticamente (ver seção 2, correção pós-M1.4) |
| Read-only | `--sandbox read-only` | Confirmado — bloqueia escrita de fato |
| Escrita restrita ao workspace | `--sandbox workspace-write` | **Parcialmente refutado** — não bloqueou escrita em `../` nem em `/tmp/...` absoluto. Mitigar com validação pós-execução (`git diff` vs. `expectedPaths`), não confiar só na flag |
| Sem prompts (YOLO) | `--full-auto` / `--ask-for-approval never` | **Nenhuma das duas existe em `codex exec`.** Em `exec`, não há prompts por padrão (headless já é "sem prompts"); o equivalente a YOLO total é `--dangerously-bypass-approvals-and-sandbox` |
| Modelo | `--model` | Confirmado (`-m/--model`) |
| Resume nativo | `codex exec resume <id>` | Confirmado, funciona após kill de processo. Mas não aceita `-s`; sandbox/rede devem ser re-especificados via `-c sandbox_mode="..."` e `-c sandbox_workspace_write.network_access=true` |

## Recomendações de hardening para o `AgentHarness`/`ProcessSupervisor` (Codex)

1. Sempre incluir `--ignore-user-config` (evita herdar hooks/config globais do host, ex.: regras de prefixo de shell).
2. Sempre redirecionar stdin de `/dev/null` ao spawnar (evita hang esperando EOF).
3. Nunca confiar apenas em `-s workspace-write` para isolamento — validar `git diff --name-only` pós-Task contra `expectedPaths` (reaproveita o mecanismo já planejado para `FeatureOverlapCheck`, seção 6.6).
4. Para rede em modo de escrita: `-c 'sandbox_workspace_write.network_access=true'` junto de `-s workspace-write`.
5. No `resume()`, sempre reconstruir as flags de sandbox/rede via `-c` — nunca assumir que o resume herda a política da sessão original.
6. Não confundir o PID do app-server daemon compartilhado com o PID de uma Task — o `ProcessSupervisor` deve rastrear apenas o PID/PGID do processo `codex exec` que ele próprio spawnou.
