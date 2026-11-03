# ── Base images ────────────────────────────────────────────
# glibc, not musl, in every stage. The native modules the runtime loads (the
# @napi-rs/canvas Skia renderer, @node-rs/argon2, the Prisma schema engine)
# then run their glibc builds. The arm64 musl Skia build needs ARMv8.2 (LSE
# atomics, RCpc loads) and dies with SIGILL on an ARMv8.0 core such as the
# Raspberry Pi 4's Cortex-A72; the glibc arm64 build does not use those
# instructions (#1311).
#
# The dependency and build stages run on Debian (node:22-trixie-slim), where
# pnpm installs the `-gnu` native packages. The runner is Wolfi: glibc, and
# a package set small enough that the image scan reports what the app ships
# rather than a general-purpose distribution's base system. A glibc binary
# runs on the glibc it was linked against or a newer one; the runner checks
# both that and the Node module ABI against the builder at build time.

# ── Stage 1: Dependencies ──────────────────────────────────
FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS deps
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The dependency patches pnpm-workspace.yaml names; the frozen install
# refuses to run without them.
COPY patches patches
COPY scripts/prepare.mjs scripts/prepare.mjs
RUN pnpm install --frozen-lockfile --prod=false

# ── Stage 2: Build ─────────────────────────────────────────
FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS builder
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

# v1.4.43 B11 — version build-arg threaded into the layer cache key.
# Pre-v1.4.43 the docker-publish workflow shipped a stale package.json
# version baked into the bundle because BuildKit reused the `pnpm build`
# layer across releases (the COPY . . layer key was content-stable when
# only the version string had changed and the next pnpm install layer
# was warm). Passing the tag as a build-arg forces a per-release cache
# miss on this layer and forwards the value into the runtime env so
# /api/version reads from $NEXT_PUBLIC_APP_VERSION first.
ARG NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION

# Short Git SHA of the release commit, same workflow source as the
# version arg above. Changes exactly when the source changes, so it
# adds no cache churn beyond what the COPY below already causes.
# /api/version surfaces it as `buildSha` for deploy verification
# (docs/ops/deploy.md). The built-at timestamp is intentionally NOT
# set in this stage: it differs on every run and would bust the
# `pnpm build` layer cache even for content-identical rebuilds — the
# runner stage below carries it instead (the route reads process.env
# at request time, not at bundle time).
ARG NEXT_PUBLIC_APP_BUILD_SHA
ENV NEXT_PUBLIC_APP_BUILD_SHA=$NEXT_PUBLIC_APP_BUILD_SHA

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN pnpm db:generate

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
# Keep the larger V8 heap build-only. Next's repository-wide TypeScript
# worker exceeds the default ~4 GiB old-space ceiling; the runner stage below
# starts fresh and therefore does not inherit this setting.
RUN NODE_OPTIONS=--max-old-space-size=8192 pnpm build

# Record which pdfjs-dist the top-level dependency actually resolves to. pnpm
# links a direct dependency at `node_modules/<name>`, so this reads the exact
# pinned copy rather than guessing. The runner stage hoists that version by
# name; see the note there for why guessing was wrong.
RUN node -p "require('/app/node_modules/pdfjs-dist/package.json').version" \
      > /app/.pdfjs-version
# The Node module ABI and the glibc the native packages were installed for;
# the runner refuses to build on an older glibc or another module ABI.
RUN node -p "process.versions.modules + ' ' + process.report.getReport().header.glibcVersionRuntime + ' ' + process.version" \
      > /app/.native-abi
# The same for @napi-rs/canvas, whose native binary must match its JS loader.
RUN node -p "require('/app/node_modules/@napi-rs/canvas/package.json').version" \
      > /app/.canvas-version
# Every shipped locale's message catalog is present and parses, checked
# against the locale list in the source; the list is written out so the runner
# stage can check the catalogs the image actually carries.
RUN node scripts/verify-message-catalogs.mjs --dir messages \
      --config src/lib/i18n/config.ts --write /app/.message-locales

