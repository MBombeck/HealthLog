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
RUN pnpm build

# ── Stage 3: Production runner ─────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runner
# `tzdata` is required so Europe/Berlin schedules (pg-boss cron, locale-aware
# timestamp formatting) resolve to the actual offset instead of silently
# falling back to UTC on Alpine images that ship without it.
RUN apk add --no-cache tzdata
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
# via symlink into the .pnpm store, and also drop the prebuilt .node into the
# canvas dir so the loader's local-file fallback (`require('./skia.<triple>.node')`)
# is belt-and-suspenders. Per-arch buildx installs only the matching musl triple.
RUN set -e; \
    CANVAS_DIR="$(find /app/node_modules/.pnpm -maxdepth 4 -type d -path '*@napi-rs+canvas@*/node_modules/@napi-rs/canvas' 2>/dev/null | head -1)"; \
    MUSL_DIR="$(find /app/node_modules/.pnpm -maxdepth 4 -type d -path '*@napi-rs+canvas-linux-*-musl@*/node_modules/@napi-rs/canvas-linux-*-musl' 2>/dev/null | head -1)"; \
    NODE_BIN="$(find /app/node_modules/.pnpm -maxdepth 5 -name 'skia.linux-*-musl.node' 2>/dev/null | head -1)"; \
    if [ -n "$CANVAS_DIR" ]; then \
      mkdir -p /app/node_modules/@napi-rs; \
      ln -sfn "$CANVAS_DIR" /app/node_modules/@napi-rs/canvas; \
      [ -n "$MUSL_DIR" ] && ln -sfn "$MUSL_DIR" "/app/node_modules/@napi-rs/$(basename "$MUSL_DIR")"; \
      [ -n "$NODE_BIN" ] && cp "$NODE_BIN" "$CANVAS_DIR/"; \
      chown -R nextjs:nodejs /app/node_modules/@napi-rs; \
      echo "canvas hoisted for pdfjs: $CANVAS_DIR (musl=$MUSL_DIR)"; \
    else echo "WARN: @napi-rs/canvas not found; PDF rasterization will degrade to local text"; fi

# pdfjs-dist is `serverExternalPackages` (NOT bundled — the bundled copy's render
# path breaks in the standalone image), so the server does a runtime bare
# `import('pdfjs-dist/legacy/build/pdf.mjs')`. Node resolves that up to
# /app/node_modules, so hoist the real pnpm-store copy to the top level too.
RUN set -e; \
    PDFJS_DIR="$(find /app/node_modules/.pnpm -maxdepth 4 -type d -path '*pdfjs-dist@*/node_modules/pdfjs-dist' 2>/dev/null | head -1)"; \
    if [ -n "$PDFJS_DIR" ]; then \
      ln -sfn "$PDFJS_DIR" /app/node_modules/pdfjs-dist; \
      chown -h nextjs:nodejs /app/node_modules/pdfjs-dist; \
      echo "pdfjs-dist hoisted: $PDFJS_DIR"; \
    else echo "WARN: pdfjs-dist not found; PDF rasterization will degrade to local text"; fi

# Copy Prisma for migrations (schema, migration SQL, config, engines)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated

# Install the migration CLI plus a pinned launcher for the maintenance scripts
# already shipped in the standalone tree. Then strip npm/Corepack and caches:
# package managers are build-time tools, not runtime surface.
RUN mkdir -p /opt/prisma-cli && \
    cd /opt/prisma-cli && \
    npm init -y && \
    npm install --omit=dev prisma@7.8 @prisma/engines@7.8 tsx@4.23.1 && \
    ln -sfn /opt/prisma-cli/node_modules/.bin/tsx /usr/local/bin/healthlog-tsx && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /root/.cache/node/corepack /root/.npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

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
RUN mkdir -p /opt/geolite2
COPY assets/geolite2/ /opt/geolite2/

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
