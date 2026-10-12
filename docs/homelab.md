# Runbook — APO no homelab (M6.5–M6.9)

VM `ubuntu-lab` (Proxmox, KVM, Ubuntu 26.04, 4 vCPUs, 11 GB). LAN `192.168.15.45`, Tailscale `100.123.161.90`.

## Visão geral

| Peça | Onde |
|---|---|
| Código (só leitura para o `apo`) | `/opt/apo`, dono `root` |
| Node 24 isolado (o do sistema continua o 22) | `/opt/node24` |
| Usuário do serviço (sem sudo, sem grupo docker) | `apo`, home `/home/apo` (750) |
| Estado do APO | `/home/apo/.apo` (config, segredos, logs, worktrees, runs, modelos) |
| Repos que o APO opera | `/home/apo/projects` |
| Banco | Postgres 18 nativo + pgvector, banco/role `apo`, só em `127.0.0.1` |
| Backups | `/home/apo/backups/apo-AAAA-MM-DD.sql.gz` (14 dias) |
| Serviço | `apo.service` (systemd) |
| Manutenção diária | `apo-maintenance.timer` (03:30): `pg_dump` + limpeza de logs/runs > 30 dias |
| Acesso remoto | `http://100.123.161.90:7400`, só no IP do Tailscale, com token |

`~/.apo/secrets.env` do `apo` (chmod 600) guarda `DATABASE_URL`, `APO_REMOTE_TOKEN` e, se usado, `OPENROUTER_API_KEY` (Jev). O daemon carrega esse arquivo; os workers nunca recebem nada dele (allowlist de ambiente).

## Instalar / atualizar

Como `jeff` na VM (usa o login do `gh` que já existe):

```bash
# primeira vez
sudo git clone https://github.com/Jejugo/APO.git /opt/apo   # ou: gh repo clone Jejugo/APO /tmp/apo && sudo mv /tmp/apo /opt/apo
sudo /opt/apo/deploy/homelab/install.sh

# atualizar
sudo git -C /opt/apo pull --ff-only && sudo /opt/apo/deploy/homelab/install.sh
```

O `install.sh` é idempotente: instala Postgres 18 + pgvector e o Node 24 (com checagem de SHA256), cria o usuário `apo`, o banco, o token remoto e o `config.yaml` (só se não existirem), faz o build como `root`, roda as migrations como `apo`, instala `/usr/local/bin/apo` e as units do systemd, e reinicia o serviço.

## Logins (feitos por você, uma vez)

Os CLIs usam OAuth das suas contas — o APO nunca faz login por você:

```bash
sudo -iu apo
claude            # login do Claude Code (siga o link)
codex login       # login do Codex
gh auth login     # para o APO abrir PRs (repo scope)
git config --global user.name "APO (homelab)"; git config --global user.email "<seu email>"
exit
```

Antigravity / `agy` (opcional, modelos Gemini; limitações em `spikes/antigravity.md`): instale como `apo` (`sudo WITH_AGY=1 /opt/apo/deploy/homelab/install.sh` — fica em `/home/apo/.local/bin`, porque o `agy` se atualiza sozinho), faça o login e ative o target:

```bash
sudo -iu apo
~/.local/bin/agy                  # login da conta Google (siga o link); depois /quit
~/.local/bin/agy models           # confirma o login e lista os modelos
nano ~/.apo/config.yaml           # descomente o bloco providers (claude-code, codex, antigravity)
exit
sudo systemctl restart apo
```

Com `dangerouslySkipPermissions: true`, o worker do `agy` roda comandos e não confina a escrita à worktree; na VM, o sandbox do systemd limita a escrita a `/home/apo`.

Jev (opcional): adicione a key ao `secrets.env` do `apo`, sem colar no histórico do shell:

```bash
sudo -u apo bash -c 'read -s -p "OPENROUTER_API_KEY: " K; echo; echo "OPENROUTER_API_KEY=$K" >> ~/.apo/secrets.env'
sudo systemctl restart apo
```

## Operação

```bash
systemctl status apo                 # estado
journalctl -u apo -f                 # log do daemon (o journald rotaciona)
sudo -u apo apo status               # CLI local, pelo socket
curl -s -H "Authorization: Bearer $TOKEN" http://100.123.161.90:7400/health   # Postgres + providers
systemctl list-timers apo-maintenance.timer
sudo -u apo ls ~apo/backups
```

Do Mac, pelo Tailscale:

```bash
export APO_URL=http://100.123.161.90:7400
export APO_TOKEN=<valor de APO_REMOTE_TOKEN da VM>
apo status && apo chat --project <id>
```

Registrar um projeto na VM: clone em `/home/apo/projects` como `apo` e `apo project add /home/apo/projects/<repo>`.

## Recuperação

- **Restart/boot:** o serviço sobe sozinho (`enable`), mata workers órfãos (M6.8), remove worktrees de Features encerradas, marca attempts `working` como `interrupted` e retoma as Features ativas a partir do checkpoint (M1.13). Features em `awaiting_approval` continuam esperando `apo approve|reject`.
- **Restaurar backup:** `sudo systemctl stop apo; sudo -u postgres dropdb apo; sudo -u postgres createdb -O apo apo; sudo -u postgres psql -d apo -c 'CREATE EXTENSION vector'; gunzip -c ~apo/backups/apo-AAAA-MM-DD.sql.gz | sudo -u apo psql "$DATABASE_URL"; sudo systemctl start apo`.

## Isolamento (gate do M6)

- `apo` não tem sudo nem grupo `docker`; `/home/jeff` é `750` (o `apo` não lê).
- O serviço roda com `ProtectSystem=strict`, `ProtectHome=tmpfs` + `BindPaths=/home/apo` (outras homes nem aparecem no namespace), `NoNewPrivileges`, `PrivateTmp`. Workers herdam esse sandbox.
- Postgres só em `127.0.0.1`; o acesso remoto só no IP do Tailscale, com token de 64 hex comparado em tempo constante. Nada é exposto na internet.
