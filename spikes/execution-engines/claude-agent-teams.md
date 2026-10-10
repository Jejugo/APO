# Triage M2.0 — Claude Code Agent Teams

**Versão:** Claude Code 2.1.296. **Data:** 2026-10-10. **Custo:** ~US$ 0,55.
**Pergunta do triage:** dá para disparar, acompanhar e cancelar via CLI, sem terminal interativo?

## Resultado: **passa, parcialmente**

| Critério (ADR 0003) | Resultado | Como foi verificado |
|---|---|---|
| Invocável headless | ✅ confirmado | `claude -p` com um lead que usa a ferramenta `Agent` para criar dois agentes |
| Paralelismo | ✅ confirmado | os dois agentes rodaram ao mesmo tempo (relato do lead + arquivos no disco) |
| Mensagem agent-to-agent | ✅ confirmado | `frontend.md` cita o contrato **no formato da mensagem** (`CONTRATO: ...`), não do arquivo — a mensagem via `SendMessage` foi entregue de verdade |
| Status observável | ⚠️ parcial | só pelo processo `claude -p` e pelo JSON final (`--output-format stream-json` daria progresso incremental, não testado aqui). Não há estado do time consultável de fora |
| Cancelável | ✅ (herdado) | matar o processo `claude -p` (já confirmado no spike M0.9: SIGTERM no grupo, sem órfãos) |
| Controle externo do time | ❌ não testado / bloqueado | `claude --bg` + `claude agents`/`stop`/`logs` existem, mas `--bg` exige aceitar "workspace trust" interativamente em diretório novo — cada worktree do APO é um diretório novo |
| Isolamento entre agentes | ❌ não confirmado | os dois agentes escreveram no mesmo cwd. Não há worktree por agente no teste |
| Provider flexibility | ❌ nenhuma | lead e agentes são sempre Claude (Anthropic) |

## Observações

- A flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` **não mudou** as ferramentas disponíveis em headless (`Agent`, `ListAgents`, `SendMessage`, `TaskStop` aparecem com e sem a flag). O que funcionou é o mecanismo de subagentes do próprio Claude Code, com `SendMessage` entre eles.
- Para o APO, isso é na prática "um `claude -p` mais capaz", não um engine com estado externo próprio: o APO vê um processo, um resultado final e os commits.

## Conclusão para o ADR 0003

Não justifica um `ClaudeTeamsEngine` separado. O que ele oferece — paralelismo e mensagem entre agentes **dentro de um mesmo provider** — já cabe no `SingleAgentEngine` atual: basta o prompt do worker permitir que o Claude Code use subagentes. Não ganha nada no que importa ao APO (failover entre providers, estado observável, isolamento por worktree).
