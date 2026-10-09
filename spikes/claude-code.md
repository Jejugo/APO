# Spike M0.9 — Claude Code CLI

**Versão testada:** `2.1.295` (nativo, darwin-arm64).
**Protocolo:** seção "Protocolo de spike" do `TECHNICAL_PLAN.md` (M0.9-M0.13).
**Setup:** cópia isolada de `fixtures/sample-repo` em diretório temporário, `git init` + commit baseline. Nenhum teste tocou o repo real do APO nem o fixture original.

Custo real incorrido neste spike: ~US$ 0,55 em chamadas de API (11 execuções reais + 10 execuções do teste de schema).

---

## 1. Execução headless

Comando: `claude -p "<tarefa>" --output-format json --max-budget-usd 0.5 --permission-mode acceptEdits`.

Formato da saída estruturada (`--output-format json`) — um único objeto JSON no stdout, campos relevantes para o `WorkerReport`/harness:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "terminal_reason": "completed",
  "session_id": "<uuid>",
  "result": "<texto final em markdown>",
  "total_cost_usd": 0.2156,
  "duration_ms": 37338,
  "duration_api_ms": 28632,
  "num_turns": 9,
  "usage": { "input_tokens": 16, "output_tokens": 1416, "cache_read_input_tokens": 298699, "...": "..." },
  "permission_denials": [],
  "api_error_status": null
}
```

Tarefa trivial ("função `double`, com teste, commit") levou **9 turnos** e **US$ 0,216** — mais caro do que o esperado para algo trivial, porque a sessão carrega `CLAUDE.md` global do usuário e faz cache de ~35k tokens de contexto (hooks, settings, etc. do ambiente do dev, não do Task). **Implicação para o harness real:** workers devem rodar com `--setting-sources` restrito (ou equivalente) para não herdar `CLAUDE.md`/hooks globais do operador — isso infla custo e pode mudar comportamento de forma não controlada (ver achado de segurança abaixo).

**Achado de segurança/comportamento:** a sessão aplicou o hook `rtk` do `~/.claude/CLAUDE.md` do usuário dentro da Task headless (reescreveu `npm run lint`), e o próprio agente relatou que a saída ficou poluída por isso. Confirma que, sem isolamento explícito de settings, um worker herda toda a configuração pessoal do operador da máquina — não é cosmético, pode mudar o comportamento de comandos dentro da Task de forma imprevisível. **Ação recomendada:** `buildWorkerEnvironment()` (seção 6.3) não é suficiente por si só; o harness de Claude Code também precisa de `--setting-sources` vazio ou `--safe-mode`/flag equivalente para isolar `CLAUDE.md`/hooks do usuário.

## 2. Saída com schema

Comando: `--output-format json --json-schema '<schema>'`, schema `{answer: string, confidence: number}`, 10 execuções.

- **Com `--bare`: 0/10 válidas.** `--bare` exige `ANTHROPIC_API_KEY`/`apiKeyHelper` e ignora OAuth/keychain (documentado na própria `--help`); neste ambiente a auth é via login OAuth, então toda execução falhou com `"Not logged in · Please run /login"`, `is_error: true`, `total_cost_usd: 0`. **Isso é importante:** se o harness real usar `--bare` para isolamento (plausível, já que ele também desliga hooks/plugins/skills), precisa garantir que `ANTHROPIC_API_KEY` esteja no `buildWorkerEnvironment()` — não basta copiar como está hoje.
- **Sem `--bare`, mesma sessão de auth do operador: 10/10 válidas**, JSON sempre parseável e aderente ao schema.

**Confirmação para TECHNICAL_PLAN:** `--json-schema` é confiável (100% de aderência em 10 runs) desde que a auth esteja correta.

## 3. Read-only

Comando: `--permission-mode plan`, pedindo edição explícita de `src/sum.ts`.

- **Arquivo não mudou** (hash idêntico antes/depois). Confirmado.
- Mecanismo real: em modo `plan`, a ferramenta `ExitPlanMode` não está disponível em modo headless/`-p`, então o agente nunca consegue sair do modo de planejamento para executar edições — ele monta o plano e para. Ele escreveu o plano em `~/.claude/plans/<slug>.md` (fora do repo — consistente com o princípio de "operacional fora do repo" do `TECHNICAL_PLAN.md` §6.3, mas é um efeito colateral a documentar: plan mode grava fora do workspace, não nada).
- **Confirma a hipótese da seção 4.1 do ROADMAP:** `--permission-mode plan` é seguro para `WorkspaceMode: shared` (read-only de verdade).

## 4. Escrita restrita ao workspace

Pedido explícito para escrever em `/tmp/fora-do-workspace-claude.txt` (fora do `cwd`), com `--permission-prompts none` (nenhum humano disponível para aprovar).

- **Bloqueado.** Arquivo não foi criado.
- O bloqueio aparece de forma estruturada em `permission_denials` na saída JSON:
  ```json
  "permission_denials": [{"tool_name":"Write","tool_use_id":"...","tool_input":{"file_path":"/tmp/fora-do-workspace-claude.txt","content":"escapou"}}]
  ```
  Isso é diretamente utilizável pelo `TaskHandover`/auditoria — não precisa fazer parsing de texto livre.
- O agente também relatou explicitamente que não tentaria contornar via Bash. Não testamos adversarialmente (ex.: pedir para usar `Bash("cat > /tmp/...")` em vez de `Write`), fica como gap conhecido a confirmar depois se for crítico.

## 5. Rede no modo de escrita

Pedido para rodar `pnpm install` dentro da Task, `--permission-mode acceptEdits`.

- **Rede funcionou sem bloqueio.** O único erro foi `ERR_PNPM_IGNORED_BUILDS` (comportamento normal do pnpm pedindo aprovação interativa para scripts de build, não um bloqueio de rede/sandbox).
- **Confirma:** Claude Code não sandboxa rede por padrão (ao contrário do Codex, ver spike M0.10) — a restrição em `acceptEdits`/`bypassPermissions` é só sobre permissões de ferramenta, não sobre rede.

## 6. Cancelamento (SIGTERM no grupo de processos)

Tarefa longa (ensaio de 2000 palavras) iniciada em background, `SIGTERM` enviado ao `pgid` depois de ~6s.

- **Processo e filhos terminaram limpos.** `ps aux` depois do kill não mostrou nenhum processo residual associado à sessão (`t6`). Claude Code não tem subprocessos sobreviventes conhecidos neste cenário simples (sem MCP servers, sem subagents).
- **Confirma a premissa do `ProcessSupervisor`:** matar o grupo de processos (`kill -TERM -$pgid`) é suficiente, não precisa de lógica adicional de limpeza de órfãos neste caso.

## 7. Erros de quota/rate limit

Não provocado ao vivo (não é possível sob demanda). Dois substitutos testados:

- **Modelo inexistente** (`--model modelo-que-nao-existe-xyz`): erro limpo e estruturado, rápido (<1s).
  ```json
  {"is_error": true, "terminal_reason": "api_error", "api_error_status": 404,
   "result": "There's an issue with the selected model (...). It may not exist or you may not have access to it."}
  ```
  **Bom para o harness:** `is_error: true` + `api_error_status` numérico são checáveis programaticamente.
- **Credencial inválida** (`apiKeyHelper` retornando uma chave falsa): **eventualmente retorna um erro limpo e estruturado, mas muito lento.** Levou **261193 ms (~4,4 minutos)** para retornar:
  ```json
  {"is_error": true, "terminal_reason": "api_error", "api_error_status": 401,
   "result": "Invalid API key · Fix external API key"}
  ```
  No meio do caminho só aparece um aviso em stderr não relacionado ("claude.ai connectors are disabled..."), então por ~4 minutos não há nenhum sinal de que algo está errado — parece apenas uma Task lenta, não uma Task falhando.
  **Achado crítico para o harness:** mesmo chegando a um erro estruturado e checável (`is_error`+`api_error_status`), o tempo até esse erro (4,4 min) é incompatível com qualquer SLA razoável de detecção de falha. **O `ProcessSupervisor` precisa de timeout obrigatório por Task attempt** (já estava implícito no design, mas este spike confirma que é necessário, não só desejável — uma credencial ruim não é distinguível de uma Task normal em andamento sem um timeout).
- Rate-limit real (429) não foi observado neste spike; formato precisa ser capturado oportunisticamente em uso real (como já previsto no protocolo).

## 8. Resume

`--session-id <uuid fixo>` para iniciar, `SIGTERM` no meio de uma tarefa longa, depois `--resume <uuid>`.

- **Funciona.** O `session_id` da resposta do resume é idêntico ao original.
- **Comportamento real, não óbvio:** como a tarefa original foi matada antes de qualquer conteúdo ser persistido (geração em streaming, nada gravado), o resume **não retoma no meio do texto** — ele trata o turno interrompido como se nunca tivesse produzido nada e começa do zero a partir do mesmo prompt de usuário. Ou seja: resume funciona no nível de *sessão/transcript*, não de *turno em andamento*. Isso é consistente com a decisão já tomada no ROADMAP de que o `resume()` é "uma otimização limitada" — na pior hipótese (turno interrompido no meio), o custo de retomar é equivalente a rodar o turno de novo.

## 9. Usage/quota local

- `claude doctor` não expõe uso ou quota (só versão, canal de update, settings geridas).
- Nenhum arquivo em `~/.claude/` com nome relacionado a uso/quota/limite.
- **A única fonte de uso observável é por execução**, no campo `usage`/`total_cost_usd` da própria saída JSON (contabilização por chamada, não um medidor agregado de conta). Para um `CapacityCollector` proativo (seção 16 do PLAN.md), a estratégia tem que ser acumular esses campos por Task attempt no próprio APO — não existe um "medidor de conta" que o APO possa consultar de fora.

---

## Confirmações para TECHNICAL_PLAN §6.2 (linha Claude Code)

| Necessidade | Hipótese original | Confirmado no spike |
|---|---|---|
| Modo headless | `claude -p` | ✅ Confirmado. Usar sempre `--output-format json` junto. |
| Saída estruturada | `--output-format stream-json` | Spike usou `--output-format json` (resultado único) em vez de `stream-json`. Ambos existem; `json` é mais simples para o `WorkerReport` porque não precisa parsear eventos incrementais — recomendo `json` como padrão e `stream-json` só se precisarmos de progresso incremental ao vivo. |
| Read-only | `--permission-mode plan` | ✅ Confirmado — bloqueio real, mecanismo é a ausência da ferramenta `ExitPlanMode` em modo headless. |
| Escrita restrita ao workspace | "permissões + sandbox do Claude Code" (vago) | ✅ Confirmado e preciso agora: `--permission-prompts none` nega automaticamente qualquer escrita fora do `cwd`/`--add-dir`, e a negação aparece estruturada em `permission_denials`. |
| Modo YOLO | `--dangerously-skip-permissions` | Não testado ao vivo neste spike (risco/custo desnecessário para confirmar algo já documentado no `--help`); mantido como hipótese, baixo risco de estar errado. |
| Resume nativo | `--resume <session_id>` | ✅ Confirmado, com a ressalva do item 8 acima (resume de sessão, não de turno). |

### Novo achado não previsto na seção 6.2 (adicionar)

- **Isolamento de settings do operador:** nenhuma linha da tabela original cobria isso. É preciso decidir explicitamente a flag/estratégia para impedir que um worker herde `CLAUDE.md`/hooks/settings pessoais do usuário que roda o daemon (candidatos: `--bare`, `--safe-mode`, ou `--setting-sources` vazio — cada um com trade-offs diferentes de auth, ainda não comparados entre si; **isso fica como item aberto de M0.13/ADR 0002**, não decidido neste spike).
- **Timeout obrigatório por attempt:** confirmado como necessidade dura (não só boa prática) pelo caso de credencial inválida que trava sem erro.
