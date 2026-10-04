import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const DEFAULT_CONNECTION_BUDGET = 20;
const DEFAULT_POOL_TIMEOUT_SECONDS = 20;
const PG_BOSS_CONNECTIONS = 2;

function positiveInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function databaseUrlParameter(name: string): string | undefined {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Total PostgreSQL connections this process may own. Compose already exposes
 * this as DB_CONNECTION_LIMIT through DATABASE_URL's `connection_limit`.
 * DATABASE_POOL_MAX remains a backward-compatible explicit override.
 */
export function getConnectionBudget(): number {
  const configured =
    positiveInteger(process.env.DB_CONNECTION_LIMIT) ??
    positiveInteger(process.env.DATABASE_POOL_MAX) ??
    positiveInteger(databaseUrlParameter("connection_limit")) ??
    DEFAULT_CONNECTION_BUDGET;
  return Math.max(2, configured);
}

export function getPgBossPoolMax(): number {
  return Math.min(PG_BOSS_CONNECTIONS, getConnectionBudget() - 1);
}

export function getPrismaPoolMax(): number {
  return getConnectionBudget() - getPgBossPoolMax();
}

export function getPoolConnectionTimeoutMs(): number {
  const seconds =
    positiveInteger(process.env.DB_POOL_TIMEOUT) ??
    positiveInteger(databaseUrlParameter("pool_timeout")) ??
    DEFAULT_POOL_TIMEOUT_SECONDS;
  return seconds * 1_000;
}

/**
 * Per-session DB statement timeout in milliseconds.
 *
 * Without this a single pathological query or lock wait holds one of the
 * (default 20) pool slots indefinitely; 20 such queries permanently exhaust
 * the pool and every DB-backed route stops serving — the single highest-impact
 * availability gap (A-1). `statement_timeout` caps how long the server runs one
 * statement; `idle_in_transaction_session_timeout` reaps a connection wedged
 * mid-transaction (a client that opened a tx and stalled). Both are applied at
 * connection-establishment via the libpq `options` startup parameter, so every
 * pooled session inherits them.
 *
 * Env-overridable via `DATABASE_STATEMENT_TIMEOUT_MS`. Set to `0` to disable
 * (legacy unbounded behaviour). Default 60 s — bounds a genuinely runaway query
 * (the A-1 goal: never hold a pool slot forever) while leaving ample headroom
 * for the heaviest legitimate read, the live-aggregate analytics fallback on a
 * coverage miss over a large account, which can run well past 15 s. Heavy admin
 * one-shots (drain/backfill) can still dial their own timeout if needed.
 */
export function getStatementTimeoutMs(): number {
  const raw = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 60_000;
}

/**
 * Build the libpq `options` startup string applying the session timeouts, or
 * `undefined` when disabled (timeout 0). Passed straight through `PrismaPg` to
 * the underlying `pg.Pool`, which forwards it as the connection's `options`
 * startup parameter so every session is timeout-bounded from the first query.
 */
export function buildSessionOptions(): string | undefined {
  const timeoutMs = getStatementTimeoutMs();
  if (timeoutMs <= 0) return undefined;
  return `-c statement_timeout=${timeoutMs} -c idle_in_transaction_session_timeout=${timeoutMs}`;
}

function createPrismaClient() {
  const sessionOptions = buildSessionOptions();
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    max: getPrismaPoolMax(),
    connectionTimeoutMillis: getPoolConnectionTimeoutMs(),
    ...(sessionOptions ? { options: sessionOptions } : {}),
  });
  return new PrismaClient({ adapter });
}

// One client per process, in production too. A production build gives every
// server bundle its own copy of this module (the route handlers, the RSC/SSR
// renderer, and the instrumentation bundle that boots the workers), so a
// module-scoped client alone meant three of them: three query-compiler states
// of roughly 28 MB each on a heap that V8 caps near 520 MB in a 1 GiB
// container, and three pg pools each sized to the whole per-process
// connection budget above. Parking the client on `globalThis` makes every
// copy of the module resolve the same one.
export const prisma = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = prisma;

// Prisma's `InputJsonValue` requires an explicit index signature that
// typed application shapes (Zod-validated, hand-written interfaces)
// don't carry. Every JSON-column write would otherwise repeat the same
// `value as unknown as Prisma.InputJsonValue` escape hatch — this one
// helper centralises the cast so the WHY stays in a single place.
export const toJson = <T>(v: T) => v as unknown as Prisma.InputJsonValue;
