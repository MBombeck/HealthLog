/**
 * The pre-migration dump: a whole-database dump the entrypoint takes before
 * `prisma migrate deploy` applies anything.
 *
 *   node scripts/db-dump.mjs pre-migration
 *
 * A migration is not undone by going back to the previous image, and the
 * bundled compose file pulls `:latest` and migrates on every start. So when
 * this image brings migrations the database has not applied, it first writes
 * `healthlog-<timestamp>-pre-migration.dump` with its manifest into
 * `DB_BACKUP_DIR` (`src/lib/database-backup/dump-core.mjs`), and keeps the
 * newest two, neither older than the oldest nightly dump except the newest.
 *
 * Exit 0: the dump was written, or there was nothing to do (no pending
 * migration, a new database, `DB_BACKUP_BEFORE_MIGRATE=false`; a count of
 * pending migrations that fails is not "none", and the dump is taken), or
 * there is no
 * directory to put it in that survives the container (none writable, or only
 * the image's own directory without the volume, which the update that brings
 * these migrations is about to throw away), which is said as a warning and is
 * not a reason to keep the app down. Exit 1: the directory is kept and the
 * dump failed. The entrypoint then stops the boot and names the switch that skips
 * the dump, because migrating without the way back the operator was promised
 * is the one thing this step exists to prevent.
 *
 * Fast on purpose: one snapshot, `pg_dump`, a count per table for the
 * manifest, `pg_restore --list` to prove the file reads. Nothing else.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyRetention,
  backupDirectoryStatus,
  connect,
  createDatabaseDump,
  latestMigration,
  listUserTables,
  connectionFromUrl,
  preMigrationDumpEnabled,
  resolveBackupDir,
  resolveDailyKeep,
} from "../src/lib/database-backup/dump-core.mjs";
import { pendingMigrations } from "./pending-migrations.mjs";

const log = (line) => console.log(`HealthLog: ${line}`);
const warn = (line) => console.error(`HealthLog: WARNING — ${line}`);

/** The image's version: the build argument, else package.json beside it. */
function imageVersion(env) {
  const fromEnv = (env.NEXT_PUBLIC_APP_VERSION ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"))
      .version;
  } catch {
    return null;
  }
}

/** Megabytes as an operator reads them. */
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {{ directoryStatus?: typeof backupDirectoryStatus }} [options]
 */
export async function preMigrationDump(env = process.env, options = {}) {
  if (!preMigrationDumpEnabled(env)) {
    log("DB_BACKUP_BEFORE_MIGRATE=false, no dump before migrating.");
    return 0;
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return 0;

  // "Cannot tell" is not "nothing to do": a count that timed out on a
  // database still starting up was read as no pending migration, and the
  // migration a second later ran without its way back. Unknown, the dump is
  // taken.
  /** @type {string[] | null} */
  let pending;
  try {
    pending = await pendingMigrations({
      connectionString: databaseUrl,
      migrationsDir: join(process.cwd(), "prisma", "migrations"),
    });
  } catch (error) {
    warn(
      `could not count pending migrations (${error instanceof Error ? error.message : String(error)}); taking the dump before migrating anyway.`,
    );
    pending = null;
  }
  if (pending !== null && pending.length === 0) return 0;
  const migrations =
    pending === null
      ? "any pending migrations"
      : `${pending.length} pending migration(s)`;

  // A database no migration has touched holds nothing to lose.
  const client = await connect(databaseUrl);
  let applied;
  let tables;
  try {
    applied = await latestMigration(
      client,
      connectionFromUrl(databaseUrl).schema,
    );
    tables = (await listUserTables(client)).length;
  } finally {
    await client.end().catch(() => {});
  }
  if (applied === null && tables === 0) {
    log("new database, no dump before the first migrations.");
    return 0;
  }

  const dir = resolveBackupDir(env);
  const status = (options.directoryStatus ?? backupDirectoryStatus)(dir);
  if (!status.persistent) {
    const why = !status.writable
      ? "is not writable"
      : status.reason === "memory"
        ? "is in memory (tmpfs) and would not keep a dump past a restart"
        : "is inside the container, not on a mounted volume, and would not keep a dump past this update";
    warn(
      `${dir} ${why}, so no dump is taken before ${pending === null ? migrations : `the ${migrations}`}. ` +
        "Mount the backups volume (docker-compose.yml) to keep a way back; continuing.",
    );
    return 0;
  }

  log(`taking a database dump before ${migrations} into ${dir}...`);
  const started = Date.now();
  try {
    const { dumpPath, manifest } = await createDatabaseDump({
      databaseUrl,
      dir,
      kind: "pre-migration",
      env,
      appVersion: imageVersion(env),
      buildSha: (env.NEXT_PUBLIC_APP_BUILD_SHA ?? "").trim() || null,
    });
    log(
      `pre-migration dump written: ${basename(dumpPath)} (${mb(manifest.dump.bytes)}, ` +
        `${Object.keys(manifest.rowCounts).length} tables, ${Math.round((Date.now() - started) / 1000)} s).`,
    );
  } catch (error) {
    console.error(
      `HealthLog: ERROR — the database dump before migrating failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  try {
    await applyRetention(dir, { dailyKeep: resolveDailyKeep(env) });
  } catch (error) {
    warn(
      `could not remove old dumps in ${dir} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  return 0;
}

async function main() {
  const kind = process.argv[2];
  if (kind !== "pre-migration") {
    console.error("db-dump: usage: node scripts/db-dump.mjs pre-migration");
    process.exit(2);
  }
  process.exit(await preMigrationDump());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