# ── Stage 3: Production runner ─────────────────────────────
FROM cgr.dev/chainguard/wolfi-base:latest@sha256:629d9acaceda7746cd9293365eb0d8e8fabf74e91830b05470cfbee20b53f447 AS runner
# `nodejs-22` is the runtime; the builder's Node 22 and this one share the
# module ABI, which the check below holds. `tzdata` is required so
# Europe/Berlin schedules (pg-boss cron, locale-aware timestamp formatting)
# resolve to the actual offset instead of silently falling back to UTC.
#
# `apk upgrade` pulls in package security fixes the pinned base digest has
# not absorbed yet (the digest pin stays for build reproducibility; fixes
# from the Wolfi repository override it deliberately — CVE-2026-14456 in
# openssl was the first instance the container scan caught between
# base-image rebuilds).
#
# `postgresql-18-client` carries `pg_dump` and `pg_restore` for the nightly
# database dump, the pre-migration dump in the entrypoint and the
# `db-restore` service (docs/ops/disaster-recovery.md). Major 18 matches the
# bundled database; a client dumps servers of its own major and older, so it
# also serves an install still on its own Postgres 16.
#
# busybox, part of the base, is the shell the entrypoint runs under and
# carries `tar`/`gzip` for the GeoLite2 extraction and `addgroup`/`adduser`.
#
# The two packages the app runs on are pinned to an exact package version,
# so a rebuild of the same commit runs the same Node and the same pg_dump;
# `apk upgrade` cannot move a pinned package, and moves only the libraries
# under them. No updater reads these pins. What moves them is the image
# scan: Wolfi records the fixed package version for every advisory, so a
# pinned package with a published fix turns the HIGH/CRITICAL gate red and
# names the version to pin. To bump, take the newest from
# `apk policy nodejs-22` / `apk policy postgresql-18-client` in the pinned
# base. `src/__tests__/runtime-package-pins.test.ts` holds the pin format,
# and the client's minor to the bundled database's in docker-compose.yml.
# tzdata stays unpinned on purpose: a zone rule change is a fix to take.
RUN apk add --no-cache nodejs-22=22.23.2-r1 tzdata postgresql-18-client=18.6-r7 && \
    apk upgrade --no-cache && \
    mkdir -p /usr/local/bin
COPY --from=builder /app/.native-abi /tmp/.native-abi
RUN set -e; \
    read -r BUILD_ABI BUILD_GLIBC BUILD_NODE < /tmp/.native-abi; \
    rm -f /tmp/.native-abi; \
    RUN_ABI="$(node -p process.versions.modules)"; \
    RUN_GLIBC="$(node -p 'process.report.getReport().header.glibcVersionRuntime')"; \
    [ "$RUN_ABI" = "$BUILD_ABI" ] || { echo "ERROR: runner Node module ABI $RUN_ABI, builder $BUILD_ABI"; exit 1; }; \
    [ "$(printf '%s\n%s\n' "$BUILD_GLIBC" "$RUN_GLIBC" | sort -V | head -1)" = "$BUILD_GLIBC" ] || \
      { echo "ERROR: runner glibc $RUN_GLIBC is older than the builder's $BUILD_GLIBC"; exit 1; }; \
    echo "native ABI $RUN_ABI (builder $BUILD_NODE, runner $(node -v)); glibc $BUILD_GLIBC -> $RUN_GLIBC"
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=Europe/Berlin

# When the heap runs out, Node writes a diagnostic report (the JavaScript
# and native stacks, heap spaces, libuv handles) to stderr, where
# `docker compose logs` and Loki keep it; without it the log holds one
# line. Environment variables and network interfaces are left out, so no
# key, password or address from the environment reaches the log. An
# operator who sets NODE_OPTIONS replaces this value and should carry these
# flags over (docs/ops/heap-diagnostics.md).
ENV NODE_OPTIONS="--report-on-fatalerror --report-filename=stderr --report-exclude-env --report-exclude-network"

# v1.4.43 B11 — forward NEXT_PUBLIC_APP_VERSION from the builder stage
# into the runner so /api/version reads the build-arg value instead of
# the package.json fallback. The variable is keyed to the CI tag ref
# (`v1.4.43`, etc.), so a release that bumps the tag but cache-reuses
# the prior `pnpm build` layer still surfaces the right runtime version.
ARG NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION

