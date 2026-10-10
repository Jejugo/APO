# Triage M2.0 — Multi-agente nativo do Codex (e codex-teams)

**Versão:** codex-cli 0.161.0. **Data:** 2026-10-10.
**Status: não testado empiricamente.** O Codex estava sem quota (limite da conta ChatGPT até 02:27) durante o triage. Tudo abaixo é **documentado/inspecionado**, não confirmado em execução.

## O que foi possível verificar sem gastar quota (`codex features list`)

| Feature | Estágio | Ligada |
|---|---|---|
| `multi_agent` | stable | sim (default) |
| `multi_agent_v2` | stable | não |
| `agent_message_board` | under development | não |
| `defer_mailbox_preemption` | under development | não |

## Leitura

- Subagentes paralelos nativos existem e estão estáveis, mas a **comunicação entre agentes** (`agent_message_board`) ainda está em desenvolvimento e desligada. Hoje o modelo é "dispara em paralelo e junta os resultados", não colaboração com mensagens.
- `codex-teams` (GekkoQuest) é um plugin de terceiro que adiciona justamente mailbox/tarefas compartilhadas por cima disso. Pelo critério de risco do ADR 0003 (três camadas: feature da OpenAI + plugin de terceiro + manutenção de repo pessoal), não foi instalado.
- Mesmo funcionando, o provider é sempre OpenAI — sem failover entre providers.

## Conclusão para o ADR 0003

Mesma conclusão do Claude Code Agent Teams: é paralelismo **dentro de um provider**, que cabe no `SingleAgentEngine` se o prompt permitir subagentes. Não justifica um engine próprio. Fica pendente apenas confirmar empiricamente quando a quota voltar, se for relevante — não muda a decisão.
