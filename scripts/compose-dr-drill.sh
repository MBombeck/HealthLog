#!/usr/bin/env bash
# Plays the documented disaster recovery end to end against real containers:
# a server is lost with everything on it, and a new one is rebuilt from the
# nightly database dump and the keys alone (docs/ops/disaster-recovery.md).
#
#   1. Build the app image from this checkout and start the bundled compose
#      stack with fixed throwaway keys, and an S3-compatible bucket outside
#      it (Versity S3 Gateway, pinned) as the off-host target.
#      First without the `backups` volume: the run must keep nothing in the
#      container's layer, say so in its ledger row and the start log, and
#      still upload the dump. Then the stack is thrown away and started again
#      as shipped.
#   2. Seed real data: the demo seed (documents, encrypted notes, years of
#      readings) and a Guardian with a managed profile, written by the app's
#      own code; then, through the API, a reading with an encrypted note.
#   3. Let the scheduled `database-backup` job take the dump (its cron is set
#      to every minute here) and wait for its ledger row: kept on the server
#      and uploaded to the bucket.
#   4. DESTROY every volume of the stack, the local dumps included. The
#      bucket lives outside the stack and survives, as an off-host copy does.
#   5. Start a new stack and restore with the keys alone:
#      DRILL_SOURCE=bucket (the default, the disaster path)
#        `docker compose run --rm db-restore latest --from-bucket`;
#      DRILL_SOURCE=local (the dump files had been copied off the host)
#        the files go into the new backups volume, then
#        `docker compose run --rm db-restore latest`.
#   6. Count every table against the manifest, independently of the restore.
#   7. Boot the app on the restored database and check: the health endpoint,
#      the demo login, the encrypted note read back through the API, a
#      document opened, and the Guardian still seeing the managed profile.
#
# DRILL_MUTATION breaks one step on purpose, and the drill must then fail
# (a check that cannot fail proves nothing):
#   wrong-key         restore with a different active encryption key
#   wrong-backup-key  restore from the bucket with a different
#                     BACKUP_ENCRYPTION_KEY (DRILL_SOURCE=bucket)
#   skip-table        a dump whose archive lacks one table's rows, the
#                     manifest's checksum fixed up and its counts left true
#                     (DRILL_SOURCE=local)
#   non-empty-target  the new app starts and migrates before the restore
#
# Needs Docker, openssl, pnpm and the repo's node_modules (for the seeds). Run
# it from anywhere in the repo: `bash scripts/compose-dr-drill.sh`.
# DRILL_IMAGE names an image to use instead of building one. The ports are
# free ones picked at start unless DRILL_APP_PORT, DRILL_DB_PORT or
# DRILL_BUCKET_PORT name them.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
PROJECT=hl-dr-drill
free_port() {
  node -e "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}
APP_PORT=${DRILL_APP_PORT:-$(free_port)}
DB_PORT=${DRILL_DB_PORT:-$(free_port)}
BUCKET_PORT=${DRILL_BUCKET_PORT:-$(free_port)}
IMAGE=${DRILL_IMAGE:-}
MUTATION=${DRILL_MUTATION:-}
SOURCE=${DRILL_SOURCE:-bucket}
OFFSITE=$PROJECT-offsite
BUCKET=$PROJECT-bucket
BUCKET_IMAGE=versity/versitygw:v1.8.0@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499
WORK=$(mktemp -d)
BASE_URL="http://127.0.0.1:$APP_PORT"

case "$SOURCE/$MUTATION" in
  bucket/ | local/ | */wrong-key | */non-empty-target | bucket/wrong-backup-key | local/skip-table) ;;
  *)
    echo "DRILL_SOURCE=$SOURCE with DRILL_MUTATION=$MUTATION is not a drill" >&2
    exit 2
    ;;
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
# The off-host bucket, reached from the stack by its container name on a
# network of its own that outlives the stack, as a real bucket does.
export BACKUP_S3_ENDPOINT=http://$BUCKET:7070
export BACKUP_S3_BUCKET=healthlog-backups
export BACKUP_S3_ACCESS_KEY=drill-access
export BACKUP_S3_SECRET_KEY=drill-secret-0123456789
export BACKUP_S3_REGION=us-east-1
export BACKUP_ENCRYPTION_KEY=5555555555555555555555555555555555555555555555555555555555555555

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
# drill never meets another stack on the same machine, and the app and the
# restore on the bucket's network.
cat >"$WORK/drill.yml" <<YAML
services:
  app:
    image: $IMAGE
    pull_policy: never
    container_name: $PROJECT-app
    ports: !override
      - "127.0.0.1:$APP_PORT:3000"
    networks: [default, bucket]
  db:
    container_name: $PROJECT-db
    ports:
      - "127.0.0.1:$DB_PORT:5432"
  db-upgrade:
    container_name: $PROJECT-db-upgrade
  db-restore:
    image: $IMAGE
    pull_policy: never
    networks: [default, bucket]
