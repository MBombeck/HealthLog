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

/** `work_mem` when `DATABASE_WORK_MEM` is unset. */
export const DEFAULT_WORK_MEM = "16MB";

/**
 * A Postgres memory size: digits and an optional unit. The value is spliced
 * into the libpq `options` string, where a space would start another `-c`
 * flag, so anything else is refused and the default used.
 */
const WORK_MEM_SHAPE = /^[1-9][0-9]{0,6}(kB|MB|GB)?$/;

/**
 * Per-session `work_mem` (v1.42), from `DATABASE_WORK_MEM`.
 *
 * The server default of 4 MB made the larger sorts and hash aggregates of the
 * analytics reads spill to disk. `work_mem` is a USERSET setting, so it rides
 * the same startup `options` as the timeouts and applies to this app's
 * connections only, without a database restart. Each sort or hash step of
 * each connection may use this much, so raise it with the pool size in mind.
 * An unparsable value falls back to the default rather than reaching libpq.
 */
export function getWorkMem(): string {
  const raw = process.env.DATABASE_WORK_MEM?.trim();
  return raw && WORK_MEM_SHAPE.test(raw) ? raw : DEFAULT_WORK_MEM;
}

/**
 * Whether the app may send the libpq `options` startup parameter at all.
 *
 * PgBouncer refuses a connection that carries a startup parameter it does not
 * know (`unsupported startup parameter: options`) unless the operator lists
 * it in `ignore_startup_parameters`. Up to v1.41 such a host could set the
 * statement timeout to 0, which dropped the whole string; v1.42 always sends
 * `work_mem`, so that no longer worked. `DATABASE_SESSION_OPTIONS_DISABLED`
 * (1, true or yes) sends none of the session settings; the pooler or the
 * database's own defaults then apply.
 */
export function sessionOptionsDisabled(): boolean {
  const raw = process.env.DATABASE_SESSION_OPTIONS_DISABLED?.trim();
  return raw !== undefined && /^(1|true|yes)$/i.test(raw);
}

/**
 * Build the libpq `options` startup string applying the session settings.
 * Passed straight through `PrismaPg` to the underlying `pg.Pool`, which
 * forwards it as the connection's `options` startup parameter so every
 * session carries them from the first query.
 *
 * The timeouts are left out when disabled (timeout 0); `work_mem` is always
 * set. Up to v1.41 the whole string was `undefined` at timeout 0, which would
 * have taken `work_mem` with it. `undefined` now means exactly one thing:
 * the operator turned the startup options off for a connection pooler
 * ({@link sessionOptionsDisabled}).
 */
export function buildSessionOptions(): string | undefined {
  if (sessionOptionsDisabled()) return undefined;
  const timeoutMs = getStatementTimeoutMs();
  const timeouts =
    timeoutMs > 0
      ? `-c statement_timeout=${timeoutMs} -c idle_in_transaction_session_timeout=${timeoutMs} `
      : "";
  return `${timeouts}-c work_mem=${getWorkMem()}`;
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    max: getPrismaPoolMax(),
    connectionTimeoutMillis: getPoolConnectionTimeoutMs(),
    options: buildSessionOptions(),
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
