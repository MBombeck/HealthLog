# Deploy ordering

Coolify handles the standard deploy ordering automatically: the
container image is pulled, `docker-entrypoint.sh` runs
`prisma migrate deploy` against the live database, and only then does
the Next.js process bind to the listener. This page documents the
ordering explicitly for manual-rollback and partial-deploy scenarios
where the operator drives the steps by hand.

## Migration ordering

Migrations land **before** the new app container takes traffic. The
canonical command sequence on a single-instance host:

```sh
# 0. Nothing to do by hand for the way back: when the new image brings
#    migrations, its entrypoint first writes
#    healthlog-<time>-pre-migration.dump into DB_BACKUP_DIR (the `backups`
#    volume) and keeps the last two. A migration is not undone by going back
#    to the previous image; that dump is the way back
#    (docs/ops/disaster-recovery.md, "Going back to before a migration").
#    Copy it off the host if the host itself is what you are worried about.

# 1. Pull the new image. If you pin a version with HEALTHLOG_IMAGE_REF,
#    set it to the new one first.
docker compose pull app

# 2. Run the migrations with the new image before it takes traffic. The
#    one-off container starts inside the stack, so it reaches the database
#    as `db` and gets the same environment as the app. Its entrypoint
#    applies the migrations and exits; a failed migration stops here.
docker compose run --rm app sh -c 'exit 0'

# 3. Recreate the app container so it picks up the new image.
docker compose up -d app
```

Step 2 takes the pre-migration dump too, in the one-off container, before it
migrates. When the backups directory is writable and that dump fails (a full
disk, most often), the entrypoint stops before migrating and says so; free
the space and run the step again, or set `DB_BACKUP_BEFORE_MIGRATE=false` for
one start without the dump. Without a writable directory (an install that
runs the image without the `backups` volume) the log carries a warning, no
dump is taken, and the migrations run.

Use `docker compose run` rather than a plain `docker run` for step 2. A
plain `docker run` starts outside the stack's network, where `db` does not
resolve, and the entrypoint gives up after thirty seconds with "Database
not reachable". The entrypoint also runs the migrations on every boot, so
step 2 is optional; it is there for when you want to see the migration
result before the new container takes traffic.

The entrypoint runs every migration in a UTC session, the zone the app's own
connections use, whatever the database's default `TimeZone` is: it adds
`-c TimeZone=UTC` to the `options` parameter of `DATABASE_URL` for the Prisma
calls (an `options` value you set yourself is kept, with the pin after it).
Behind a connection pooler that refuses `options`, the
`DATABASE_SESSION_OPTIONS_DISABLED` switch turns this off along with the
app's own session settings; set the database or role default to UTC there
(`ALTER DATABASE healthlog SET timezone = 'UTC'`).

### A migration that timed out on a lock

Some migrations bound how long they wait for a table lock, so that a
long-running holder (most often an autovacuum that is preventing
transaction-ID wraparound, which does not step aside) cannot queue every
write to that table behind the migration. Migration `0412` waits at most ten
seconds for `measurements`. When the wait runs out, the boot log shows
Prisma's report followed by a line from the entrypoint:

```
Error: P3018
...
Migration name: 0412_measurement_hot_updates

Database error code: 55P03
...
HealthLog: migration 0412_measurement_hot_updates timed out waiting for a lock (55P03) and changed nothing; marking it rolled back and retrying in 15s (retry 1 of 5).
```

A marked migration that loses a deadlock against an app transaction
(`Database error code: 40P01`) is in the same state, its block rolled back
whole, and is handled the same way; the entrypoint's line then says
`was cancelled in a deadlock (40P01)`.

