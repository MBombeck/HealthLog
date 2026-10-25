#!/usr/bin/env bash
# Plays the documented disaster recovery end to end against real containers:
# a server is lost with everything on it, and a new one is rebuilt from the
# nightly database dump and the keys alone (docs/ops/disaster-recovery.md).
#
#   1. Build the app image from this checkout and start the bundled compose
#      stack with fixed throwaway keys.
#   2. Seed real data: the demo seed (documents, encrypted notes, years of
#      readings) and a Guardian with a managed profile, written by the app's
#      own code; then, through the API, a reading with an encrypted note.
#   3. Let the scheduled `database-backup` job take the dump (its cron is set
#      to every minute here) and wait for its ledger row.
#   4. Keep only the dump files, the way they would sit off the lost host,
#      and DESTROY every volume of the stack.
#   5. Start a new stack, put the dump in its backups volume and run
#      `docker compose run --rm db-restore latest` with the same keys.
#   6. Count every table against the manifest, independently of the restore.
#   7. Boot the app on the restored database and check: the health endpoint,
#      the demo login, the encrypted note read back through the API, a
#      document opened, and the Guardian still seeing the managed profile.
#
# DRILL_MUTATION breaks one step on purpose, and the drill must then fail
# (a check that cannot fail proves nothing):
#   wrong-key         restore with a different ENCRYPTION_KEY
#   skip-table        a dump whose archive lacks one table's rows (the
#                     manifest's checksum fixed up, its counts left true)
#   non-empty-target  the new app starts and migrates before the restore
#
# Needs Docker, openssl, pnpm and the repo's node_modules (for the seeds). Run it
# from anywhere in the repo: `bash scripts/compose-dr-drill.sh`.
# DRILL_IMAGE names an image to use instead of building one.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
PROJECT=hl-dr-drill
APP_PORT=${DRILL_APP_PORT:-39301}
DB_PORT=${DRILL_DB_PORT:-55419}
IMAGE=${DRILL_IMAGE:-}
MUTATION=${DRILL_MUTATION:-}
OFFSITE=${PROJECT}-offsite
WORK=$(mktemp -d)
BASE_URL="http://127.0.0.1:$APP_PORT"

case "$MUTATION" in
  "" | wrong-key | skip-table | non-empty-target) ;;
  *) echo "unknown DRILL_MUTATION: $MUTATION" >&2; exit 2 ;;
esac

export PRISMA_HIDE_UPDATE_MESSAGE=1
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(openssl rand -hex 16)
# Fixed throwaway keys: the restore gets these and nothing else of the lost
# host. Two encryption keys, the second active, so a retired key is carried.
export ENCRYPTION_KEY=""
export ENCRYPTION_KEYS='{"v1":"1111111111111111111111111111111111111111111111111111111111111111","v2":"2222222222222222222222222222222222222222222222222222222222222222"}'
export ENCRYPTION_ACTIVE_KEY_ID=v2
export API_TOKEN_HMAC_KEY=3333333333333333333333333333333333333333333333333333333333333333
export SESSION_COOKIE_SECURE=false
export NEXT_PUBLIC_APP_URL=$BASE_URL APP_URL=$BASE_URL
export DB_BACKUP_SCHEDULE="* * * * *"

step() { echo "== $*"; }
fail() {
  echo "FAIL: $*" >&2
  docker logs "$PROJECT-app" 2>&1 | tail -40 >&2 || true
  exit 1
}

if [ -z "$IMAGE" ]; then
  IMAGE=healthlog-dr-drill:local
  step "building the app image from this checkout"
  docker build -q \
    --build-arg NEXT_PUBLIC_APP_VERSION="drill-$(git -C "$ROOT" rev-parse --short HEAD)" \
    --build-arg NEXT_PUBLIC_APP_BUILD_SHA="$(git -C "$ROOT" rev-parse --short HEAD)" \
    -t "$IMAGE" "$ROOT" >/dev/null
fi