# Short Git SHA the image was built from — /api/version returns it as
# `buildSha` so an operator can verify which commit a running `:latest`
# container actually carries (the deploy runbook checks it after every
# deploy). Provided by docker-publish.yml alongside the version arg.
ARG NEXT_PUBLIC_APP_BUILD_SHA
ENV NEXT_PUBLIC_APP_BUILD_SHA=$NEXT_PUBLIC_APP_BUILD_SHA

RUN addgroup -S -g 1001 nodejs && \
    adduser -S -u 1001 -G nodejs -h /home/nextjs -s /sbin/nologin nextjs

# Where the database dumps go (`DB_BACKUP_DIR`). Owned by the app user, so a
# fresh named volume mounted here starts with that owner: Docker fills an
# empty named volume from the image directory it covers, ownership included.
# Without a mount the directory stays in the container's layer; the app reads
# its mount table, sees that, and keeps no dump here (dump-core.mjs).
RUN mkdir -p /var/lib/healthlog/backups && \
    chown nextjs:nodejs /var/lib/healthlog/backups && \
    chmod 700 /var/lib/healthlog/backups

# Copy built assets
COPY --from=builder /app/public ./public
# The server reads its message catalogs from here on first use, one locale at
# a time (src/lib/i18n/server-catalogs.ts); they are not bundled.
COPY --from=builder /app/messages ./messages
# A missing or broken catalog is only noticed when a page asks for that
# locale, so check the copies in this stage against the builder's list.
COPY --from=builder /app/.message-locales /app/scripts/verify-message-catalogs.mjs /tmp/catalog-check/
RUN node /tmp/catalog-check/verify-message-catalogs.mjs --dir /app/messages \
      --locales /tmp/catalog-check/.message-locales && \
    rm -rf /tmp/catalog-check
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Next's standalone output must carry the externalized worker dependencies.
# Prisma's pure-JS adapter stays bundled; only modules loaded through native
# Node resolution belong in this runtime assertion.
#
# `pg` is a direct entry in `dependencies` for this line's sake, and it has to
# stay there. It used to sit in devDependencies and the assertion still passed,
# but only by coincidence: the version our own entry pinned happened to match
# the one @prisma/adapter-pg pulled in, so both names resolved to a single
# copy in the store and the file tracer packed it whole. Bumping the adapter to
# 7.10.0 moved its transitive pg to 8.23.0 while ours stayed at 8.22.0. The
# tracer then packed only the copy the adapter reached, the top-level link
# pointed at the other one, and this line failed with "Cannot find module
# '/app/node_modules/pg/lib/index.js'" on both architectures. Declaring the
# runtime requirement makes the two resolve to the same copy by construction.
RUN node -e "require.resolve('pg-boss'); require.resolve('pg')"

