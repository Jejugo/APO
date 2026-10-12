# Spike — Interromper, mandar mensagem e assumir o controle de um worker

**Data:** 2026-10-12 · **Versões:** Claude Code 2.1.296, codex-cli 0.162.1 (as mesmas da VM) · **Duração:** ~1h
**Pergunta:** para o cockpit do M8, dá para (1) interromper um worker no meio do turno e retomar **a mesma sessão** com uma mensagem do usuário, e (2) o usuário assumir a sessão no CLI interativo de verdade e depois devolvê-la ao APO, que segue sem tela?

Rodado no Mac, em repositórios descartáveis em `/tmp/apo-spike-intr/`, com as mesmas flags dos harnesses (`buildClaudeCodeArgs`/`buildCodexArgs`). Interrupção = `SIGTERM` no process group, como faz o `runSupervisedProcess` (execa `cancelSignal` + `killDescendants`).

Cenário-base: o worker recebe uma "palavra secreta" só no prompt e a tarefa de criar `a.txt` … `e.txt`, com `sleep 10` entre um e outro. O kill acontece durante o segundo `sleep`. A retomada pergunta a palavra secreta e quais arquivos já existem — só responde certo se o contexto sobreviveu.

## Resultados

| # | Teste | Claude Code | Codex |
|---|---|---|---|
| I1 | Kill durante um comando (tool) | ✅ exit 143; sessão gravada até ali; o comando cortado aparece como `Exit code 137` | ✅ exit 143; thread gravada; o transcript marca "Conversation interrupted" |
| I2 | Retomar com mensagem do usuário (`--resume <id>` / `exec resume <id>`) | ✅ **mesmo `session_id`**; sabe a palavra secreta, sabe que criou `a` e `b` e que o `sleep` foi cortado; segue a instrução nova (cria só `z.txt`). 7 s | ✅ **mesmo `thread_id`**; mesma resposta correta; cria só `z.txt` |
| I3 | Kill durante a geração de texto (sem tool, ~5 s) | ✅ o prompt original fica na sessão; o texto parcial **se perde**; a retomada responde o dado do prompt (`7319`) | ✅ idem |
| T1 | Assumir: CLI interativo na sessão do worker (`claude --resume <id>` / `codex resume <id>`), na mesma pasta | ✅ mostra o histórico inteiro do worker; o usuário conversa e o agente age (criou `m.txt`). ⚠️ diálogo "trust this folder" na 1ª vez na pasta | ✅ histórico inteiro; conversa e age |
| T2 | Devolver: retomar sem tela depois do interativo | ✅ o interativo escreve **no mesmo arquivo de sessão**; o `-p --resume` resume corretamente o que o usuário fez | ❌ com o servidor compartilhado do Codex (padrão): `thread already has an active writer` — o daemon segura a thread depois que a TUI sai, e continua segurando minutos depois. ✅ com `codex resume --no-daemon <id>`: devolução funciona, mesmo `thread_id`, contexto completo |
| V1 | Viabilidade na VM | `claude`/`codex` do APO em `/opt/node24` (mesmas versões); sessões persistidas em `/home/apo/.claude/projects/<worktree>` e `/home/apo/.codex/sessions`; o serviço só escreve em `/home/apo` (`ProtectHome=tmpfs`) | |

## Conclusões

1. **Mensagem ao agente é viável nos dois harnesses** com o que já existe: cancelar o attempt (SIGTERM) e chamar `harness.resume(sessionId)` com a mensagem — o mesmo caminho da resposta a pergunta do M7. Custo: o trabalho do comando em andamento e o texto ainda não terminado se perdem; o resto do turno fica.
2. **A interrupção não pode parecer falha.** Hoje o cancelamento vira attempt cancelado; para a mensagem, o APO precisa de um motivo próprio (ex.: `interrupted_by_user`) que **não** conta como falha, não dispara failover e retoma no mesmo target (`resolutionSource: "resume"`).
3. **Assumir/devolver é viável**, com regras:
   - **exclusividade**: o APO não pode rodar o worker sem tela enquanto o usuário está no controle (dois escritores na mesma sessão). A Task ganha um estado próprio (ex.: `taken_over`) e o runner não a pega;
   - **Codex sempre com `--no-daemon`** no comando de assumir; sem isso a devolução quebra;
   - **Claude**: pré-aceitar o "trust" da worktree, ou avisar que a 1ª tecla é confirmar a pasta;
   - **devolução** = retomada sem tela com um prompt do APO ("o usuário devolveu o controle; termine e entregue o relatório") e o schema do `WorkerReport` — o fluxo normal segue dali (gates, review);
   - **na VM**: `ssh -t ubuntu-lab sudo -u apo -H … --resume <id>` dentro da worktree. Roda fora do sandbox do systemd (só as permissões do usuário `apo` valem); aceitável por ser uma ação manual do dono, mas fica registrado.
4. **O CLI interativo carrega a configuração de quem roda.** No Mac, a sessão do teste recebeu skills, MCPs e o modo de permissão do usuário. Na VM, o usuário `apo` não tem nada disso — o comportamento fica próximo do worker.

**Decisão:** seguir com o M8 como **Cockpit**, incluindo mensagem ao agente (interromper + retomar) e assumir/devolver o controle, com as regras acima. Nenhuma mudança na interface `AgentHarness`: `cancel` + `resume` bastam; o comando de assumir é conhecimento por harness (isolado em `packages/harnesses`, como as flags).

**Pendência do spike:** a thread de teste `01a131c8…` ficou presa no daemon do Codex do Mac (efeito do teste T2 sem `--no-daemon`); é descartável e some quando o daemon reinicia.
