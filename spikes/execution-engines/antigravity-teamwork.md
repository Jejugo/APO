# Triage M2.0 — Antigravity Teamwork (`/teamwork-preview`)

**Versão:** `agy` 1.3.2. **Data:** 2026-10-10. Conta Google do usuário (a mesma que o Gemini CLI recusou no M0).
**Pergunta do triage:** dá para disparar, acompanhar e cancelar via CLI, sem terminal interativo?

## Resultado: **passa tecnicamente, mas não compensa na V1**

Cenário: dois workers em paralelo; o "backend" escreve um contrato de uma linha e manda ao "frontend", que escreve um arquivo citando o contrato.

| Critério (ADR 0003) | Resultado | Evidência |
|---|---|---|
| Invocável headless | ✅ confirmado | `agy -p '/teamwork-preview ...'` — o slash command é expandido em modo print (a própria flag `--disable-slash-commands` existe para desligar isso) |
| Espera o time terminar | ✅ confirmado | stderr: `root agent idle; waiting up to 15m0s for 1 background task(s)`; o processo só retorna quando o time acaba |
| Permissões em headless | ⚠️ só com YOLO | com `--mode accept-edits`, o time falhou: a permissão de rodar comandos foi negada automaticamente. Só funcionou com `--dangerously-skip-permissions` (ou allow-rules em settings.json) |
| Paralelismo + mensagem entre agents | ✅ confirmado | dois workers em paralelo, mensagem direta via `send_message` com o id de conversa do outro worker (o orquestrador repassou o id) |
| Status observável | ✅ confirmado | estado completo em arquivos: `.agents/teamwork/<agente>/{BRIEFING,progress,handoff,DISPATCH}.md` e `orchestrator_1/GATE_STATUS.md` (gate PASS/FAIL por worker) |
| Resultado estruturado | ✅ confirmado | `--output-format json`: `conversation_id`, `status`, `duration_seconds`, `usage`, `denied_actions` |
| Cancelável | ❓ não testado | presumivelmente matando o processo `agy -p`. Não verificado se o time em background morre junto |
| Verificação própria | ✅ | orquestrador com gate por iteração (até 32) + `victory_auditor` independente (proveniência, integridade, testes) |
| Isolamento entre workers | ❌ | os dois escreveram no mesmo diretório. Sem worktree por worker |
| Polui o repositório | ❌ | grava `.agents/teamwork/` e `ORIGINAL_REQUEST.md` **dentro** do diretório de trabalho — exigiria gitignore ou limpeza pelo APO |
| Provider flexibility | ⚠️ dentro do Antigravity | modelos Gemini e Claude via conta Google; o APO não faz failover para fora dele |
| Custo / latência | ❌ | **624 s (~10,5 min) e ~205 mil tokens de entrada (+~614 mil de cache)** para dois arquivos de uma linha. O orquestrador sobe sentinel, orquestrador, 2 workers e um auditor mesmo para uma tarefa trivial |

## Achado à parte, mais valioso que o teamwork

`agy -p` funciona com a conta Google do usuário e lista modelos **Gemini** (`gemini-3.8-flash-*`, `gemini-3.1-pro-*`) — exatamente o que o Gemini CLI recusou no M0 (`IneligibleTierError`, "migrate to Antigravity"). Em modo single-agent, `agy -p` tem o que um harness precisa: `--output-format json` com `conversation_id`/`status`/`usage`, `--json-schema`, `--mode plan` (read-only) e `accept-edits`, `--conversation <id>` (resume), `--model`. **Um `AntigravityHarness` destravaria o terceiro provider (Google) do failover**, que estava bloqueado desde o M0. Fica como candidato a entrega do M2, a ser confirmado com o mesmo protocolo de spike do M0 (read-only real, escrita restrita, cancelamento, formatos de erro).

## Conclusão para o ADR 0003

Teamwork passa no critério de "invocável e observável", mas reprova em três pontos que importam ao APO: exige YOLO em headless, polui o repositório e tem custo/latência desproporcionais para Tasks pequenas. Fica como **referência** e candidato futuro só para trabalhos grandes ("migre 50 componentes"), não na V1.