What happens on its own: such a migration is written so that a timed-out
attempt changes nothing, and it says so in its file
(`-- @retry-on-lock-timeout`). The entrypoint then marks that one migration
rolled back (`prisma migrate resolve --rolled-back`) and runs
`migrate deploy` again after 15, 30, 60, 120 and 240 seconds. The app starts
as soon as an attempt gets the lock. A later boot that finds the attempt still
on record (Prisma's `P3009`) reads the cause from `_prisma_migrations` and
does the same. Nothing else is retried: any other failure, and a lock timeout
in a migration that does not carry the marker, stops the boot exactly as
before.

The retries fit inside the container's health check: its start period is ten
minutes (`docker-compose.yml` and the image's own `HEALTHCHECK`), so failed
probes while the entrypoint is still migrating do not mark the container
unhealthy. The first probe that answers ends the start period, so a normal
boot is reported healthy within half a minute of the server listening.

If all five retries time out, the log ends with
`HealthLog: ERROR — migration … timed out on a lock 6 times in a row; giving
up.` and the container exits. Something has held the table for about eight
minutes. Find it:

```sh
docker compose exec db psql -U healthlog -c "
  SELECT pid, backend_type, state, now() - xact_start AS running, query
    FROM pg_stat_activity
   WHERE pid IN (SELECT pid FROM pg_locks
                  WHERE relation = 'measurements'::regclass)"
```

An `autovacuum: VACUUM … (to prevent wraparound)` row finishes on its own;
wait for it to disappear and start the container again (a restart policy does
that for you, and each boot retries). Anything else is a session you can
judge: a stuck client may be ended with `SELECT pg_terminate_backend(<pid>)`.
You never need to run `migrate resolve` by hand for this case.

### A concurrent index build that failed

A migration that builds an index `CONCURRENTLY` (0477 is one) and fails
half-way, on a constraint violation, a cancel or a killed container, leaves an
INVALID index behind and its attempt on record as failed. Once you have mended
the cause and run `prisma migrate resolve --rolled-back <migration>`, the next
boot drops that INVALID index before it migrates, logs
`dropped the invalid index …`, and the re-run builds it again. Without that
step the re-run would find the index by name and skip it.

A build that is still running looks the same, INVALID with its migration not
yet finished. The boot therefore leaves every index alone while another
instance is migrating (it checks Prisma's migration lock first) and never
drops an index Postgres reports as being built, so a second container that
starts during the first one's migration cannot cancel it.

An INVALID index whose migration is already recorded applied is not touched at
boot. The boot names it on stderr with `WARNING — index … is INVALID`; rebuild
it with `REINDEX INDEX CONCURRENTLY "<index>";` when the database is quiet.

### v1.46.0 notes

- **Postgres 18.** The compose file moves the bundled database from
  Postgres 16 to 18. The first `docker compose up -d` with the new compose
  file runs `db-upgrade`, which copies the database into a new
  `postgres-data` volume, checks every table's row count, and only then lets
  the app start; the old `pgdata` volume stays as it was, as the way back.
  Pulling only the new image with the old compose file keeps 16, which this
  release still runs on. Details, rollback and the steps for a database you
  run yourself: [postgres-major-upgrade.md](postgres-major-upgrade.md).
- Migration `0485` drops `preview_features_json` from `users`, the same
  pattern as `0430` in v1.44.0 below: do not run the previous image beside
  the new schema. The sequence above stops the old container first; a
  web/worker split stops both roles before the first new container starts.
- The other migrations add columns and one index (built concurrently).
  Three touch rows: `0476` links API-written measurements to their token on
  accounts that have exactly one measurement token, and `0478`/`0479` give
  PDFs whose preview or text read failed one more attempt. On a prod-sized
  copy all of them together finished in under a second.

### v1.45.0 notes

A single-container install (`HEALTHLOG_PROCESS_TYPE=all`, the shipped
compose file) needs no action: the sequence above applies the one migration
and the job-queue upgrade on the first boot.

- Migration `0471` adds one nullable column to `healthkit_type_syncs`. It is
  additive and rewrites no rows.
- The job queue library moves its own schema from version 45 to 46 (new
  columns on its queue table, four indexes built concurrently afterwards).
  Only a worker process runs that upgrade; a web-only process opens its
  send-only connection without migrating and refuses a schema older than
  its own (`pg-boss database requires migrations`), so it cannot queue
  anything until the upgrade has run. A web/worker split therefore deploys
  in this order: stop both roles, start the new **worker** and wait until its
  startup log line carries `"reminder_worker": "started"`, then start the new
  web containers.
  The other order leaves the web containers without a queue (imports and
  document reads answer `503 Background worker is not running`) until they
  are restarted after the worker. An old web container left running beside
  the upgraded schema loses its queue the next time it reconnects.
- The shipped compose file gives the app `stop_grace_period: 45s`, so a
  redeploy lets running jobs finish instead of cutting them off after
  Docker's default ten seconds. A forked or older compose file should add the
  same line to the app and worker services.

### v1.44.0 notes

Migration `0430` drops the `insights_cached_text` column from `users`. A
process still running the previous image selects that column on every full
user read and fails once it is gone, so do not run old and new containers side
by side across this release: stop the old app container, let the new one
apply the migrations, then start it (the sequence above does this on a single
host). A web/worker split deployment stops both roles before the first new
container starts. Rolling back to an image older than v1.44.0 needs the column
back first (see Rollback below).

### v1.11.0 notes

Migrations `0110`–`0114` are additive (new tables / columns for the
WHOOP provider hub, the longitudinal coach, and the clinician FHIR
record). They require no special steps — `prisma migrate deploy` runs
them in order on boot like any other.

WHOOP introduces two optional instance env vars, `WHOOP_REDIRECT_URI`
and `WHOOP_WEBHOOK_SECRET` (HMAC secret for WHOOP webhook signature
verification). Per-user WHOOP client id/secret live in Settings, not
in the environment. See `docs/integrations/whoop.md`. The shipped
`docker-compose.yml` already whitelists both under `environment:`; only
a forked or older compose file needs them added by hand, since vars not
on the whitelist never reach the container.

### What goes wrong if you reverse it

If the new app container starts before migrations run, the legacy
schema is missing the columns / indexes / enum values the new code
expects. Symptoms: Prisma client throws `P2022 column does not exist`
on the first query that touches the new shape, the request path 500s,
and the dispatcher logs fill with the same error until the migration
catches up. Health checks usually keep the container marked "healthy"
because `/api/version` doesn't exercise the affected tables — so a
naïve load balancer will happily route real traffic into the broken
shell.

### Rollback

Rolling back **migrations** is generally one-way. Prisma's migration
history table tracks applied migrations by hash; the `down` step is
not auto-generated and most HealthLog migrations are forward-only
(column drops, enum additions, index rebuilds). If a release has to
roll back:

1. Roll back the **app container** to the previous image tag.
2. Leave the **database schema** at the newer migration. The previous
   app version reads forward-compatible-ish shapes for nearly every
   release pair shipped on the v1.4.x line.
3. If a column-drop migration ships in the rollback target, hand-roll
   the column back via a fresh forward migration (`pnpm prisma migrate
dev --create-only --name vX_Y_Z_rollback_<col>`), edit the SQL,
   commit, and re-deploy. Never `migrate resolve --rolled-back` against
   production unless you've taken a fresh `pg_dump` first.

When the data itself has to go back to before the update, restore the
pre-migration dump with the previous image; the steps are in
[`disaster-recovery.md`](disaster-recovery.md#going-back-to-before-a-migration). 4. Rolling back from v1.40.2 or later to v1.40.1 or earlier: an account
that saved the Coach lookback "Last year" reads its whole Coach
preference blob as defaults on the older version, metric exclusions
included, until the setting is saved again. Ask affected accounts to
pick another lookback before the rollback, or re-save their exclusions
after it.

## Catalog templates

The TrueNAS catalog bot follows new image tags on its own, so a routine
release needs nothing there. These changes do need a matching pull request to
`truenas/apps` (`ix-dev/community/healthlog/`) in the same release cycle, and
an update to `docs/self-hosting/unraid/healthlog.xml` and
`docs/self-hosting/portainer/templates.json`:

- a new required environment variable, or a new format or minimum for an
  existing one (the form validates the secrets);
- a changed listening port, health check path or health semantics, or start
  time beyond the template's five-minute start period;
- a required PostgreSQL major version, or an extension the stock `postgres`
  image does not ship;
- any other change to the compose shape: a new container, a volume the app
  must write to, a different user.

The catalog app sets `HEALTHLOG_PLATFORM=truenas`, `PORT`, `HOSTNAME`,
`DATABASE_URL`, `ENCRYPTION_KEY`, `API_TOKEN_HMAC_KEY`, `APP_URL`,
`NEXT_PUBLIC_APP_URL` and `SESSION_COOKIE_SECURE`; everything else reaches it
through the form's additional environment variables. See
`docs/self-hosting/truenas.md` for the operator side.

## Verify the served version

The queued-deploy status is **not** the source of truth — the version
`/api/version` actually answers is. A BuildKit layer-cache hit can
re-ship the prior image even when Coolify reports a clean deploy, so
always confirm the served build after a deploy:

```sh
# Asserts prod + demo serve 1.9.0, prints each target's buildSha,
# exits non-zero on a mismatch or timeout after a bounded retry loop.
pnpm dlx tsx scripts/assert-deploy.ts 1.9.0
```

Pass `--only=prod` / `--only=demo` to check a single target, or
`--attempts=N --interval=ms` to widen the retry window while a slow
pull settles.

The worker loads each job's handler module on that job's first run, so a
module the image cannot load does not stop the worker from starting. Once
it has bound its queues, the worker loads every handler a single time in
the background and reports each one that fails, normally within a minute
of start. Each failure is a `job.run.failed` event at `error` with
`reason: "handler_load_failed"` and the queue's name, and stderr also gets
`[pg-boss] [registry] preloaded N/M job handlers; failed to load: <queues>`.
If either shows up after a deploy, the image is broken for those queues,
and their jobs will fail when they run. Roll back (see Rollback above)
instead of waiting for the retries to run out:

```sh
docker compose logs --since 5m app 2>&1 | grep -E 'handler_load_failed|failed to load:'
```

## Walk the synthetic journey

The version check proves the instance serves the right build. It does not
prove a person can use it. `scripts/synthetic-journey.mjs` walks the
shortest journey that touches the whole stack — sign in, write a reading,
read it back, delete it again — against a running instance:

```sh
# Plain Node 22, no dependencies: runs from a workstation, a runner, or
# the deploy host. Warms the instance first, then asserts each leg.
BASE_URL=https://review.healthlog.dev \
SYNTHETIC_USERNAME=<probe account> \
SYNTHETIC_PASSWORD=<its password> \
EXPECTED_VERSION=v1.38.13 \
  node scripts/synthetic-journey.mjs
```

It prints one line per leg with the elapsed time and stops at the first
failure with the status and a redacted body excerpt. The warm-up hit on
each route is timed but discarded — the first request after a deploy pays
the cold-start cost and says nothing about the instance's steady state.

The same journey is available as the **Synthetic journey** workflow
(`workflow_dispatch`, inputs `base_url` and `expected_version`), which
reads the credentials from the `SYNTHETIC_USERNAME` / `SYNTHETIC_PASSWORD`
repository secrets. Nothing calls it from the deploy path; run it by hand
after a deploy until a target instance is settled.

Two preconditions on the probe account: it must be password-only, because
the password flow stops at the MFA ticket for an account with a second
factor, and the target must not be the demo instance, where every mutation
is blocked and the write leg would be red for a reason unrelated to the
deploy.

**A red result.** The leg that failed names the layer:

| Red leg     | What it means                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`   | The instance serves a different build than the tag you deployed. Check the image digest and the `pull_policy` before looking anywhere else. |
| `sign in`   | Sessions are broken, or the probe account gained a second factor. A 429 here is the login rate limit, not the deploy.                       |
| `write`     | The write path is down: database, encryption keys, or a migration that did not run.                                                         |
| `read back` | A value was written and cannot be read back — the shape this project keeps rediscovering. Roll back.                                        |
| `delete`    | The write path works and the reversible delete does not; the probe reading is still on the account and needs removing by hand.              |

Run `node scripts/synthetic-journey.mjs --self-test` to confirm the check
itself still works: it walks the journey against an in-process instance
once per leg with that leg broken, and fails if any of them comes back
green.

## Error reporting

HealthLog ships no default error-reporting target and never will: an
operator's crash reports must not leave their host because nobody told them
not to. Reporting starts only when someone types a DSN into **Admin →
Integrations → GlitchTip**, and that card states plainly whether reports are
going anywhere and which host they go to.

For a maintainer-operated instance, set the DSN there after the first deploy —
it lives in the database, not in the environment, so it survives an image
upgrade and does not need a compose change.

The badge on that card tracks delivery, not intent. A DSN that is set and
parses is not the same fact as reports arriving: a wrong public key, a wrong
project id and a host that stopped answering all parse. So the card is green
only while a report has actually left this host inside the last fortnight,
amber while a target is set and nothing has come back from it, and it names the
reason underneath when the last attempt was refused. Press **Test** to prove
the target on demand — that send is recorded like any other, so the badge
answers immediately.

## Verify the image signature

Every release image (the multi-arch manifest **index**, covering both
`amd64` and `arm64`) is signed keyless via Sigstore in the
`docker-publish.yml` merge job: GitHub's OIDC token is exchanged for a
short-lived Fulcio certificate bound to the workflow identity, and the
signature lands in the Rekor transparency log. There is no long-lived
signing key to leak or rotate.

Verify before (or after) a deploy with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/):

```sh
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/MBombeck/HealthLog/\.github/workflows/docker-publish\.yml@refs/tags/v.*' \
  ghcr.io/mbombeck/healthlog:1.16.4
```

A passing verification proves the image was built by this repository's
release workflow on a `v*` tag — not by anyone who merely obtained push
access to the GHCR package.

### Prefer digest-pinned deploys

Tags (`:latest`, `:1.16.4`) are mutable aliases: a registry-side
compromise or an accidental re-push can repoint them. The digest is the
image's only immutable identity, and it is what the signature actually
covers. For any deploy where supply-chain integrity matters more than
convenience:

The compose file carries the hook for this: the `app` service image is
`ghcr.io/mbombeck/healthlog${HEALTHLOG_IMAGE_REF:-:latest}`. Unset, the
day-to-day `:latest` + `pull_policy: always` flow stays the documented
default for self-hosters. Set `HEALTHLOG_IMAGE_REF` in the compose
`.env` (or the deployment platform's env vars) to switch the reference
without touching the file:

- `HEALTHLOG_IMAGE_REF=:v1.16.5` — pin to a release tag (still mutable).
- `HEALTHLOG_IMAGE_REF=@sha256:<digest>` — pin to the immutable digest.

#### Bumping a digest pin by hand

A digest-pinned instance never follows a release on its own — an image
promote does not touch the pin, so moving it is part of shipping. The
mechanic, end to end:

1. Resolve the new release's digest from the registry (the manifest-list
   digest, which covers both architectures):

   ```sh
   docker buildx imagetools inspect ghcr.io/mbombeck/healthlog:v1.37.20 \
     | grep -m1 Digest
   ```

2. Set `HEALTHLOG_IMAGE_REF=@sha256:<that digest>` where the compose
   environment lives — the `.env` next to the compose file, or the
   deployment platform's env vars for the app service.

3. Deploy as usual.

4. Verify `/api/version` on the target — and verify it **three times a
   few seconds apart**, not once: during the container swap a single
   probe can be answered by the outgoing container (or a cache) and read
   as success while the old release keeps running. Three stable answers
   reporting the shipped `version` + `buildSha` are the signal; a deploy
   that finishes suspiciously fast (under ~30 s) is a warning that
   nothing was actually pulled.

> **A pin is sticky, and a stale pin is silent.** Once set, every later deploy
> ships that reference until someone changes it. The deploy still reports
> success, the tag still builds, the image still publishes, and the running
> instance stays on the old release. If you pin, bumping the pin is part of
> shipping, not an afterthought. If you would rather not carry that step, leave
> the variable unset: `docker-publish.yml` rotates `:latest` on every release tag
> without a pre-release suffix, so the git tag stays the single place a version is
> declared.
>
> Two checks after any deploy, because the first alone can be served from a
> cache: `/api/version` must report the version and commit you shipped, and the
> running container's image must be the one you expect
> (`docker inspect <container> --format '{{.Config.Image}}'`). A deploy that
> finishes suspiciously fast is a signal rather than good news. Also watch for a
> DUPLICATE `HEALTHLOG_IMAGE_REF` entry: Coolify accepts two rows with the same
> key without warning, and which one wins is not defined.

### Promote a release to a pinned digest

`scripts/promote-digest.ts` automates the whole promotion after
`docker-publish.yml` has pushed a tag:

```sh
pnpm dlx tsx scripts/promote-digest.ts v1.16.5
```

It resolves the multi-arch index digest from the GHCR registry API
(anonymous pull token, no docker daemon), verifies the keyless cosign
signature against the workflow identity (fails closed — no cosign, no
promotion), and prints the resulting `HEALTHLOG_IMAGE_REF=@sha256:…`
value.

For a Coolify-managed deployment it can also apply the pin. Two facts
about Coolify shape the mechanism (verified against the Coolify
OpenAPI spec and a live instance):

- For a git-based "Docker Compose" application, Coolify re-reads the
  compose file from the repository checkout on every deploy.
  `docker_compose_raw` is its stored copy of that file, and the
  application-update API (`PATCH /api/v1/applications/{uuid}`) does not
  accept the field — editing the stored compose is neither possible
  via API nor durable.
- Application **env vars** are durable, exposed via the documented
  `/api/v1/applications/{uuid}/envs` endpoints, and interpolated into
  the compose at deploy time.

So the pin travels as the `HEALTHLOG_IMAGE_REF` env var. With
`COOLIFY_API_TOKEN`, `COOLIFY_API_URL` and `COOLIFY_APP_UUID` in the
environment the script creates/updates the var itself (add
`PROMOTE_DEPLOY=1` to also trigger the redeploy); without a token it
prints the equivalent curl commands:

```sh
curl -sS -X PATCH "https://<coolify-host>/api/v1/applications/<app-uuid>/envs" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"key":"HEALTHLOG_IMAGE_REF","value":"@sha256:<digest>"}'

curl -sS "https://<coolify-host>/api/v1/deploy?uuid=<app-uuid>" \
  -H "Authorization: Bearer <token>"
```

After the deploy settles, confirm `/api/version` reports the released
`version` + `buildSha` on every target (see above).

**Rollback:** re-run the script with the previous tag (or PATCH the env
var back to the previous digest / to empty for `:latest`) and redeploy.
Digest pinning trades the automatic `:latest` pickup for determinism —
a pinned instance only moves when the var moves, so the promotion step
becomes part of the release routine, not an optional extra.

Digest pinning is the recommended hardening for operators with a
threat model that includes the registry; `:latest` remains the
low-friction default.

## Deploy-status webhook: replay protection

`POST /api/internal/deploy-webhook` authenticates via the static
`X-Deploy-Webhook-Secret` header. Since v1.16.4 it additionally
enforces a freshness window: a request carrying an
`X-Deploy-Webhook-Timestamp` header (unix seconds, unix milliseconds,
or ISO-8601) is rejected with `401 {"status":"stale"}` when the
timestamp lies more than **5 minutes** from server time — so a captured
request cannot be replayed later to re-page admins or forge deploy
outcomes in the audit log.

Two modes:

- **Default (tolerant).** Requests _without_ the header pass — Coolify's
  stock notification sender does not attach one. A header that is
  present but stale or unparseable is always rejected.
- **Strict.** Set `DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP=true` in the app
  environment to make the header mandatory, closing the replay window
  completely. Use this when the sender (or a reverse proxy in front of
  the app) can attach the timestamp, e.g.:

  ```sh
  curl -X POST https://<host>/api/internal/deploy-webhook \
    -H "X-Deploy-Webhook-Secret: $SECRET" \
    -H "X-Deploy-Webhook-Timestamp: $(date +%s)" \
    -H "Content-Type: application/json" \
    -d '{"status":"success"}'
  ```
