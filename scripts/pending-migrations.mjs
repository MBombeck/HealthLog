/**
 * Boot-time notice before `prisma migrate deploy`: how many migrations this
 * image is about to apply, and that a dump is taken first
 * (`scripts/db-dump.mjs`, which imports `pendingMigrations` from here).
 *
 * Run by `docker-entrypoint.sh` as `node scripts/pending-migrations.mjs`.
 * It only reports. A migration that changes data cannot be undone by pulling
 * the previous image; the dump the entrypoint takes next is the way back.
 *
 * Best effort by design: any failure to count (no `_prisma_migrations` table
 * yet is not a failure, it means every migration is pending) prints one line
 * saying so and exits 0, because a notice is never a reason to keep the app
 * from starting. `migrate deploy` right after it is what decides.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Migration directory names that carry a `migration.sql`, sorted. */
export function shippedMigrations(migrationsDir) {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(migrationsDir, name, "migration.sql")))
    .sort();
}

/**
 * The shipped migrations the database has not finished applying. Reads
 * `_prisma_migrations` in the schema the connection string names (Prisma's
 * `?schema=` parameter, `public` when absent); a database without that table
 * has applied nothing.
 */
export async function pendingMigrations({ connectionString, migrationsDir }) {
  const shipped = shippedMigrations(migrationsDir);
  const { default: pg } = await import("pg");
  const url = new URL(connectionString);
  const schema = url.searchParams.get("schema") || "public";
  url.searchParams.delete("schema");
  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  await client.connect();
  try {
    const table = await client.query(
      "SELECT to_regclass(format('%I._prisma_migrations', $1::text)) AS t",
      [schema],
    );
    if (!table.rows[0]?.t) return shipped;
    const applied = await client.query(
      `SELECT migration_name FROM ${table.rows[0].t}
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    const done = new Set(applied.rows.map((row) => row.migration_name));
    return shipped.filter((name) => !done.has(name));
  } finally {
    await client.end().catch(() => {});
  }
}

/** The log line for a count, as the entrypoint prints it. */
export function pendingNotice(count) {
  if (count === 0) return "HealthLog: Database schema is up to date.";
  const noun = count === 1 ? "migration" : "migrations";
  return (
    `HealthLog: ${count} database ${noun} pending. ` +
    "Unless DB_BACKUP_BEFORE_MIGRATE=false, a pg_dump of the database is " +
    "written to DB_BACKUP_DIR before they run (docs/ops/disaster-recovery.md); " +
    "a migration is not undone by going back to the previous image."
  );
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;
  try {
    const pending = await pendingMigrations({
      connectionString,
      migrationsDir: join(process.cwd(), "prisma", "migrations"),
    });
    console.log(pendingNotice(pending.length));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(
      `HealthLog: Could not count pending migrations (${reason}); continuing.`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