# The bundled compose file, with this image, its own names and ports, so the
# drill never meets another stack on the same machine.
cat >"$WORK/drill.yml" <<EOF
services:
  app:
    image: $IMAGE
    pull_policy: never
    container_name: $PROJECT-app
    ports: !override
      - "127.0.0.1:$APP_PORT:3000"
  db:
    container_name: $PROJECT-db
    ports:
      - "127.0.0.1:$DB_PORT:5432"
  db-upgrade:
    container_name: $PROJECT-db-upgrade
  db-restore:
    image: $IMAGE
    pull_policy: never
EOF

stack() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$WORK/drill.yml" "$@"; }
sql() { docker exec "$PROJECT-db" psql -U healthlog -d healthlog -v ON_ERROR_STOP=1 -Atqc "$1"; }
teardown() {
  stack down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$OFFSITE" >/dev/null 2>&1 || true
}
trap 'teardown; rm -rf "$WORK"' EXIT

wait_healthy() {
  local i=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/health")" = 200 ]; do
    i=$((i + 1))
    [ "$i" -lt 150 ] || fail "the app did not report healthy within five minutes"
    docker inspect -f '{{.State.Running}}' "$PROJECT-app" 2>/dev/null | grep -q true ||
      fail "the app container stopped"
    sleep 2
  done
}

# POST/GET as a signed-in account, with its own cookie jar.
login() {
  local jar=$1 user=$2 password=$3
  local code
  code=$(curl -s -o "$WORK/login.json" -w '%{http_code}' -c "$jar" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$user\",\"password\":\"$password\"}" "$BASE_URL/api/auth/login")
  [ "$code" = 200 ] || fail "login as $user answered $code: $(cat "$WORK/login.json")"
}
api() { curl -s -b "$1" -w '\n%{http_code}' "${@:2}"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log((${1})(v))})"; }

# A shell in the app image as root, with two volumes, for moving the dump
# files the way an operator copies them; `cp -p` keeps the app user as owner.
as_root() {
  local command=$1 mounts=()
  shift
  for volume in "$@"; do mounts+=(-v "$volume"); done
  docker run --rm --user 0:0 --entrypoint sh "${mounts[@]}" "$IMAGE" -c "$command"
}

teardown

step "a running server with real data"
stack up -d app >"$WORK/up.log" 2>&1 || { tail -20 "$WORK/up.log" >&2; fail "the stack did not start"; }
wait_healthy
DATABASE_URL="postgresql://healthlog:$POSTGRES_PASSWORD@127.0.0.1:$DB_PORT/healthlog?schema=public"
export DATABASE_URL
(cd "$ROOT" && pnpm dlx tsx@4.23.1 scripts/seed-demo.ts) >"$WORK/seed.log" 2>&1 ||
  { tail -20 "$WORK/seed.log" >&2; fail "the demo seed failed"; }
IDS=$(cd "$ROOT" && pnpm dlx tsx@4.23.1 scripts/dr-drill-seed.ts | tail -1)
PROFILE_ID=$(echo "$IDS" | json 'v=>v.profileId')
unset DATABASE_URL

login "$WORK/demo.jar" demo demo123demo123
NOTE="drill note $(openssl rand -hex 6)"
OUT=$(api "$WORK/demo.jar" -H 'content-type: application/json' \
  -d "{\"type\":\"WEIGHT\",\"value\":81.4,\"measuredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"notes\":\"$NOTE\"}" \
  "$BASE_URL/api/measurements")
[ "$(echo "$OUT" | tail -1)" = 201 ] || [ "$(echo "$OUT" | tail -1)" = 200 ] ||
  fail "creating a reading with a note answered: $OUT"
READING_ID=$(echo "$OUT" | sed '$d' | json 'v=>v.data.id')
[ "$(sql "SELECT count(*) FROM measurements WHERE id = '$READING_ID' AND position('$NOTE' in measurements::text) > 0")" = 0 ] ||
  fail "the note is stored in plain text"
