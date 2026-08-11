#!/usr/bin/env bash
# Nightly backup: MongoDB dump + uploaded files. Run on the app server via cron:
#   0 2 * * * /opt/center-erp/scripts/backup.sh >> /var/log/center-erp-backup.log 2>&1
#
# Restore (into a scratch DB first, never straight over production):
#   tar xzf center-erp-db-YYYYmmdd-HHMMSS.tar.gz -C /tmp
#   mongorestore --db center_erp_restore_test /tmp/dump/center_erp
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/center-erp}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
MONGODB_DB="${MONGODB_DB:-center_erp}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$BACKUP_DIR"

# ---- 1. Database ----
# MONGODB_URL comes from the app's .env (same directory as docker-compose.yml).
if [ -z "${MONGODB_URL:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
  MONGODB_URL="$(grep -E '^MONGODB_URL=' "$(dirname "$0")/../.env" | cut -d= -f2- || true)"
fi
: "${MONGODB_URL:?MONGODB_URL not set and not found in ../.env}"

mongodump --uri "$MONGODB_URL" --db "$MONGODB_DB" --out "$WORK/dump" --quiet
tar czf "$BACKUP_DIR/center-erp-db-$STAMP.tar.gz" -C "$WORK" dump

# ---- 2. Uploaded files (photos, screenshots, certificates) ----
# Docker named volume by default; override UPLOADS_PATH for a bare-metal install.
UPLOADS_PATH="${UPLOADS_PATH:-/var/lib/docker/volumes/center-erp_erp_uploads/_data}"
if [ -d "$UPLOADS_PATH" ]; then
  tar czf "$BACKUP_DIR/center-erp-uploads-$STAMP.tar.gz" -C "$UPLOADS_PATH" .
else
  echo "WARN: uploads path not found at $UPLOADS_PATH — files NOT backed up"
fi

# ---- 3. Retention ----
find "$BACKUP_DIR" -name 'center-erp-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete

echo "[$(date -Is)] backup ok → $BACKUP_DIR (db + uploads, stamp $STAMP)"
ls -lh "$BACKUP_DIR" | tail -4