# @napi-rs/canvas (document PDF rasterization): Next's file tracer copies the
# native binary's package into the standalone tree but NOT the pnpm symlinks that
# resolve it, so at runtime nothing can `require('@napi-rs/canvas')`. TWO
# resolutions must work: (1) pdfjs-dist does a bare `require('@napi-rs/canvas')`
# from its OWN dir — Node walks up to /app/node_modules, so the package must be
# HOISTED to the top level there (verified: without it pdfjs logs "Cannot load
# @napi-rs/canvas" → "Cannot polyfill DOMMatrix" → rasterize ReferenceError);
# (2) @napi-rs/canvas's own loader then resolves its platform binary. Hoist BOTH
# the canvas package and the glibc (`-gnu`) binary package to
# /app/node_modules/@napi-rs via symlink into the .pnpm store, and drop the prebuilt .node into the canvas
# dir: the loader tries that local file (`require('./skia.<triple>.node')`)
# before the platform package, so it decides which binary runs.
#
# Hoist the version the app pins, by name, exactly like pdfjs-dist below. The
# store once held a second, older canvas that a second pdfjs-dist pulled in,
# and this step used to take whichever `find | head -1` returned first. It
# returned the old binary, which then sat next to the new loader: rendering
# still worked, but `loadImage` called an `Image.decode` the old binary does
# not have, and every preview thumbnail failed with "image.decode is not a
# function". Name the version, and fail the build when the binary that lands
# in the canvas dir is not that version's.
COPY --from=builder /app/.canvas-version /tmp/.canvas-version
RUN set -e; \
    CANVAS_VERSION="$(cat /tmp/.canvas-version)"; \
    rm -f /tmp/.canvas-version; \
    CANVAS_DIR="/app/node_modules/.pnpm/@napi-rs+canvas@${CANVAS_VERSION}/node_modules/@napi-rs/canvas"; \
    GNU_DIR="$(find /app/node_modules/.pnpm -maxdepth 4 -type d -path "*@napi-rs+canvas-linux-*-gnu@${CANVAS_VERSION}/node_modules/@napi-rs/canvas-linux-*-gnu" 2>/dev/null | head -1)"; \
    if [ ! -d "$CANVAS_DIR" ] || [ -z "$GNU_DIR" ]; then \
      echo "ERROR: pinned @napi-rs/canvas@${CANVAS_VERSION} or its glibc binary did not reach the traced image."; \
      echo "Present instead:"; \
      find /app/node_modules/.pnpm -maxdepth 1 -name '@napi-rs+canvas*' 2>/dev/null; \
      exit 1; \
    fi; \
    NODE_BIN="$(find "$GNU_DIR" -maxdepth 1 -name 'skia.linux-*-gnu.node' | head -1)"; \
    [ -n "$NODE_BIN" ] || { echo "ERROR: no skia binary in $GNU_DIR"; exit 1; }; \
    mkdir -p /app/node_modules/@napi-rs; \
    ln -sfn "$CANVAS_DIR" /app/node_modules/@napi-rs/canvas; \
    ln -sfn "$GNU_DIR" "/app/node_modules/@napi-rs/$(basename "$GNU_DIR")"; \
    cp "$NODE_BIN" "$CANVAS_DIR/"; \
    chown -R nextjs:nodejs /app/node_modules/@napi-rs; \
    BIN_VERSION="$(node -p "require('$GNU_DIR/package.json').version")"; \
    [ "$BIN_VERSION" = "$CANVAS_VERSION" ] || { echo "ERROR: canvas binary is $BIN_VERSION, loader is $CANVAS_VERSION"; exit 1; }; \
    cmp -s "$NODE_BIN" "$CANVAS_DIR/$(basename "$NODE_BIN")" || { echo "ERROR: the canvas dir holds a different binary"; exit 1; }; \
    echo "canvas hoisted for pdfjs: $CANVAS_DIR (binary $BIN_VERSION from $GNU_DIR)"

# pdfjs-dist is `serverExternalPackages` (NOT bundled — the bundled copy's render
# path breaks in the standalone image), so the server does a runtime bare
# `import('pdfjs-dist/legacy/build/pdf.mjs')`. Node resolves that up to
# /app/node_modules, so hoist the real pnpm-store copy to the top level too.
#
# Hoist the version the app pins, by name. More than one pdfjs-dist once reached
# the store (a text-extraction dependency carried its own, older copy), and this
# step used to take whatever `find | head -1` returned first. That is readdir
# order, so it could hoist the OLDER copy and the version named in package.json
# would never run in the image: the renderer resolving one version while every
# local check exercised another. Name the version and fail the build when it is
# absent, instead of degrading to whichever copy comes back first. Two copies in
# one process also break each other (#1277); the lockfile now resolves one, and
# `src/__tests__/single-pdfjs-guard.test.ts` keeps it that way.
COPY --from=builder /app/.pdfjs-version /tmp/.pdfjs-version
RUN set -e; \
    PDFJS_VERSION="$(cat /tmp/.pdfjs-version)"; \
    PDFJS_DIR="/app/node_modules/.pnpm/pdfjs-dist@${PDFJS_VERSION}/node_modules/pdfjs-dist"; \
    if [ ! -d "$PDFJS_DIR" ]; then \
      echo "ERROR: pinned pdfjs-dist@${PDFJS_VERSION} did not reach the traced image."; \
      echo "Present instead:"; \
      find /app/node_modules/.pnpm -maxdepth 4 -type d -path '*pdfjs-dist@*/node_modules/pdfjs-dist' 2>/dev/null; \
      exit 1; \
    fi; \
    ln -sfn "$PDFJS_DIR" /app/node_modules/pdfjs-dist; \
    chown -h nextjs:nodejs /app/node_modules/pdfjs-dist; \
    rm -f /tmp/.pdfjs-version; \
    RESOLVED="$(node -p "require('/app/node_modules/pdfjs-dist/package.json').version")"; \
    [ "$RESOLVED" = "$PDFJS_VERSION" ] || { echo "ERROR: hoisted pdfjs-dist is $RESOLVED, expected $PDFJS_VERSION"; exit 1; }; \
    echo "pdfjs-dist hoisted: $PDFJS_DIR (resolves as $RESOLVED)"