DOCUMENTS=$(sql "SELECT count(*) FROM inbound_documents WHERE deleted_at IS NULL")
[ "$DOCUMENTS" -gt 0 ] || fail "the seed wrote no documents"
SEEDED_AT=$(sql "SELECT now()")

step "the scheduled job takes the dump"
i=0
until DUMP=$(sql "SELECT file_name FROM database_backup_runs WHERE status = 'succeeded' AND started_at > '$SEEDED_AT'::timestamptz ORDER BY started_at DESC LIMIT 1") && [ -n "$DUMP" ]; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || fail "no succeeded database-backup run within four minutes: $(sql "SELECT status, error FROM database_backup_runs ORDER BY started_at DESC LIMIT 3")"
  sleep 2
done
BASE=${DUMP%.dump}
echo "   $DUMP"

step "only the dump leaves the host, then every volume is destroyed"
docker volume create "$OFFSITE" >/dev/null
as_root "cp -p /from/$BASE.dump /from/$BASE.manifest.json /to/" \
  "${PROJECT}_backups:/from:ro" "$OFFSITE:/to" ||
  fail "could not copy the dump off the host"
stack down -v --remove-orphans >/dev/null 2>&1
[ -z "$(docker volume ls -q --filter "name=^${PROJECT}_")" ] || fail "a volume of the old stack survived"

if [ "$MUTATION" = skip-table ]; then
  step "MUTATION: the dump loses the rows of public.measurements"
  # A scratch Postgres restores the real dump and dumps it again without that
  # table's rows; the files stay the app user's, read and written by root.
  docker run --rm -v "$OFFSITE:/d" -e BASE="$BASE" --entrypoint sh postgres:18.6-alpine -ec '
    gosu postgres initdb -D /tmp/pg >/dev/null
    gosu postgres pg_ctl -D /tmp/pg -o "-c listen_addresses=" -w start >/dev/null
    gosu postgres createdb scratch
    gosu postgres pg_restore --no-owner --no-privileges -d scratch <"/d/$BASE.dump"
    gosu postgres pg_dump -Fc --exclude-table-data=public.measurements scratch >"/d/$BASE.dump"
    sum=$(sha256sum "/d/$BASE.dump" | cut -d" " -f1)
    size=$(wc -c <"/d/$BASE.dump")
    sed -i "s/\"sha256\": \"[0-9a-f]*\"/\"sha256\": \"$sum\"/; s/\"bytes\": [0-9]*/\"bytes\": $size/" "/d/$BASE.manifest.json"
    chown 1001:1001 "/d/$BASE.dump"' || fail "could not build the mutated dump"
fi

step "a new server: the compose file, the keys and the dump"
if [ "$MUTATION" = wrong-key ]; then
  echo "   MUTATION: the restore gets a different active encryption key"
  ENCRYPTION_KEYS='{"v1":"1111111111111111111111111111111111111111111111111111111111111111","v2":"4444444444444444444444444444444444444444444444444444444444444444"}'
fi
# Mounting the image's directory fills the new volume with the app user's
# ownership; then the two files go in.
stack run --rm --no-deps --entrypoint true db-restore >/dev/null 2>&1
as_root "cp -p /from/* /to/" "$OFFSITE:/from:ro" "${PROJECT}_backups:/to" ||
  fail "could not put the dump on the new server"
if [ "$MUTATION" = non-empty-target ]; then
  echo "   MUTATION: the new app starts (and migrates) before the restore"
  stack up -d app >/dev/null 2>&1
  wait_healthy
fi
stack up -d db >/dev/null 2>&1
if ! stack run --rm db-restore latest 2>&1 | tee "$WORK/restore.log"; then
  fail "the restore failed"
fi
grep -q "^Restored $DUMP" "$WORK/restore.log" || fail "the restore did not say it restored $DUMP"

step "every table against the manifest, counted apart from the restore"
as_root "cat /d/$BASE.manifest.json" "$OFFSITE:/d:ro" >"$WORK/manifest.json"
node -e '
  const m = require(process.argv[1]);
  const q = String.fromCharCode(39);
  const lit = (t) => q + t.split(q).join(q + q) + q;
  console.log(Object.keys(m.rowCounts).map((t) => `SELECT ${lit(t)} || chr(9) || count(*) FROM ${t}`).join(" UNION ALL ") + ";");
