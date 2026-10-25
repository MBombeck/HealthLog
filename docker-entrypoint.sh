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
for var in DATABASE_URL API_TOKEN_HMAC_KEY; do
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

# ENCRYPTION_KEYS supersedes the legacy single key, so validate the same
# fail-closed shape the runtime crypto loader accepts before touching the DB.
if ! node -e '
  const validKey = (value) => {
    if (typeof value !== "string") return false;
    if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
    if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;
    try { return Buffer.from(value, "base64").length === 32; }
    catch { return false; }
  };
  const rawKeyring = (process.env.ENCRYPTION_KEYS || "").trim();
  if (rawKeyring) {
    let keyring;
    try { keyring = JSON.parse(rawKeyring); }
    catch { throw new Error("ENCRYPTION_KEYS is invalid JSON"); }
    if (!keyring || typeof keyring !== "object" || Array.isArray(keyring)) {
      throw new Error("ENCRYPTION_KEYS is invalid: expected an object map");
    }
    const entries = Object.entries(keyring);
    if (
      entries.length === 0 ||
      entries.some(([id, value]) =>
        !/^[A-Za-z0-9_-]{1,32}$/.test(id) || !validKey(value)
      )
    ) {
      throw new Error("ENCRYPTION_KEYS is invalid: every entry must be a valid 32-byte key");
    }
    const activeId =
      (process.env.ENCRYPTION_ACTIVE_KEY_ID || "").trim() ||
      (entries.length === 1 ? entries[0][0] : "");
    if (!activeId || !Object.prototype.hasOwnProperty.call(keyring, activeId)) {
      throw new Error("ENCRYPTION_ACTIVE_KEY_ID must name an entry in ENCRYPTION_KEYS");
    }
  } else if (!validKey((process.env.ENCRYPTION_KEY || "").trim())) {
    throw new Error("ENCRYPTION_KEY is missing or invalid");
  }
'; then
  echo "HealthLog: ERROR — encryption configuration is invalid." >&2
  echo "HealthLog: set a valid ENCRYPTION_KEY or ENCRYPTION_KEYS with ENCRYPTION_ACTIVE_KEY_ID." >&2
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
# Say how many migrations this image is about to apply, with a reminder to
# back up first. Reporting only: it never stops the boot.
node scripts/pending-migrations.mjs || true
# When migrations are pending, dump the database into DB_BACKUP_DIR first, so
# the state before them can be restored (docs/ops/disaster-recovery.md). No
# writable directory: a warning, and the boot goes on. A writable directory
# and a failed dump: the boot stops here, before anything is migrated.
if ! node scripts/db-dump.mjs pre-migration; then
  echo "HealthLog: ERROR — not migrating without the dump. Free disk space or fix the error above and start again." >&2
  echo "HealthLog: to migrate without a dump this once, set DB_BACKUP_BEFORE_MIGRATE=false." >&2
  exit 1
fi
# `migrate-deploy.mjs` runs `prisma migrate deploy` and retries only a
# migration that timed out on a lock and is marked safe to re-run; any other
# failure stops the boot with Prisma's exit code (docs/ops/deploy.md).
echo "HealthLog: Running database migrations..."
NODE_PATH=/opt/prisma-cli/node_modules \
  node scripts/migrate-deploy.mjs
echo "HealthLog: Migrations complete."

# ── Start application ────────────────────────────────────────
echo "HealthLog: Starting application..."
exec "$@"
