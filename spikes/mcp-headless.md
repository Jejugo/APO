# Spike M0.12 — MCP headless

**Pergunta:** um CLI em modo headless consegue chamar uma ferramenta MCP local síncrona e esperar a resposta? Insumo direto para a seção 4.2 do ROADMAP (mensageria mailbox vs. blocking) — especificamente para a mensageria síncrona ao vivo entre workers, hoje marcada como condicional/deferida (M6).

**Setup:** MCP server local trivial (stdio), TypeScript/Node, `@modelcontextprotocol/sdk`, uma única ferramenta `ping(message)` que grava cada chamada recebida/respondida em `/tmp/mcp-spike-calls.log` (prova externa, independente do que o CLI relata) e espera `MCP_SPIKE_DELAY_MS` antes de responder — usado para simular uma pergunta bloqueante a uma persona persistente. Testado contra cópias isoladas de `fixtures/sample-repo`, nunca o repo real. Pulei o Gemini CLI (bloqueado na autenticação, `spikes/gemini.md`).

## Claude Code

Comando: `claude -p "<prompt>" --mcp-config <json> --strict-mcp-config --allowedTools "mcp__spike__ping" --permission-mode acceptEdits --output-format json`.

- **Sem `--allowedTools`, a chamada é negada** (`permission_denials: [{"tool_name":"mcp__spike__ping", ...}]`) mesmo em `--permission-mode acceptEdits` — ferramentas MCP não são auto-aprovadas por esse modo, precisam ser explicitamente listadas.
- **Com `--allowedTools "mcp__spike__ping"`: funciona.** Confirmado por log externo (`CALL received` / `RESPONDED` no `/tmp/mcp-spike-calls.log`), não só pela saída do CLI.
- **Teste bloqueante (delay de 8s no server): funciona sem problema.** O turno esperou os ~8s completos (log mostra `CALL` às `14:28:18.256Z`, `RESPONDED` às `14:28:26.260Z`) e terminou com `"result": "feito"`, sem timeout implícito nem erro.
- **Achado operacional:** sem stdin explicitamente fechado, o Claude Code imprime `Warning: no stdin data received in 3s, proceeding without it` e segue depois de ~3s — diferente do Codex (que trava indefinidamente, ver M0.10), mas ainda assim um custo de latência evitável. `ProcessSupervisor` deve sempre redirecionar `< /dev/null`.

**Veredito parcial (Claude Code): SIM.** MCP síncrono bloqueante funciona em modo headless, desde que a ferramenta esteja em `--allowedTools`.

## Codex

Registro do server: `codex mcp add spike --env MCP_SPIKE_DELAY_MS=0 -- node <path>/server.mjs` (escreve em `~/.codex/config.toml` — removido com `codex mcp remove` ao final do spike, sem resíduo).

- **Achado crítico:** com `-s workspace-write` (e também com `-s read-only`), a chamada MCP falha com `{"error":{"message":"MCP tool call requires approval, but approval policy is never"}}`. **O agente então respondeu `"feito"` mesmo com a chamada tendo falhado** — um falso-positivo de sucesso que só foi detectável porque o log externo do server não registrou nada. Isso é um risco real para o `WorkerManager`: não dá para confiar no texto final do agente como sinal de que uma ferramenta MCP foi chamada com sucesso.
- **Não existe um mecanismo granular de "confiar nesse servidor MCP específico".** Testei `-c 'mcp_servers.spike.trust="trusted"'` — ignorado (sem efeito, mesmo erro). A única forma de permitir a chamada é remover o sandbox quase inteiro: `-s danger-full-access` **ou** `--dangerously-bypass-approvals-and-sandbox`. Ambos funcionam (confirmado por log externo), mas os dois também eliminam toda a contenção de escrita/shell da Task, não só a aprovação do MCP.
- **Teste bloqueante (delay de 8s), sob `-s danger-full-access`: funciona sem problema**, esperou os 8s completos e retornou `"pong":"SPIKE-CODEX-DELAY"` corretamente.
- Demais achados de ambiente (carrega `~/.codex/config.toml`/hooks por padrão, trava sem stdin fechado) já documentados no M0.10 e não repetidos aqui.

**Veredito parcial (Codex): PARCIAL.** Tecnicamente funciona (inclusive bloqueante), mas só abrindo mão de todo o sandbox da Task — não há caminho hoje para "Task com workspace-write + MCP permitido" ao mesmo tempo.

## Conclusão para o M0.12 / seção 4.2 do ROADMAP

**É viável, hoje, que um worker headless chame uma ferramenta MCP local síncrona e espere a resposta? SIM, com uma ressalva importante por provider.**

- No Claude Code, a resposta é um "sim" limpo: basta listar a ferramenta em `--allowedTools`, sem abrir mão de nenhum outro controle de permissão/sandbox da Task.
- No Codex, a resposta é "sim, mas caro": habilitar MCP hoje exige `danger-full-access` (ou o bypass equivalente), o que anula toda a contenção de escrita que o `WorkspacePolicy` depende da flag de sandbox para garantir (e que o M0.10 já mostrou ser frágil mesmo em `workspace-write`). Rodar uma Task inteira sem sandbox só para permitir uma pergunta bloqueante a uma persona persistente é uma troca ruim — infla o raio de explosão de qualquer Task que precise perguntar algo, não só do pedido em si.

**Implicação para a arquitetura (mensageria síncrona ao vivo, M6, condicional):** a via MCP-síncrono funciona tecnicamente nos dois CLIs testados, mas no Codex ela está presa a um trade-off de segurança que o resto do `TECHNICAL_PLAN.md` foi desenhado para evitar. Isso reforça — com dados reais, não só precaução — a decisão já tomada de manter a mensageria ao vivo como **condicional e não essencial**: um harness poderia oferecer esse caminho (Claude Code hoje, de forma limpa) enquanto outro não oferece de forma segura (Codex, hoje). Qualquer implementação futura da mensageria síncrona via MCP precisa ser **por-harness**, nunca assumida como uma capacidade uniforme do `AgentHarness`, e o Codex especificamente precisa ou (a) aceitar o trade-off de segurança quando uma Task realmente precisar perguntar a uma persona, ou (b) esperar uma versão futura do Codex CLI que ofereça aprovação granular por servidor MCP (não existe hoje, confirmado nesta versão `0.161.0`).

Nenhum outro arquivo do repo foi modificado. Os registros MCP de teste (`spike`, `spikedelay`) foram removidos do `~/.codex/config.toml` global ao final do spike.
