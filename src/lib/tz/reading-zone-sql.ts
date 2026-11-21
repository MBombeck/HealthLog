/**
 * The SQL side of a reading's own zone (`./reading-zone.ts` holds the rule
 * and the pure helpers). Server-only: it builds Prisma SQL fragments.
 */
import { Prisma } from "@/generated/prisma/client";

const ALIAS = /^[a-z][a-z0-9_]{0,15}$/;

/**
 * The SQL wall clock of a measurement row: `measured_at` (stored as a UTC
 * wall time) read in the row's own zone, or in `profileZone` when it has
 * none. `alias` is the table alias of the measurements row, a literal from
 * the call site, asserted against a closed pattern before it is spliced;
 * the zone is a bound parameter.
 */
export function readingWallSql(alias: string, profileZone: string): Prisma.Sql {
  if (!ALIAS.test(alias)) throw new Error(`bad table alias: ${alias}`);
  const a = Prisma.raw(alias);
  return Prisma.sql`((${a}."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(${a}."time_zone", ${profileZone}))`;
}

/**
 * The names from `zones` Postgres knows. A zone the runtime accepts but the
 * database's tz data does not would make every SQL reader of the row fail,
 * so such a zone is not stored.
 */
export async function zonesKnownToPostgres(
  db: { $queryRaw: <T>(q: Prisma.Sql) => Promise<T> },
  zones: readonly string[],
): Promise<Set<string>> {
  if (zones.length === 0) return new Set();
  const rows = await db.$queryRaw<Array<{ name: string }>>(
    Prisma.sql`SELECT "name" FROM pg_timezone_names WHERE "name" = ANY(${[...zones]}::text[])`,
  );
  return new Set(rows.map((r) => r.name));
}
