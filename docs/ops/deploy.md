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
# 1. Pull the new image.
docker pull ghcr.io/mbombeck/healthlog:vX.Y.Z

# 2. Run migrations against the live DB using the new image. The
#    production image strips pnpm/npm; use the entrypoint's node
#    invocation of the bundled Prisma CLI instead.
docker run --rm --env-file .env.production \
  ghcr.io/mbombeck/healthlog:vX.Y.Z \
  sh -c 'NODE_PATH=/opt/prisma-cli/node_modules node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy'

# 3. Recreate the app container so it picks up the new image.
docker compose up -d app
```

The entrypoint also runs `prisma migrate deploy` on container boot, so
step 2 is redundant in normal Coolify flow. It's listed explicitly for
the manual case so an operator can verify the migration result before
flipping traffic.

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