networks:
  bucket:
    external: true
    name: $BUCKET
YAML

stack() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$WORK/drill.yml" "$@"; }
sql() { docker exec "$PROJECT-db" psql -U healthlog -d healthlog -v ON_ERROR_STOP=1 -Atqc "$1"; }
teardown() {
  stack down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$OFFSITE" >/dev/null 2>&1 || true
  docker rm -f "$BUCKET" >/dev/null 2>&1 || true
  docker volume rm "$BUCKET-data" >/dev/null 2>&1 || true
  docker network rm "$BUCKET" >/dev/null 2>&1 || true
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

# A shell in the app image as root, with volumes, for moving the dump files
# the way an operator copies them; `cp -p` keeps the app user as owner.
as_root() {
  local command=$1 mounts=()
  shift
  for volume in "$@"; do mounts+=(-v "$volume"); done
  docker run --rm --user 0:0 --entrypoint sh "${mounts[@]}" "$IMAGE" -c "$command"
}

teardown

step "an off-host bucket, outside the stack"
docker network create "$BUCKET" >/dev/null
docker run -d --name "$BUCKET" --network "$BUCKET" -p "127.0.0.1:$BUCKET_PORT:7070" \
  -v "$BUCKET-data:/data" --entrypoint sh "$BUCKET_IMAGE" -c \
  "mkdir -p /data/$BACKUP_S3_BUCKET && exec versitygw --access $BACKUP_S3_ACCESS_KEY --secret $BACKUP_S3_SECRET_KEY posix /data" \
  >/dev/null || fail "the bucket did not start"

step "a server without the backups volume keeps no dump on itself"
# The image creates the dump directory, so without the volume it is writable,
# and it sits in the container's layer that the next update throws away. No
# dump may be kept, or counted as kept, there; the bucket still gets one.
cat >"$WORK/no-volume.yml" <<YAML
services:
  app:
    volumes: !reset []
YAML
stack -f "$WORK/no-volume.yml" up -d app >"$WORK/up.log" 2>&1 ||
  { tail -20 "$WORK/up.log" >&2; fail "the stack without the volume did not start"; }
wait_healthy
i=0
until RUN=$(sql "SELECT status || ' ' || local_result || ' ' || offhost_result FROM database_backup_runs WHERE status <> 'running' ORDER BY started_at DESC LIMIT 1") && [ -n "$RUN" ]; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || fail "no database-backup run within four minutes without the volume"
  sleep 2
done
[ "$RUN" = "succeeded not_persistent uploaded" ] ||
  fail "without the volume the run read '$RUN', not 'succeeded not_persistent uploaded'"
LEFT=$(docker exec "$PROJECT-app" sh -c 'ls -A /var/lib/healthlog/backups')
[ -z "$LEFT" ] || fail "a dump was left in the container's layer: $LEFT"
# Into a file first: `grep -q` stops reading at the match, and with pipefail
# the SIGPIPE that leaves `docker logs` would read as a miss.
docker logs "$PROJECT-app" >"$WORK/no-volume.log" 2>&1
grep -q "is inside the container, not on a mounted volume" "$WORK/no-volume.log" ||
  fail "the start log does not say the dump directory is inside the container"
echo "   $RUN, nothing in the container's layer"
stack down -v --remove-orphans >/dev/null 2>&1

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

step "the scheduled job takes the dump and uploads it"
i=0
until DUMP=$(sql "SELECT file_name FROM database_backup_runs WHERE status = 'succeeded' AND local_result = 'written' AND offhost_result = 'uploaded' AND started_at > '$SEEDED_AT'::timestamptz ORDER BY started_at DESC LIMIT 1") && [ -n "$DUMP" ]; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || fail "no succeeded and uploaded database-backup run within four minutes: $(sql "SELECT status, local_result, offhost_result, error FROM database_backup_runs ORDER BY started_at DESC LIMIT 3")"
  sleep 2
done
BASE=${DUMP%.dump}
echo "   $DUMP"

if [ "$SOURCE" = local ]; then
  step "the dump files are copied off the host"
  docker volume create "$OFFSITE" >/dev/null
  as_root "cp -p /from/$BASE.dump /from/$BASE.manifest.json /to/" \
    "${PROJECT}_backups:/from:ro" "$OFFSITE:/to" ||
    fail "could not copy the dump off the host"
fi

step "the host is lost: every volume of the stack is destroyed"
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

step "a new server: the compose file, the keys and the $SOURCE copy"
if [ "$MUTATION" = wrong-key ]; then
  echo "   MUTATION: the restore gets a different active encryption key"
  ENCRYPTION_KEYS='{"v1":"1111111111111111111111111111111111111111111111111111111111111111","v2":"4444444444444444444444444444444444444444444444444444444444444444"}'
fi
if [ "$MUTATION" = wrong-backup-key ]; then
  echo "   MUTATION: the restore gets a different BACKUP_ENCRYPTION_KEY"
  BACKUP_ENCRYPTION_KEY=6666666666666666666666666666666666666666666666666666666666666666
fi
if [ "$SOURCE" = local ]; then
  # Mounting the image's directory fills the new volume with the app user's
  # ownership; then the two files go in.
  stack run --rm --no-deps --entrypoint true db-restore >/dev/null 2>&1
  as_root "cp -p /from/* /to/" "$OFFSITE:/from:ro" "${PROJECT}_backups:/to" ||
    fail "could not put the dump on the new server"
  RESTORE=(latest)
else
  RESTORE=(latest --from-bucket)
fi
if [ "$MUTATION" = non-empty-target ]; then
  echo "   MUTATION: the new app starts (and migrates) before the restore"
  stack up -d app >/dev/null 2>&1
  wait_healthy
fi
stack up -d db >/dev/null 2>&1
if ! stack run --rm db-restore "${RESTORE[@]}" 2>&1 | tee "$WORK/restore.log"; then
  fail "the restore failed"
fi
grep -q "^Restored $DUMP" "$WORK/restore.log" || fail "the restore did not say it restored $DUMP"

step "every table against the manifest, counted apart from the restore"
if [ "$SOURCE" = local ]; then
  as_root "cat /d/$BASE.manifest.json" "$OFFSITE:/d:ro" >"$WORK/manifest.json"
else
  # From the bucket, opened with the restore's own reader.
  (cd "$ROOT" && node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    const core = await import(join(process.cwd(), "src/lib/database-backup/dump-core.mjs"));
    const [port, base, work] = process.argv.slice(1);
    const bucket = await core.openBucket({ ...core.bucketConfigFromEnv(process.env), endpoint: `http://127.0.0.1:${port}` });
    const name = `${base}.manifest.json.enc`;
    const key = core.offhostObjectKey(name, core.instanceIdFromEnv(process.env));
    await bucket.download(key, join(work, name));
    await core.decryptOffhostFile({ inPath: join(work, name), outPath: join(work, "manifest.json"), objectKey: key, keys: core.offhostKeysFromEnv(process.env) });
  ' "$BUCKET_PORT" "$BASE" "$WORK") || fail "could not read the manifest from the bucket"
fi
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

echo "OK: the server was rebuilt from the $SOURCE copy of its dump and the keys alone"
