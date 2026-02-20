#!/bin/sh
set -e

# ── Wait for PostgreSQL ──────────────────────────────────────
MAX_RETRIES=30
RETRY=0

echo "HealthLog: Waiting for database..."
until node -e "
  const { createConnection } = require('net');
  const url = new URL(process.env.DATABASE_URL);
  const sock = createConnection(Number(url.port) || 5432, url.hostname);
  sock.on('connect', () => { sock.destroy(); process.exit(0); });
  sock.on('error', () => process.exit(1));
" 2>/dev/null; do
  RETRY=$((RETRY + 1))
  if [ "$RETRY" -ge "$MAX_RETRIES" ]; then
    echo "HealthLog: ERROR — Database not reachable after ${MAX_RETRIES}s, aborting."
    exit 1
  fi
  sleep 1
done
echo "HealthLog: Database is reachable."

# ── Run Prisma migrations ────────────────────────────────────
echo "HealthLog: Running database migrations..."
NODE_PATH=/opt/prisma-cli/node_modules \
  node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy
echo "HealthLog: Migrations complete."

# ── Start application ────────────────────────────────────────
echo "HealthLog: Starting application..."
exec "$@"
