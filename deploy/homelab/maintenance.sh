#!/usr/bin/env bash
# M6.9 — roda como `apo` pelo apo-maintenance.timer.
# - pg_dump diário comprimido, retenção de BACKUP_RETENTION_DAYS (padrão 14);
# - logs de attempts/agent-runner e diretórios de runs com mais de
#   LOG_RETENTION_DAYS (padrão 30). O log do daemon vai para o journald.
set -euo pipefail

APO_HOME="${HOME}/.apo"
BACKUP_DIR="${HOME}/backups"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"

set -a
# shellcheck disable=SC1091
. "${APO_HOME}/secrets.env"
set +a

mkdir -p "${BACKUP_DIR}"
target="${BACKUP_DIR}/apo-$(date +%F).sql.gz"
pg_dump --no-owner --format=plain "${DATABASE_URL}" | gzip -9 > "${target}.tmp"
mv "${target}.tmp" "${target}"
find "${BACKUP_DIR}" -name 'apo-*.sql.gz' -mtime "+${BACKUP_RETENTION_DAYS}" -delete

find "${APO_HOME}/logs" -type f -mtime "+${LOG_RETENTION_DAYS}" -delete 2>/dev/null || true
find "${APO_HOME}/runs" -mindepth 1 -maxdepth 1 -type d -mtime "+${LOG_RETENTION_DAYS}" -exec rm -rf {} + 2>/dev/null || true

echo "backup: ${target} ($(du -h "${target}" | cut -f1))"
