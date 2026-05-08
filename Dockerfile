# ── Stage 1: Dependencies ──────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# ── Stage 2: Build ─────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN pnpm db:generate

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ── Stage 3: Production runner ─────────────────────────────
FROM node:22-alpine AS runner
# `tzdata` is required so Europe/Berlin schedules (pg-boss cron, locale-aware
# timestamp formatting) resolve to the actual offset instead of silently
# falling back to UTC on Alpine images that ship without it.
RUN apk add --no-cache tzdata && \
    corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_PATH="/opt/pg-boss/node_modules"
ENV TZ=Europe/Berlin

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy built assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy Prisma for migrations (schema, migration SQL, config, engines)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated

# Install all worker runtime dependencies in a shared prefix.
# NODE_PATH makes them available to Node.js module resolution.
# These packages are listed in next.config.ts serverExternalPackages
# and are NOT bundled by Next.js — they must exist at runtime.
RUN mkdir -p /opt/pg-boss && \
    cd /opt/pg-boss && \
    npm init -y && \
    npm install --omit=dev pg-boss@12 @prisma/adapter-pg@7 pg@8

# Install Prisma CLI + engines for runtime migrations (isolated from Next standalone tree)
RUN mkdir -p /opt/prisma-cli && \
    cd /opt/prisma-cli && \
    npm init -y && \
    npm install --omit=dev prisma@7.4.0 @prisma/engines@7.4.0

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
