/**
 * Which database migrations this image ships, which the database has
 * applied, and which are still pending, for Admin > System status.
 *
 * The same comparison the boot notice makes (`scripts/pending-migrations.mjs`)
 * on the running server: the shipped list is every directory under
 * `prisma/migrations` that carries a `migration.sql` (the image copies the
 * folder for `migrate deploy`), the applied list is `_prisma_migrations` rows
 * that finished and were not rolled back. A row that started and never
 * finished is a failed migration, which `migrate deploy` refuses to pass, so it
 * is reported apart from the pending ones.
 *
 * Read-only and best effort: a missing folder (a build without it) reports
 * `shipped: null`, and a database without the table has applied nothing.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "@/lib/db";

/** How many pending or failed names the answer lists; the counts are full. */
const LIST_LIMIT = 20;

export interface MigrationStatus {
  /** Migrations in this image; null when the folder is not there. */
  shipped: number | null;
  applied: number;
  pending: number;
  /** The first pending names, in apply order. */
  pendingNames: string[];
  /** Migrations that started and did not finish. */
  failedNames: string[];
  lastApplied: { name: string; at: string } | null;
}

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

function shippedMigrations(dir: string): string[] | null {
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(dir, name, "migration.sql")))
    .sort();
}

/** The status, from a shipped list and the table's rows. Pure. */
export function migrationStatusOf(
  shipped: string[] | null,
  rows: readonly MigrationRow[],
): MigrationStatus {
  const done = rows.filter(
    (row) => row.finished_at !== null && row.rolled_back_at === null,
  );
  const doneNames = new Set(done.map((row) => row.migration_name));
  const failedNames = rows
    .filter((row) => row.finished_at === null && row.rolled_back_at === null)
    .map((row) => row.migration_name)
    .sort();
  const failed = new Set(failedNames);
  const pendingNames = (shipped ?? []).filter(
    (name) => !doneNames.has(name) && !failed.has(name),
  );
  let last: MigrationRow | null = null;
  for (const row of done) {
    if (last === null || (row.finished_at as Date) > (last.finished_at as Date))
      last = row;
  }
  return {
    shipped: shipped?.length ?? null,
    applied: done.length,
    pending: pendingNames.length,
    pendingNames: pendingNames.slice(0, LIST_LIMIT),
    failedNames: failedNames.slice(0, LIST_LIMIT),
    lastApplied: last
      ? {
          name: last.migration_name,
          at: (last.finished_at as Date).toISOString(),
        }
      : null,
  };
}

export async function loadMigrationStatus(
  migrationsDir = join(process.cwd(), "prisma", "migrations"),
): Promise<MigrationStatus> {
  const shipped = shippedMigrations(migrationsDir);
  const table = await prisma.$queryRaw<Array<{ t: string | null }>>`
    SELECT to_regclass('_prisma_migrations')::text AS t
  `;
  const rows = table[0]?.t
    ? await prisma.$queryRaw<MigrationRow[]>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM _prisma_migrations
      `
    : [];
  return migrationStatusOf(shipped, rows);
}
