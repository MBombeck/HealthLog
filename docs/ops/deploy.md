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

# 2. Run migrations against the live DB using the new image.
docker run --rm --env-file .env.production \
  ghcr.io/mbombeck/healthlog:vX.Y.Z \
  pnpm prisma migrate deploy

# 3. Recreate the app container so it picks up the new image.
docker compose up -d app
```

The entrypoint also runs `prisma migrate deploy` on container boot, so
step 2 is redundant in normal Coolify flow. It's listed explicitly for
the manual case so an operator can verify the migration result before
flipping traffic.

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