# Copy Prisma for migrations (schema, migration SQL, config, engines)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated

# Operator maintenance scripts that a runbook tells the operator to run inside
# this container (`docs/ops/password-reset.md`, `docs/ops/intake-repair.md`).
# The standalone output carries none of `scripts/`, so without these lines the
# documented `docker compose exec app node scripts/reset-password.mjs` failed
# with "Cannot find module". Only self-contained scripts belong here: plain
# `node` or the `healthlog-tsx` launcher below, resolving `pg` and
# `@node-rs/argon2` from the traced runtime tree. Scripts that import the
# application graph (`@/…`, the generated Prisma client) run from a source
# checkout instead. `src/__tests__/container-scripts-ship-guard.test.ts` holds
# the runbooks and the entrypoint against this list. `pending-migrations.mjs`
# and `migrate-deploy.mjs` are the entrypoint's own: the first logs the
# pending migration count, the second runs `migrate deploy` with its
# lock-timeout retry. `db-dump.mjs` takes the dump before migrating, and
# `db-restore.mjs` is the `db-restore` service; both share
# `src/lib/database-backup/dump-core.mjs` with the app. Root-owned on purpose:
# the app user can run them but not rewrite them.
COPY --from=builder /app/scripts/reset-password.mjs ./scripts/reset-password.mjs
COPY --from=builder /app/scripts/pending-migrations.mjs ./scripts/pending-migrations.mjs
COPY --from=builder /app/scripts/migrate-deploy.mjs ./scripts/migrate-deploy.mjs
COPY --from=builder /app/scripts/db-dump.mjs ./scripts/db-dump.mjs
COPY --from=builder /app/scripts/db-restore.mjs ./scripts/db-restore.mjs
COPY --from=builder /app/scripts/db-app-role.mjs ./scripts/db-app-role.mjs
COPY --from=builder /app/src/lib/jobs/retired-measurement-indexes.mjs ./src/lib/jobs/retired-measurement-indexes.mjs
COPY --from=builder /app/src/lib/database-backup/dump-core.mjs ./src/lib/database-backup/dump-core.mjs
COPY --from=builder /app/src/lib/auth/argon2-params.mjs ./src/lib/auth/argon2-params.mjs
COPY --from=builder /app/scripts/repair-intake-anomalies.ts ./scripts/repair-intake-anomalies.ts
# Prove the reset CLI's imports resolve in this tree: with every import found
# it stops at its own usage line; a missing module throws before reaching it.
RUN node scripts/reset-password.mjs 2>&1 | grep -q "reset-password: usage:"
# The boot notice parses, and the `pg` it loads on a real boot resolves here.
RUN env -u DATABASE_URL node scripts/pending-migrations.mjs && \
    node --input-type=module -e "await import('pg')" && \
    node --input-type=module -e "await import('./scripts/migrate-deploy.mjs')"
# The dump and restore scripts load, the client tools they run are the
# major the bundled database runs, and the S3 client `db-restore --from-bucket`
# loads resolves from the shared module's place in the tree.
RUN node scripts/db-dump.mjs 2>&1 | grep -q "db-dump: usage:" && \
    node --input-type=module -e "import { createRequire } from 'node:module'; createRequire('/app/src/lib/database-backup/dump-core.mjs').resolve('@aws-sdk/client-s3')" && \
    node scripts/db-restore.mjs 2>&1 | grep -q "db-restore: usage:" && \
    pg_dump --version | grep -q "(PostgreSQL) 18\." && \
    pg_restore --version | grep -q "(PostgreSQL) 18\."

