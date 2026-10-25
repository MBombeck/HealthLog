#!/usr/bin/env bash
# Plays the Postgres 16 -> 18 move in docker-compose.yml end to end, against
# real containers, the way an install from v1.45 meets it on its first update.
#
#   1. Start the database exactly as the v1.45 compose file had it, apply every
#      migration and add rows in a second schema.
#   2. Start the current compose file's `db-upgrade` and check the move: exit 0,
#      Postgres 18, the same rows and the same migration history.
#   3. Start it again: nothing to do.
#   4. Pretend the move was cut short after the restore: the next start must
#      empty the new database and run the move again.
#   5. Empty the new volume: it must refuse to import the old state again,
#      and move it once more after the marker is removed as the guide says.
#   6. A new install with no old volume: nothing to do.
#
# Needs Docker and the repo's node_modules (for the migrations). Run it from
# anywhere in the repo: `bash scripts/compose-db-upgrade-check.sh`.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
# The last release whose compose file ran Postgres 16.
OLD_REF=${OLD_REF:-v1.45.0}
PROJECT=hl-db-upgrade-check
PORT=${CHECK_DB_PORT:-55416}
WORK=$(mktemp -d)

export PRISMA_HIDE_UPDATE_MESSAGE=1
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(openssl rand -hex 16)
# The app service is never started here, but compose reads its environment.
export ENCRYPTION_KEY API_TOKEN_HMAC_KEY
ENCRYPTION_KEY=$(openssl rand -hex 32)
API_TOKEN_HMAC_KEY=$(openssl rand -hex 32)

git -C "$ROOT" show "$OLD_REF:docker-compose.yml" >"$WORK/old.yml"
cat >"$WORK/old-port.yml" <<EOF
services:
  db:
    ports:
      - "127.0.0.1:$PORT:5432"
EOF

old() { docker compose -p "$PROJECT" -f "$WORK/old.yml" -f "$WORK/old-port.yml" "$@"; }
new() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" "$@"; }
down_all() {
  new down -v --remove-orphans >/dev/null 2>&1 || true
  old down -v --remove-orphans >/dev/null 2>&1 || true
}
trap 'down_all; rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs healthlog-db-upgrade 2>&1 | tail -40 >&2 || true
  exit 1
}
step() { echo "== $*"; }
sql() { docker exec healthlog-db psql -U healthlog -d healthlog -v ON_ERROR_STOP=1 -Atqc "$1"; }
# Starts db-upgrade (and the database it waits for), waits for it to exit and
# prints its exit code.
run_upgrade() {
  new up -d db-upgrade >/dev/null 2>&1 || true
  docker wait healthlog-db-upgrade
}
upgrade_log() { docker logs healthlog-db-upgrade 2>&1 | grep '^db-upgrade:' || true; }

down_all
step "a v1.45 database on Postgres 16"
old up -d --wait db >/dev/null 2>&1
DATABASE_URL="postgresql://healthlog:$POSTGRES_PASSWORD@127.0.0.1:$PORT/healthlog?schema=public" \
  node "$ROOT/node_modules/prisma/build/index.js" migrate deploy --schema "$ROOT/prisma/schema.prisma" >/dev/null
old exec -T db psql -U healthlog -d healthlog -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE SCHEMA check_probe;
CREATE TABLE check_probe.rows AS
  SELECT g AS id, md5(g::text) AS value FROM generate_series(1, 50000) AS g;
SQL
probe() {
  "$@" psql -U healthlog -d healthlog -Atqc \
    "SELECT md5(string_agg(value, ',' ORDER BY id)) FROM check_probe.rows"
}
migrations() {
  "$@" psql -U healthlog -d healthlog -Atqc "SELECT count(*) FROM _prisma_migrations"
}
PROBE=$(probe old exec -T db)
MIGRATIONS=$(migrations old exec -T db)
[ "$MIGRATIONS" -gt 0 ] || fail "the migrations did not apply to the old database"
old stop db >/dev/null 2>&1
old rm -f db >/dev/null 2>&1

step "first start of the current compose file moves it"
CODE=$(run_upgrade)
upgrade_log
[ "$CODE" = 0 ] || fail "db-upgrade exited $CODE on the move"
upgrade_log | grep -q 'tables arrived with the same row counts' || fail "the move did not report its row-count check"
VERSION=$(sql "SHOW server_version_num")
[ "$VERSION" -ge 180000 ] || fail "the database runs $VERSION, expected Postgres 18"
[ "$(probe docker exec healthlog-db)" = "$PROBE" ] || fail "the probe rows differ after the move"
[ "$(migrations docker exec healthlog-db)" = "$MIGRATIONS" ] || fail "the migration history differs after the move"
[ "$(sql "SELECT count(*) FROM pg_stats WHERE schemaname = 'check_probe'")" -gt 0 ] ||
  fail "the moved tables have no planner statistics"

step "second start: nothing to do"
CODE=$(run_upgrade)
[ "$CODE" = 0 ] || fail "db-upgrade exited $CODE on a start after the move"
upgrade_log | tail -1 | grep -q 'nothing to do' || fail "the second start did not say there was nothing to do"

step "a move cut short after the restore runs again from scratch"
new down >/dev/null 2>&1
docker run --rm -v "${PROJECT}_pgdata:/old" postgres:16.15-alpine \
  mv /old/HEALTHLOG_MOVED_TO_POSTGRES_18 /old/HEALTHLOG_MOVING_TO_POSTGRES_18
CODE=$(run_upgrade)
[ "$CODE" = 0 ] || fail "db-upgrade exited $CODE when resuming a cut-short move"
upgrade_log | grep -q 'did not finish' || fail "the resumed move did not say it starts again"
[ "$(probe docker exec healthlog-db)" = "$PROBE" ] || fail "the probe rows differ after the resumed move"

step "an emptied Postgres 18 volume is not refilled from the old state"
new down >/dev/null 2>&1
docker volume rm "${PROJECT}_postgres-data" >/dev/null
CODE=$(run_upgrade)
[ "$CODE" = 1 ] || fail "db-upgrade exited $CODE with the moved marker and an empty database, expected 1"
upgrade_log | grep -q 'Not importing the old state again' || fail "the refusal did not explain itself"

step "starting over as the guide says brings the moved state back"
new run --rm --entrypoint rm db-upgrade /var/lib/postgresql/data/HEALTHLOG_MOVED_TO_POSTGRES_18 >/dev/null 2>&1
CODE=$(run_upgrade)
[ "$CODE" = 0 ] || fail "db-upgrade exited $CODE after the marker was removed"
[ "$(probe docker exec healthlog-db)" = "$PROBE" ] || fail "the probe rows differ after starting over"

step "a new install: nothing to do"
new down -v >/dev/null 2>&1
CODE=$(run_upgrade)
[ "$CODE" = 0 ] || fail "db-upgrade exited $CODE on a new install"
upgrade_log | tail -1 | grep -q 'no Postgres 16 database to move' || fail "the new install did not say there was nothing to move"

echo "OK: the Postgres 16 -> 18 move behaves in all six cases"
