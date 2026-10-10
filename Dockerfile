# ── Stage 1: Dependencies ──────────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS deps
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/prepare.mjs scripts/prepare.mjs
RUN pnpm install --frozen-lockfile --prod=false

# ── Stage 2: Build ─────────────────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder
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
# The same for @napi-rs/canvas, whose native binary must match its JS loader.
RUN node -p "require('/app/node_modules/@napi-rs/canvas/package.json').version" \
      > /app/.canvas-version

# ── Stage 3: Production runner ─────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runner
# `tzdata` is required so Europe/Berlin schedules (pg-boss cron, locale-aware
# timestamp formatting) resolve to the actual offset instead of silently
# falling back to UTC on Alpine images that ship without it.
#
# `apk upgrade` pulls in OS-package security fixes the pinned base digest
# has not absorbed yet (the digest pin stays for build reproducibility;
# security patches from the Alpine repo override it deliberately —
# CVE-2026-14456 in openssl was the first instance the container scan
# caught between base-image rebuilds).
RUN apk add --no-cache tzdata && apk upgrade --no-cache
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=Europe/Berlin

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

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy built assets
COPY --from=builder /app/public ./public
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
# the canvas package and the musl binary package to /app/node_modules/@napi-rs
# via symlink into the .pnpm store, and drop the prebuilt .node into the canvas
# dir: the loader tries that local file (`require('./skia.<triple>.node')`)
# before the platform package, so it decides which binary runs.
#
# Hoist the version the app pins, by name, exactly like pdfjs-dist below. The
# store holds a second, older canvas that pdf-parse's own pdfjs-dist pulls in,
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
    MUSL_DIR="$(find /app/node_modules/.pnpm -maxdepth 4 -type d -path "*@napi-rs+canvas-linux-*-musl@${CANVAS_VERSION}/node_modules/@napi-rs/canvas-linux-*-musl" 2>/dev/null | head -1)"; \
    if [ ! -d "$CANVAS_DIR" ] || [ -z "$MUSL_DIR" ]; then \
      echo "ERROR: pinned @napi-rs/canvas@${CANVAS_VERSION} or its musl binary did not reach the traced image."; \
      echo "Present instead:"; \
      find /app/node_modules/.pnpm -maxdepth 1 -name '@napi-rs+canvas*' 2>/dev/null; \
      exit 1; \
    fi; \
    NODE_BIN="$(find "$MUSL_DIR" -maxdepth 1 -name 'skia.linux-*-musl.node' | head -1)"; \
    [ -n "$NODE_BIN" ] || { echo "ERROR: no skia binary in $MUSL_DIR"; exit 1; }; \
    mkdir -p /app/node_modules/@napi-rs; \
    ln -sfn "$CANVAS_DIR" /app/node_modules/@napi-rs/canvas; \
    ln -sfn "$MUSL_DIR" "/app/node_modules/@napi-rs/$(basename "$MUSL_DIR")"; \
    cp "$NODE_BIN" "$CANVAS_DIR/"; \
    chown -R nextjs:nodejs /app/node_modules/@napi-rs; \
    BIN_VERSION="$(node -p "require('$MUSL_DIR/package.json').version")"; \
    [ "$BIN_VERSION" = "$CANVAS_VERSION" ] || { echo "ERROR: canvas binary is $BIN_VERSION, loader is $CANVAS_VERSION"; exit 1; }; \
    cmp -s "$NODE_BIN" "$CANVAS_DIR/$(basename "$NODE_BIN")" || { echo "ERROR: the canvas dir holds a different binary"; exit 1; }; \
    echo "canvas hoisted for pdfjs: $CANVAS_DIR (binary $BIN_VERSION from $MUSL_DIR)"

# pdfjs-dist is `serverExternalPackages` (NOT bundled — the bundled copy's render
# path breaks in the standalone image), so the server does a runtime bare
# `import('pdfjs-dist/legacy/build/pdf.mjs')`. Node resolves that up to
# /app/node_modules, so hoist the real pnpm-store copy to the top level too.
#
# Hoist the version the app pins, by name. More than one pdfjs-dist reaches the
# store — `pdf-parse` carries its own, older copy for the text-extraction path —
# and this step used to take whatever `find | head -1` returned first. That is
# readdir order, so it could hoist the OLDER copy and the version named in
# package.json would never run in the image: the renderer resolving one version
# while every local check exercised another. Name the version and fail the build
# when it is absent, instead of degrading to whichever copy comes back first.
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
# the runbooks and this list in step. Root-owned on purpose: the app user can
# run them but not rewrite them.
COPY --from=builder /app/scripts/reset-password.mjs ./scripts/reset-password.mjs
COPY --from=builder /app/src/lib/auth/argon2-params.mjs ./src/lib/auth/argon2-params.mjs
COPY --from=builder /app/scripts/repair-intake-anomalies.ts ./scripts/repair-intake-anomalies.ts
# Prove the reset CLI's imports resolve in this tree: with every import found
# it stops at its own usage line; a missing module throws before reaching it.
RUN node scripts/reset-password.mjs 2>&1 | grep -q "reset-password: usage:"

# Install the migration CLI, its config dependency, and a pinned launcher for
# the maintenance scripts already shipped in the standalone tree. The Prisma
# config loads dotenv from /app, so expose the isolated copy there before
# stripping npm/Corepack and their caches from the runtime surface.
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
RUN mkdir -p /opt/prisma-cli && \
    cd /opt/prisma-cli && \
    npm init -y && \
    npm pkg set 'overrides.deepmerge-ts=^8.0.0' && \
    npm pkg set 'overrides.mysql2=^3.22.0' && \
    npm pkg set 'overrides.@hono/node-server=^1.19.15' && \
    npm pkg set 'overrides.valibot=^1.4.2' && \
    npm install --omit=dev prisma@7.10.0 @prisma/engines@7.10.0 tsx@4.23.1 dotenv@18.0.6 && \
    ln -sfn /opt/prisma-cli/node_modules/.bin/tsx /usr/local/bin/healthlog-tsx && \
    ln -sfn /opt/prisma-cli/node_modules/dotenv /app/node_modules/dotenv && \
    ln -sfn /opt/prisma-cli/node_modules/prisma /app/node_modules/prisma && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /root/.cache/node/corepack /root/.npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

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
# manual mount. `tar`/`gzip` for the extraction ship in the busybox base. A
# read-only bind mount at this path (the bring-your-own-database route) still
# works — the runtime fetch just fails soft and the mounted files stand.
RUN mkdir -p /opt/geolite2 && chown nextjs:nodejs /opt/geolite2
COPY --chown=nextjs:nodejs assets/geolite2/ /opt/geolite2/

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