' "$WORK/manifest.json" >"$WORK/count.sql"
docker exec -i "$PROJECT-db" psql -U healthlog -d healthlog -v ON_ERROR_STOP=1 -Atq <"$WORK/count.sql" >"$WORK/counts.tsv"
node -e '
  const fs = require("node:fs");
  const m = require(process.argv[1]);
  const got = Object.fromEntries(fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => l.split("\t")).map(([t, n]) => [t, Number(n)]));
  const bad = Object.entries(m.rowCounts).filter(([t, n]) => got[t] !== n);
  if (bad.length) { console.error(bad.map(([t, n]) => `${t}: manifest ${n}, database ${got[t]}`).join("\n")); process.exit(1); }
  if (m.rowCounts["public.users"] < 3) { console.error("fewer than three accounts in the dump"); process.exit(1); }
  const c = m.rowCounts;
  console.log(`   ${Object.keys(c).length} tables, ${Object.values(c).reduce((a, b) => a + b, 0)} rows: ` +
    `${c["public.users"]} accounts, ${c["public.account_grants"]} grants, ${c["public.measurements"]} readings, ` +
    `${c["public.inbound_documents"]} documents, ${c["pgboss.job"] ?? 0} queued jobs`);
' "$WORK/manifest.json" "$WORK/counts.tsv" || fail "the restored row counts differ from the manifest"

step "the app on the restored database"
stack up -d app >/dev/null 2>&1 || fail "the app did not start on the restored database"
wait_healthy
[ "$(curl -s "$BASE_URL/api/health" | json 'v=>v.status ?? v.data?.status')" = ok ] || fail "health is not ok"

login "$WORK/demo2.jar" demo demo123demo123
OUT=$(api "$WORK/demo2.jar" "$BASE_URL/api/measurements/$READING_ID")
[ "$(echo "$OUT" | tail -1)" = 200 ] || fail "reading the note back answered: $OUT"
[ "$(echo "$OUT" | sed '$d' | json 'v=>v.data.notes')" = "$NOTE" ] || fail "the encrypted note did not read back"
echo "   the encrypted note reads back"

OUT=$(api "$WORK/demo2.jar" "$BASE_URL/api/documents/inbound")
[ "$(echo "$OUT" | tail -1)" = 200 ] || fail "listing documents answered: $OUT"
DOC_ID=$(echo "$OUT" | sed '$d' | json 'v=>(v.data.documents ?? v.data.items ?? v.data)[0].id')
CODE=$(curl -s -b "$WORK/demo2.jar" -o "$WORK/doc.bin" -w '%{http_code}' "$BASE_URL/api/documents/inbound/$DOC_ID/original")
[ "$CODE" = 200 ] || fail "opening document $DOC_ID answered $CODE"
[ "$(head -c 4 "$WORK/doc.bin")" = "%PDF" ] || fail "document $DOC_ID did not open to a PDF"
echo "   a document opens ($(wc -c <"$WORK/doc.bin" | tr -d ' ') bytes)"

login "$WORK/guardian.jar" drill-guardian drill-guardian-password-1
OUT=$(api "$WORK/guardian.jar" "$BASE_URL/api/account/grants")
[ "$(echo "$OUT" | tail -1)" = 200 ] || fail "listing the Guardian's grants answered: $OUT"
echo "$OUT" | sed '$d' | node -e "
  let s=''; process.stdin.on('data', d => s += d).on('end', () => {
    const received = JSON.parse(s).data.received ?? [];
    const found = received.some((g) => JSON.stringify(g).includes('$PROFILE_ID'));
    process.exit(found ? 0 : 1);
  });" || fail "the Guardian no longer sees the managed profile"
echo "   the Guardian still sees the managed profile"

echo "OK: the server was rebuilt from the dump and the keys alone"