# Install the migration CLI, its config dependency, and a pinned launcher for
# the maintenance scripts already shipped in the standalone tree. The Prisma
# config loads dotenv from /app, so expose the isolated copy there. npm is
# installed for this one step and removed in the same layer, with its cache,
# so no package manager is left in the runtime surface.
#
# Wolfi's npm is major 12, which runs no dependency install scripts unless
# package.json lists the package under `allowScripts`. Three packages here
# have one: `@prisma/engines` downloads the schema engine `migrate deploy`
# runs, `prisma` checks its environment, and `esbuild` (under tsx) checks
# its binary. Without the field the install succeeds and ships no schema
# engine, so the check after this step asks the CLI for it.
#
# This install belongs to npm, not pnpm, so the `overrides` block in
# `pnpm-workspace.yaml` does not reach it: a package pinned there for the app
# tree still arrives here at whatever version Prisma asks for. That is not
# hypothetical. `prisma@7.8.0` resolves `@prisma/config@7.8.0`, which resolves
# `deepmerge-ts@7.1.5`, and the image scan reported CVE-2026-40345 (HIGH,
# stack exhaustion on recursive merges) against `/opt/prisma-cli` on a commit
# whose dependency audit over the app tree was green. Two installs, two
# override mechanisms, one of them set. `overrides` is npm's own mechanism and
# `npm pkg set` writes it into the package.json that `npm init -y` just
# created, before anything resolves.
#
# Measured by rebuilding this exact install both ways: without the field
# `deepmerge-ts@7.1.5` lands, with it `8.0.1` lands and `prisma --version`
# still reports 7.8.0. Keep the range in step with the entry in
# `pnpm-workspace.yaml` — they are one decision applied to two package
# managers, and a fix that lands in only one of them is the defect above.
#
# The same class recurred on 2026-09-02: the image scan reported
# `@hono/node-server@1.19.11` (GHSA-frvp-7c67-39w9, CVE-2026-39406) and
# `valibot@1.2.0` (CVE-2026-59952) under this path, both reached through
# `prisma -> @prisma/dev`, while the app tree carried 1.19.17 and a pin the
# npm install never reads. Rebuilding this install both ways confirms it:
# without the two fields below npm resolves 1.19.11 and 1.2.0, with them it
# resolves 1.19.17 and 1.4.2, and `prisma --version` still reports 7.8.0.
RUN apk add --no-cache npm && \
    mkdir -p /opt/prisma-cli && \
    cd /opt/prisma-cli && \
    npm init -y && \
    npm pkg set 'overrides.deepmerge-ts=^8.0.0' && \
    npm pkg set 'overrides.mysql2=^3.22.0' && \
    npm pkg set 'overrides.@hono/node-server=^1.19.15' && \
    npm pkg set 'overrides.valibot=^1.4.2' && \
    npm pkg set 'allowScripts.@prisma/engines=true' 'allowScripts.prisma=true' 'allowScripts.esbuild=true' --json && \
    npm install --omit=dev prisma@7.10.1 @prisma/engines@7.10.1 tsx@4.23.1 dotenv@18.0.9 && \
    ln -sfn /opt/prisma-cli/node_modules/.bin/tsx /usr/local/bin/healthlog-tsx && \
    ln -sfn /opt/prisma-cli/node_modules/dotenv /app/node_modules/dotenv && \
    ln -sfn /opt/prisma-cli/node_modules/prisma /app/node_modules/prisma && \
    apk del --no-cache npm && \
    rm -rf /root/.npm /root/.cache && \
    sh -c '! command -v npm && ! command -v npx && ! command -v corepack && ! command -v pnpm'

