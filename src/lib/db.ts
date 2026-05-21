import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * v1.4.40 W-POOL — Prisma `pg.Pool` ceiling raised from the library
 * default of 10 → 20.
 *
 * The v1.4.39 empirical cold-mount trace
 * (`.planning/round-v1439-empirical-trace.md` § B2) showed thick
 * `/api/analytics` holding ≥ 8 of the 10 default pool slots for
 * 6.5 s on Marc's 347k-row tenant, starving every other Wave-B and
 * Wave-C useQuery fan-out for the duration. Coolify's Postgres
 * container runs the stock `max_connections` 100 ceiling, so a
 * 20-slot Node-side pool sits well under the server's hard cap with
 * plenty of headroom for concurrent power-users (≤ 5 simultaneous
 * tenants × 20 = 100). Complements the W-POOL `p-limit(4)` cap on
 * the analytics fan-out itself — the bounded concurrency keeps any
 * single analytics call to ≤ 4 slots, so the remaining 16 stay
 * available for every other dashboard query.
 *
 * Env-overridable via `DATABASE_POOL_MAX` so an operator running
 * with a smaller Postgres `max_connections` can dial down without a
 * code change.
 */
export function getPoolMax(): number {
  const raw = process.env.DATABASE_POOL_MAX;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 20;
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    max: getPoolMax(),
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Prisma's `InputJsonValue` requires an explicit index signature that
// typed application shapes (Zod-validated, hand-written interfaces)
// don't carry. Every JSON-column write would otherwise repeat the same
// `value as unknown as Prisma.InputJsonValue` escape hatch — this one
// helper centralises the cast so the WHY stays in a single place.
export const toJson = <T>(v: T) => v as unknown as Prisma.InputJsonValue;
