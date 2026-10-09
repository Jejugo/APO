# ADR 0002 — AgentHarness: dados reais dos spikes (M0.9–M0.12)

**Status:** aceito
**Contexto:** M0 — Fechamento dos spikes de CLI

## Decisão

As hipóteses da seção 6.2 do `TECHNICAL_PLAN.md` foram substituídas por dados reais de execução (Claude Code e Codex) ou marcadas como não confirmadas (Gemini CLI, bloqueado na autenticação). Relatórios completos: `spikes/claude-code.md`, `spikes/codex.md`, `spikes/gemini.md`.

Resumo das decisões que esses dados forçaram:

1. **`timeoutMs` é obrigatório em todo `AgentExecutionInput`, sem default "confortável".** Credencial inválida não falha rápido em nenhum dos dois CLIs (Claude Code: ~4,4min; Codex: ~10-15s de retry antes do erro). Sem timeout, isso pareceria "lento", não "falhou".
2. **Isolamento de settings pessoais do operador é responsabilidade explícita do harness, não só do `buildWorkerEnvironment()`.** Os dois CLIs carregam config/hooks globais do usuário por padrão (confirmado: o hook `rtk` pessoal do operador foi aplicado dentro de Tasks headless nos dois). Codex resolve com `--ignore-user-config` (decidido, confirmado). Claude Code ainda não tem decisão fechada entre `--bare` (quebra auth OAuth) e `--setting-sources` vazio (hipótese atual, não testada) — fica como item aberto para antes do M1.5.
3. **Confinamento de escrita via flag de sandbox não é suficiente isoladamente.** `codex exec -s workspace-write` escreveu fora do workspace (path relativo `../` e absoluto `/tmp/...`) sem bloqueio. A defesa adotada é em camadas: a flag de sandbox continua como primeira linha (funcionou bem para `read-only`), mais verificação pós-execução via `git diff` (não cobre escapes fora da árvore git) mais um snapshot raso de zonas de risco conhecidas (`$TMPDIR`, diretório pai do worktree). Isolamento real por processo (container/VM) só é natural a partir do M6 (Mac até M5, por decisão de roadmap já registrada) — até lá essa é uma mitigação deliberadamente parcial.
4. **`ProcessSupervisor` deve sempre redirecionar stdin de `/dev/null`.** Confirmado que `codex exec` trava indefinidamente esperando EOF se o stdin não for explicitamente fechado; aplicar a mesma precaução aos três harnesses por simetria, não só ao Codex.
5. **`resume()` é de sessão, não de turno em andamento, nos dois CLIs.** Um turno morto sem conteúdo persistido é reexecutado do zero no resume — consistente com a decisão de roadmap já tomada de que `resume()` é "uma otimização limitada", nunca uma garantia de retomar exatamente de onde parou.
6. **Resume do Codex não herda sandbox/rede da sessão original** — precisa reconstruir via `-c sandbox_mode="..."` e `-c sandbox_workspace_write.network_access=true` explicitamente a cada resume, senão herda a política mais restritiva (observado: voltou como `read-only`).
7. **`CapacityCollector` de ambos não tem medidor de conta agregado** — só consumo por execução/turno (`total_cost_usd`/`usage` no Claude Code, bloco `usage` em `turn.completed` no Codex). A estratégia já prevista (acumular localmente por Task attempt) é confirmada como a única viável; não existe endpoint de quota a consultar de fora.
8. **Gemini CLI: bloqueado.** Tier gratuito "Gemini Code Assist for individuals" não é mais elegível por este client (a Google está migrando para o produto "Antigravity"). Requer API key paga para desbloquear o spike M0.11/M0.12 real. Não bloqueia M0/M1 — decisão de roadmap já previa Gemini só a partir do M3.

## Consequências

- A tabela da seção 6.2 do `TECHNICAL_PLAN.md` deixa de ser hipótese e passa a ser contrato testado para Claude Code e Codex; Gemini permanece 🔬 até um spike real acontecer.
- `AgentExecutionInput` ganhou o campo `networkAccess` (só relevante em `workspace-write`) e `timeoutMs` passou de "campo presente" para "campo com validação de obrigatoriedade" — a ser reforçado em M1 com um teste que rejeita configuração sem timeout.
- O `WorkerManager` (M1) precisa implementar o snapshot de zonas de risco (item 3) antes de qualquer Task real rodar sem supervisão — é um gap de segurança novo, não cosmético.
- Dois itens ficam deliberadamente abertos e não decididos aqui: (a) a flag de isolamento de settings do Claude Code (`--bare` vs. `--setting-sources`), a decidir com um spike de acompanhamento curto antes do M1.5; (b) quando/se desbloquear o Gemini CLI com uma API key paga — decisão do usuário, não técnica.

## Revisão

Nenhum item desta ADR cobre o Gemini CLI com dados reais — revisar quando o spike M0.11/M0.12 for desbloqueado.