# The schema engine the entrypoint's `migrate deploy` runs is in place.
# Look for the file before asking the CLI: a CLI that finds none downloads
# one, which would hide the missing install script here and fail offline.
RUN ls /opt/prisma-cli/node_modules/@prisma/engines/schema-engine-* >/dev/null && \
    node /opt/prisma-cli/node_modules/prisma/build/index.js --version 2>&1 | \
      grep -q "Schema Engine *: schema-engine-cli [0-9a-f]* (at "

# Same proof for the intake-repair script under the launcher it is documented
# with: its `pg` import resolves, so it reaches its own DATABASE_URL check.
RUN env -u DATABASE_URL healthlog-tsx scripts/repair-intake-anomalies.ts 2>&1 | grep -q "DATABASE_URL must be set"

# v1.4.27 B3 — offline GeoLite2 databases for IP→location and IP→ASN
# lookups. The MMDB files live in `/opt/geolite2/` and are read by
# `src/lib/geo.ts` via `mmdb-lib`. They are downloaded outside the
# Docker build by `scripts/fetch-geolite2.sh` (operator runs it before
# `docker build` with a MaxMind license key) and staged in
# `assets/geolite2/`. The README + .gitkeep are always present so the
# COPY target exists; if the maintainer skipped the fetch step the
# image builds without the DBs and the resolver falls back to the
# online `ipwho.is` provider — matches v1.4.26 behaviour.
#
# Attribution (CC BY-SA 4.0): see `docs/audit/v1427-summary.md` and
# `/about` in the running app.
#
# v1.37.7 (issue #659) — the directory is owned by the unprivileged `nextjs`
# user so the runtime worker can WRITE it: a self-hoster who sets
# MAXMIND_LICENSE_KEY on the published image has the databases fetched into
# this directory at runtime (src/lib/geo/geolite2-fetch.ts) with no rebuild or
# manual mount. `tar`/`gzip` for the extraction come with busybox. A
# read-only bind mount at this path (the bring-your-own-database route) still
# works — the runtime fetch just fails soft and the mounted files stand.
RUN mkdir -p /opt/geolite2 && chown nextjs:nodejs /opt/geolite2
COPY --chown=nextjs:nodejs assets/geolite2/ /opt/geolite2/

# `wget` for health checks written outside the image. A compose file copied
# from this repository up to v1.46.6 and the TrueNAS catalog app both call
# `wget --spider` against /api/health, and their check replaces the
# HEALTHCHECK below; the Wolfi base has no wget, so without this every such
# container stayed unhealthy. `scripts/wget-shim.mjs` understands the flags
# those checks use, exits like wget, and writes nowhere but stdout. The
# image's own HEALTHCHECK and the bundled compose file use the Node probe.
# Root-owned: the app user can run it but not replace it.
COPY --from=builder /app/scripts/wget-shim.mjs /usr/local/lib/healthlog/wget-shim.mjs
RUN printf '#!/bin/sh\nexec node /usr/local/lib/healthlog/wget-shim.mjs "$@"\n' > /usr/local/bin/wget && \
    chmod 755 /usr/local/bin/wget && \
    wget 2>&1 | grep -q "health check shim" && \
    ! wget --no-verbose --tries=1 --spider http://127.0.0.1:9/api/health

# ISO-8601 build timestamp — /api/version returns it as `builtAt`.
# Declared this late in the stage on purpose: the value differs on
# every CI run, and every instruction after an ARG shares its cache
# fate. Down here the only layers it invalidates are the cheap
# entrypoint COPY/chmod below; the npm-install layers above stay
# cache-warm across rebuilds of the same release.
ARG NEXT_PUBLIC_APP_BUILT_AT
ENV NEXT_PUBLIC_APP_BUILT_AT=$NEXT_PUBLIC_APP_BUILT_AT

# Entrypoint script (runs migrations, then starts app)
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Start period: the entrypoint migrates before the server listens, and a
# migration waiting out a held lock retries for up to about eight minutes.
# Five retries: a pool saturated for a minute during a boot storm makes the
# probe's 2 s database check miss once or twice without marking the container
# unhealthy (docker-compose.yml explains the numbers). The probe is Node's own
# fetch: it needs nothing beyond the runtime, the same probe works on any
# base, and no HTTP client has to be installed for one line. A non-2xx
# answer, a refused connection and the 4 s abort all exit 1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
