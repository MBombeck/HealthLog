#!/bin/sh
set -e

# ── Validate required env vars ───────────────────────────────
# We do this in the entrypoint instead of in docker-compose.yml's
# environment block (which used to use the ${VAR:?error} syntax)
# because some hosting platforms parse compose files eagerly and
# end up storing the fallback error string as the literal value.
# Validating here guarantees a clear, deploy-platform-agnostic
# failure message before we touch the database.
missing=""
for var in DATABASE_URL SESSION_SECRET ENCRYPTION_KEY API_TOKEN_HMAC_KEY; do
  eval "value=\$$var"
  if [ -z "$value" ]; then
    missing="$missing $var"
  fi
done
if [ -n "$missing" ]; then
  echo "HealthLog: ERROR — required env vars not set:$missing" >&2
  echo "HealthLog: see .env.example for the full list and how to generate each value." >&2
  exit 1
fi

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
    echo "HealthLog: ERROR — Database not reachable after ${MAX_RETRIES}s, aborting." >&2
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
