# Spike M0.11 — Gemini CLI

**Status: bloqueado na autenticação.** Protocolo não executado além da instalação.

## O que foi feito

- Instalado via `npm install -g @google/gemini-cli` (versão `0.63.0`).
- Flags headless confirmadas via `--help` (sem precisar de execução real):
  - Modo headless: `gemini -p "<prompt>"`
  - Saída estruturada: `-o/--output-format json` (também `stream-json`)
  - Read-only: `--approval-mode plan`
  - Escrita sem prompts (YOLO): `-y/--yolo` ou `--approval-mode yolo`
  - Resume nativo: `-r/--resume <latest|índice>`, `--session-id <uuid>`
  - Sandbox: `-s/--sandbox` (booleano — não é um enum de modos como Codex; precisa investigar o que isola exatamente, não confirmado)

## O bloqueio

Ao tentar qualquer execução real (`gemini -p "responda apenas 'ok'"`), a autenticação falha antes de chegar a qualquer teste do protocolo:

```
Error authenticating: IneligibleTierError: This client is no longer supported for
Gemini Code Assist for individuals. To continue using Gemini, please migrate to the
Antigravity suite of products: https://antigravity.google
```

A conta Google usada não é mais elegível para o tier gratuito ("Gemini Code Assist for individuals") através deste client. A Google está direcionando esse fluxo para o produto "Antigravity". A única forma de autenticar o `gemini` CLI headless hoje, além de migrar de produto, é via uma **API key paga** do Gemini (`GEMINI_API_KEY`), que não foi configurada — decisão deliberadamente não tomada sem o usuário, por envolver custo/credencial nova.

Houve também um segundo obstáculo (não testado a fundo por já estar bloqueado na auth): o CLI recusa rodar em modo headless fora de um diretório "trusted" a menos que `--skip-trust` ou `GEMINI_CLI_TRUST_WORKSPACE=true` sejam passados — relevante para quando o spike for retomado (o `AgentHarness` do Gemini vai precisar passar essa flag/env sempre).

## Por que isso não bloqueia o M0/M1

A decisão de roadmap já registrada (`ROADMAP.md`, seção 5) é que o M1 sai com **Claude Code + Codex**, não com os três providers. O Gemini é opcional/posterior. Este spike fica marcado como pendente — retomar quando:

1. o usuário decidir pagar por uma API key do Gemini, OU
2. a Google disponibilizar de novo um caminho de auth gratuito para este client, OU
3. decidirmos que o Gemini não entra no M1 ou talvez nunca entre, e isso se torna uma decisão de escopo em vez de um spike pendente.

## Confirmações para TECHNICAL_PLAN §6.2 (parciais, só por `--help`)

| Necessidade | Gemini CLI |
|---|---|
| Modo headless | `gemini -p "<prompt>"` — confirmado por `--help`, não testado em execução real |
| Saída estruturada | `-o/--output-format json` (ou `stream-json`) — não testado |
| Read-only | `--approval-mode plan` — não testado |
| Escrita restrita ao workspace | `-s/--sandbox` é booleano, não um enum; semântica exata **não confirmada** |
| Sem prompts (YOLO) | `-y/--yolo` ou `--approval-mode yolo` — confirmado por `--help`, não testado |
| Resume nativo | `-r/--resume <latest|índice>` ou `--session-id <uuid>` na criação — não testado |

Nenhuma dessas linhas pode ser considerada fechada (🔬 continua aberto) até uma execução real acontecer.
