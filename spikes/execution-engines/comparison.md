# Triage M2.0 — Comparação de execution engines externos

Data: 2026-10-10. Escopo deliberadamente reduzido (ver ADR 0003): uma pergunta por candidato — "dá para disparar, acompanhar e cancelar via CLI, sem terminal interativo?" — e o mesmo cenário mínimo (dois agentes em paralelo, um mandando um contrato ao outro). O benchmark completo de 6 cenários não foi rodado: nenhum candidato justificou.

Legenda: ✅ confirmado empiricamente · 📄 só documentado/inspecionado · ⚠️ parcial · ❌ ausente/reprovado · ❓ não testado

| Critério | Claude Code Agent Teams | Codex nativo (`multi_agent`) | Antigravity Teamwork | AgentScope |
|---|---|---|---|---|
| Headless | ✅ `claude -p` | 📄 (sem quota no teste) | ✅ `agy -p '/teamwork-preview'` | — framework |
| Paralelismo | ✅ | 📄 stable | ✅ | — |
| Mensagem entre agents | ✅ `SendMessage` | 📄 em desenvolvimento (`agent_message_board` off) | ✅ `send_message` | — |
| Estado observável de fora | ⚠️ só processo + JSON final | ❓ | ✅ arquivos `.agents/teamwork/` | — |
| Cancelamento | ✅ (kill do processo, M0.9) | ✅ (kill do processo, M0.10) | ❓ | — |
| Headless sem YOLO | ✅ (`acceptEdits`) | 📄 | ❌ exige `--dangerously-skip-permissions` | — |
| Isolamento por worker | ❌ mesmo cwd | ❓ | ❌ mesmo cwd | — |
| Não polui o repo | ✅ | ❓ | ❌ grava `.agents/` no repo | — |
| Failover entre providers | ❌ só Anthropic | ❌ só OpenAI | ❌ só dentro do Antigravity | — |
| Custo do cenário mínimo | ~US$ 0,42, ~1 min | — | ~10,5 min, ~205 mil tokens de entrada | — |
| Veredito | cabe no `SingleAgentEngine` | cabe no `SingleAgentEngine` | referência / futuro para trabalho grande | só referência |

## Decisão proposta

1. **Nenhum engine externo entra na V1.** Os de Claude e Codex são "paralelismo dentro de um provider", que já cabe no `SingleAgentEngine` (o worker pode usar subagentes do próprio CLI). O Antigravity Teamwork funciona, mas exige YOLO, polui o repo e custa ~10 min para uma tarefa trivial.
2. **O `ApoNativeEngine` (M2) continua**, porque o diferencial dele — provider diferente por Task e failover entre providers no meio de uma Feature — não existe em nenhum dos três.
3. **A mensageria do APO perde prioridade.** Os três runtimes já fazem mensagem entre agents *dentro* de um provider. O que o APO precisa entre Tasks de providers diferentes é passar o resultado de uma Task para as dependentes — artefatos tipados via DAG (M2.9) cobrem isso. Mailbox e perguntas bloqueantes (M2.18–M2.21) ficam adiadas até um caso real exigir.
4. **Novo candidato: `AntigravityHarness`** (single-agent, `agy -p`) como terceiro provider — destrava o Google/Gemini bloqueado desde o M0.
