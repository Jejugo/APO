#!/usr/bin/env bash
# Instalação/atualização do APO na VM do homelab (M6.5). Idempotente.
# Uso (como jeff, com o código já em /opt/apo):  sudo /opt/apo/deploy/homelab/install.sh
# Ver docs/homelab.md.
set -euo pipefail

NODE_VERSION="v24.21.0"
PNPM_VERSION="12.4.2"
CLAUDE_CODE_VERSION="2.1.296"
APO_USER="apo"
APO_HOME="/home/${APO_USER}"
SRC="/opt/apo"
NODE_DIR="/opt/node24"

[[ $EUID -eq 0 ]] || { echo "rode com sudo" >&2; exit 1; }
[[ -f "${SRC}/package.json" ]] || { echo "código do APO não encontrado em ${SRC}" >&2; exit 1; }

echo "==> pacotes (Postgres 18 + pgvector)"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-18 postgresql-18-pgvector git ca-certificates curl >/dev/null

echo "==> Node ${NODE_VERSION} isolado em ${NODE_DIR}"
if [[ "$("${NODE_DIR}/bin/node" --version 2>/dev/null || true)" != "${NODE_VERSION}" ]]; then
  tmp="$(mktemp -d)"
  tarball="node-${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "https://nodejs.org/dist/${NODE_VERSION}/${tarball}" -o "${tmp}/${tarball}"
  curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt"
  (cd "${tmp}" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "${NODE_DIR}" && mkdir -p "${NODE_DIR}"
  tar -xJf "${tmp}/${tarball}" -C "${NODE_DIR}" --strip-components=1
  rm -rf "${tmp}"
fi
export PATH="${NODE_DIR}/bin:${PATH}"
# CLIs dos agentes do APO ficam aqui (não usa o claude/codex globais do
# sistema): versão sob controle do APO — o harness depende de flags recentes.
npm install -g --silent "pnpm@${PNPM_VERSION}" @openai/codex "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" >/dev/null

echo "==> usuário ${APO_USER} (sem sudo, sem docker)"
if ! id "${APO_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group "${APO_USER}"
fi
chmod 750 "${APO_HOME}"
install -d -o "${APO_USER}" -g "${APO_USER}" -m 700 "${APO_HOME}/.apo" "${APO_HOME}/projects" "${APO_HOME}/backups"

# Antigravity (agy) é opt-in (spikes/antigravity.md): WITH_AGY=1 instala. Fica
# na home do apo, e não em /opt, porque o agy se atualiza sozinho e precisa
# poder reescrever o próprio binário. O login (conta Google) é do usuário:
#   sudo -u apo -H /home/apo/.local/bin/agy
if [[ "${WITH_AGY:-0}" == "1" && ! -x "${APO_HOME}/.local/bin/agy" ]]; then
  echo "==> Antigravity (agy) em ${APO_HOME}/.local/bin"
  agy_installer="$(mktemp)"
  curl -fsSL https://antigravity.google/cli/install.sh -o "${agy_installer}"
  chmod 644 "${agy_installer}"
  sudo -u "${APO_USER}" -H bash "${agy_installer}" || true
  rm -f "${agy_installer}"
  [[ -x "${APO_HOME}/.local/bin/agy" ]] || { echo "falha ao instalar o agy" >&2; exit 1; }
fi

echo "==> Postgres: role e banco ${APO_USER}"
SECRETS="${APO_HOME}/.apo/secrets.env"
touch "${SECRETS}" && chown "${APO_USER}:${APO_USER}" "${SECRETS}" && chmod 600 "${SECRETS}"
if ! grep -q '^DATABASE_URL=' "${SECRETS}"; then
  db_password="$(openssl rand -hex 24)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APO_USER}') THEN
    CREATE ROLE ${APO_USER} LOGIN;
  END IF;
END \$\$;
ALTER ROLE ${APO_USER} PASSWORD '${db_password}';
SQL
  echo "DATABASE_URL=postgres://${APO_USER}:${db_password}@127.0.0.1:5432/${APO_USER}" >> "${SECRETS}"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${APO_USER}'" | grep -q 1 \
  || sudo -u postgres createdb -O "${APO_USER}" "${APO_USER}"
# pgvector não é extensão "trusted": quem cria é o superusuário.
sudo -u postgres psql -d "${APO_USER}" -qc "CREATE EXTENSION IF NOT EXISTS vector"

echo "==> token do acesso remoto (Tailscale)"
if ! grep -q '^APO_REMOTE_TOKEN=' "${SECRETS}"; then
  echo "APO_REMOTE_TOKEN=$(openssl rand -hex 32)" >> "${SECRETS}"
fi

echo "==> config.yaml"
if [[ ! -f "${APO_HOME}/.apo/config.yaml" ]]; then
  tailscale_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [[ -z "${tailscale_ip}" ]]; then
    echo "aviso: sem IP do Tailscale; remote.listen fica desligado" >&2
    grep -v -e '^remote:' -e 'listen:' -e 'IP do Tailscale' "${SRC}/deploy/homelab/config.yaml" > "${APO_HOME}/.apo/config.yaml"
  else
    sed "s/\${TAILSCALE_IP}/${tailscale_ip}/" "${SRC}/deploy/homelab/config.yaml" > "${APO_HOME}/.apo/config.yaml"
  fi
  chown "${APO_USER}:${APO_USER}" "${APO_HOME}/.apo/config.yaml"
  chmod 600 "${APO_HOME}/.apo/config.yaml"
fi

echo "==> build em ${SRC} (dono root; o apo só lê e executa)"
chown -R root:root "${SRC}"
(cd "${SRC}" && pnpm install --frozen-lockfile --silent && pnpm build >/dev/null)
chmod -R a+rX "${SRC}"

echo "==> migrations"
sudo -u "${APO_USER}" bash -c "set -a; . '${SECRETS}'; set +a; '${NODE_DIR}/bin/node' '${SRC}/packages/db/dist/migrate.js'"

echo "==> CLI em /usr/local/bin/apo"
cat > /usr/local/bin/apo <<WRAPPER
#!/bin/sh
exec ${NODE_DIR}/bin/node ${SRC}/apps/cli/dist/main.js "\$@"
WRAPPER
chmod 755 /usr/local/bin/apo

echo "==> systemd"
install -m 644 "${SRC}/deploy/homelab/apo.service" /etc/systemd/system/apo.service
install -m 644 "${SRC}/deploy/homelab/apo-maintenance.service" /etc/systemd/system/apo-maintenance.service
install -m 644 "${SRC}/deploy/homelab/apo-maintenance.timer" /etc/systemd/system/apo-maintenance.timer
chmod 755 "${SRC}/deploy/homelab/maintenance.sh"
systemctl daemon-reload
systemctl enable --now apo-maintenance.timer >/dev/null
systemctl enable apo.service >/dev/null
systemctl restart apo.service

echo "==> pronto. Status: systemctl status apo  |  logs: journalctl -u apo -f"
