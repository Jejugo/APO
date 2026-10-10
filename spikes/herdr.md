# Spike — Herdr como runtime dos workers

**Data:** 2026-10-10 · **Versão:** herdr 0.9.0 · **Duração:** ~1h
**Pergunta:** o Herdr consegue hospedar `claude -p` / `codex exec` mantendo a saída estruturada íntegra (necessária para o failover), e o worker sobrevive à morte do daemon do APO? Se sim, justifica uma interface `AgentRuntime` com duas implementações.

Rodado numa sessão Herdr **isolada** (`herdr --session apo-spike server`, socket próprio), sem tocar na sessão do usuário. A sessão foi parada e removida no fim.

## Resultados

| # | Teste | Resultado |
|---|---|---|
| H1 | `claude -p --output-format json --json-schema` no pane, saída lida pela tela (`pane read --source recent-unwrapped`) | ✅ para saída pequena (JSON de 1,9 KB numa linha, parse ok, `structured_output` presente) |
| H2 | Linha JSON de ~200 KB (resposta longa) lida pela tela | ❌ perdida inteira (0 linhas JSON capturadas). 20 KB passou |
| H3 | JSONL com 500 e 5000 eventos (formato do `codex exec --json`) lido pela tela | ❌ truncado: 448/500 e 996/5000 eventos — o scrollback corta |
| H4 | `wait-output` como sinal de fim | ⚠️ casa com saída **já existente** na tela; exige marcador único por execução |
| H5 | `codex exec --json` real com stdout/stderr/exit redirecionados para arquivos | ✅ 12 eventos íntegros, `thread_id`, exit 0 |
| H6 | Árvore de processos | `herdr server → zsh do pane → claude → filhos`. O processo que lançou (o CLI `herdr`) sai na hora; **o worker não depende do daemon do APO** |
| H7 | Cancelamento com `pane send-keys ctrl+c` | ✅ mata a árvore inteira (claude, shell da tool, `sleep`). ⚠️ o `claude` saiu com **exit 0** e stdout vazio — cancelamento não é distinguível pelo exit code |
| H8 | Redescoberta após restart | ✅ `pane rename <id> apo-attempt-<id>` + `pane list` permite reencontrar o pane de um attempt |
| H9 | Ambiente do worker | ⚠️ herda o ambiente do servidor Herdr (79 variáveis no teste), incluindo `HERDR_SOCKET_PATH`: o worker poderia controlar o Herdr e outros panes. Exigiria `env -i` + allowlist no comando |
| H10 | Morte do **servidor Herdr** com worker rodando | ❌ o worker morre junto |

## Conclusão

1. **Saída estruturada íntegra: só por arquivo.** A tela do pane não serve como canal (H2, H3): o APO teria que rodar `cmd > stdout 2> stderr; echo $? > exit` no pane e ler os arquivos. Nesse modo o pane não mostra nada útil ao usuário — some o principal atrativo do Herdr (ver o agente trabalhando).
2. **Sobrevive à morte do daemon: sim** (H6), e o daemon reencontraria o attempt pelo rótulo do pane (H8) e pelo arquivo `exit`. Mas o worker passa a depender da vida do servidor Herdr (H10) — troca uma dependência por outra.
3. **O mesmo ganho existe sem o Herdr.** O que dá a sobrevivência é o worker não ser filho do daemon e escrever stdout/stderr/exit em arquivo. Isso é um spawn `detached` (novo process group/sessão) com redirecionamento para `~/.apo/runs/<attemptId>/` — sem dependência externa, sem vazar socket de controle (H9), e com o kill da árvore que o `runSupervisedProcess` já faz.
4. **Custos do Herdr como runtime:** sinal de fim frágil (H4), cancelamento indistinguível pelo exit (H7), ambiente vazando o socket (H9), mais uma peça para o usuário manter rodando.

**Decisão:** não introduzir `AgentRuntime` nem a implementação Herdr agora. A interface só se justifica com uma segunda implementação que traga algo que a primeira não tem; o Herdr, usado do único jeito que preserva a saída estruturada, não traz.

**Se a sobrevivência à morte do daemon virar requisito** (hoje o recovery do M1.13 marca o attempt como `interrupted` e refaz com handover — funciona, mas desperdiça o trabalho em andamento), o caminho é um runtime **destacado nativo**: spawn detached + arquivos em `~/.apo/runs/<attemptId>/` + `pid` gravado; no boot, o daemon reencontra attempts vivos pelo pid e espera o `exit` em vez de interrompê-los. Candidato natural para o M4/M5, não agora.

**Onde o Herdr ainda pode servir:** como **visualizador opcional**, fora do caminho crítico — ex.: `apo watch` abrindo um pane com `tail -f` do log do attempt. Não exige `AgentRuntime`.
