# Spike M2.23 — Antigravity CLI (`agy`) headless

**Data:** 2026-10-10 · **Versão:** `agy` 1.3.2 · **Conta:** Google (login já feito no CLI)
**Protocolo:** o mesmo do M0 (headless, saída estruturada, read-only real, escrita restrita, erros, resume).

## Resultado

| # | Teste | Resultado |
|---|---|---|
| T1 | `agy -p "…" --output-format json` com stdin fechado | ✅ JSON único no stdout: `{conversation_id, status: "SUCCESS", response, duration_seconds, num_turns, usage}`. ~6s para um prompt trivial |
| T2 | `--json-schema` (pergunta que precisa ler o repo) | ❌ `response: ""`, nenhum campo com a saída estruturada; `denied_actions: [RunCommand]` |
| T2b | `--json-schema` (pergunta sem ferramenta: "capital da França") | ❌ idem — tenta `RunCommand` mesmo assim, negado, resposta vazia |
| T3 | `--mode plan` pedindo para criar/alterar arquivos | ✅ nada foi escrito (`git status` limpo). `status: SUCCESS` mesmo sem fazer nada |
| T4 | `--mode accept-edits` criando arquivo no cwd | ✅ arquivo criado |
| T5 | `--mode accept-edits` + comando de shell (`git log`) | ❌ `denied_actions: [RunCommand]` — em headless, **todo** comando é negado sem `--dangerously-skip-permissions` |
| T6 | `--dangerously-skip-permissions` (autorizado pelo usuário) | ✅ roda comandos (`npm test`, `git log`). Com `--sandbox` junto, um `echo > …` escreveu fora do cwd **e** na home do usuário: `--sandbox` não confina disco |
| T7 | `--model` inválido | ✅ exit 1 + JSON `{status: "ERROR", error: "invalid model selection …"}` |
| T8 | `--add-dir <runs>` + escrita fora do cwd e do add-dir | ⚠️ escreveu nos **dois**: `accept-edits` não confina escrita ao workspace |
| T9 | `--conversation <id>` | ✅ resume de sessão funciona (lembrou o contexto do turno anterior) |

Não reproduzido: formato de erro de quota/rate limit (a conta não estava no limite). `detectLimitFailure` é aplicado ao campo `error` como nos outros harnesses; ajustar quando um caso real aparecer.

## Consequências para o APO

1. **Worker sim, Lead não.** Sem saída estruturada, o `agy` não pode ser Lead (triage, planner, overlap). `supportsOutputSchema: false`, e o daemon exclui do roteamento do Lead os targets sem essa capability.
2. **Worker só de edição.** Sem `--dangerously-skip-permissions`, o worker não roda testes, install nem git. O APO já faz o commit (`commitIfDirty`) e a verificação roda na integração, então a Feature fecha — mas o worker trabalha sem feedback de testes.
3. **Sem confinamento de escrita (T8).** Diferente do Codex (sandbox) e do Claude Code (`acceptEdits` limitado aos diretórios de trabalho), o `agy` escreve em qualquer caminho. A worktree isolada continua isolando o *git*, não o *disco*.
4. **Read-only:** `--mode plan` segurou a escrita em T3, mas um teste só não basta para `supportsReadOnly: true` (WorkspacePolicy só manda para `shared` com read-only confirmado). Fica `false`: Task `read` no `agy` recebe worktree própria.
5. **Resume nativo:** `--conversation <id>` ✅ (`supportsResume: true`).
6. **Bônus:** a conta Google expõe também Claude Opus/Sonnet 5.5 e GPT-OSS via `agy models`. Um target `agy` com `model: claude-…` seria outra rota para modelos Anthropic — mas o `provider` do target continua sendo `google` para fins de capacidade (a cota é da conta Google).

**Decisão:** `AntigravityHarness` implementado, **fora** dos targets padrão (opt-in em `providers.targets`), por causa de (2) e (3).

**Atualização (comandos liberados, por decisão do usuário):** opção por target `dangerouslySkipPermissions` (default `false`) no `config.yaml`:

```yaml
providers:
  targets:
    - { id: antigravity, harness: antigravity, provider: google, model: gemini-3.1-pro-high, dangerouslySkipPermissions: true }
```

Ligada, o worker em `workspace-write` recebe `--dangerously-skip-permissions` e passa a rodar testes, lint, install e git. Nunca é aplicada em `read-only`. O daemon loga um aviso no boot. `--sandbox` não é usado: não protegeu nada mensurável (T6). E2E real: Feature `completed` com o worker rodando vitest, typecheck e biome e commitando, sem nenhuma ação negada. O risco (3) continua: com comandos liberados, o worker pode escrever em qualquer lugar do disco.
