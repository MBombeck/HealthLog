/**
 * `prisma migrate deploy` for the container boot, with one narrow retry: a
 * migration that gave up waiting for a lock.
 *
 * Run by `docker-entrypoint.sh` as `node scripts/migrate-deploy.mjs`.
 *
 * A migration that bounds its lock wait (`lock_timeout`) fails with SQLSTATE
 * 55P03 when something holds the table longer, typically an autovacuum that
 * is preventing wraparound and does not step aside. Prisma then records the
 * attempt as failed, and every later `migrate deploy` stops at P3009 until an
 * operator runs `prisma migrate resolve --rolled-back`: under a restart
 * policy that is a container that never comes up.
 *
 * `migrate deploy` does not wrap a migration file in a transaction, so a
 * failed file is not necessarily rolled back: statements before the one that
 * failed stay applied. Marking such an attempt rolled back and running it
 * again is only safe when the file was written for it. A migration declares
 * that with a `-- @retry-on-lock-timeout` line, which its author adds only
 * when every statement before the lock-taking one is harmless to repeat and
 * the lock-taking statements form one statement (a `DO` block) that rolls
 * back whole. `src/__tests__/migration-lock-timeout-guard.test.ts` holds the
 * migrations to that.
 *
 * A deadlock (40P01) is the same failure seen from the other side: a marked
 * migration's `DO` block holds the locks it took until it commits, and an app
 * transaction that took two of the same tables in the other order makes
 * Postgres cancel one of the two. When the migration is the one cancelled,
 * its block rolled back whole, exactly as on a lock timeout.
 *
 * So: on a 55P03 or 40P01 failure of a migration carrying the marker, mark
 * that one migration rolled back and run `migrate deploy` again after a
 * backoff (15, 30, 60, 120, 240 seconds). Any other failure, a lock timeout of a migration
 * without the marker, or a fifth lock timeout in a row, ends the boot with
 * Prisma's exit code exactly as before. The failure is read from Prisma's
 * own report (`Migration name:` and `Database error code:`), or, on a boot
 * after a failed one (P3009), from the `logs` Prisma stored on the failed
 * row in `_prisma_migrations`.
 *
 * Every Prisma call runs with its session pinned to UTC, the way the app's
 * own connections are (`src/lib/db-session.ts`). Almost every `DateTime`
 * column is `timestamp` without a time zone and holds UTC, and Postgres
 * converts between that and `timestamptz` / `now()` through the session time
 * zone. A migration that mixes the two (0372 does) therefore wrote hours-off
 * values on a database whose default zone is not UTC. Prisma ignores `PGTZ`,
 * so the pin rides the connection URL as the libpq `options` parameter, which
 * Prisma passes to the server. `DATABASE_SESSION_OPTIONS_DISABLED` (a pooler
 * that refuses `options`) turns it off, as it does for the app.
 *
 * One more thing is done before every `migrate deploy`: a concurrent index
 * build that failed leaves an INVALID index behind, and the re-run of its
 * migration (`CREATE INDEX CONCURRENTLY IF NOT EXISTS`) would find that index
 * and do nothing, recorded applied with an index the planner never uses. So
 * an INVALID index that a not-yet-applied migration builds concurrently is
 * dropped first, and the run builds it again. An INVALID index whose
 * migration is recorded applied is not touched at boot; it is named on
 * stderr with the rebuild that mends it.
 *
 * Environment:
 *   HEALTHLOG_PRISMA_CLI      Prisma's CLI entry (default: the image's copy)
 *   HEALTHLOG_MIGRATIONS_DIR  where the migration files are (default:
 *                             prisma/migrations under the working directory)
 *   HEALTHLOG_MIGRATE_LOCK_RETRY_DELAYS
 *                             comma-separated backoff in seconds
 * Arguments are passed through to every Prisma call (`--schema …`).
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_RETRY_DELAYS_S = [15, 30, 60, 120, 240];

/** The line a migration carries when a lock-timeout retry is safe for it. */
export const RETRY_MARKER = /^--\s*@retry-on-lock-timeout\s*$/m;

/** Lock timeout and deadlock: both leave a marked migration unapplied. */
const LOCK_FAILURES = new Set(["55P03", "40P01"]);
const TIME_ZONE_OPTION = "-c TimeZone=UTC";
const MIGRATION_NAME = /^[A-Za-z0-9_]+$/;

/** The SQLSTATE a P3018 report gives, or null. */
export function errorCodeInReport(text) {
  if (typeof text !== "string") return null;
  return /^Database error code: (\S+)\s*$/m.exec(text)?.[1] ?? null;
}

/**
 * The migration a P3018 report says failed on a lock (a lock timeout or a
 * deadlock), or null. Prisma prints `Migration name: <name>` and
 * `Database error code: <state>` for a migration that failed to apply.
 */
export function lockTimeoutInReport(text) {
  if (typeof text !== "string") return null;
  const name = /^Migration name: (\S+)\s*$/m.exec(text)?.[1];
  const code = errorCodeInReport(text);
  return name && code !== null && LOCK_FAILURES.has(code) ? name : null;
}

/** Whether Prisma refused to start because a failed migration is on record. */
function isFailedMigrationOnRecord(output) {
  return /\bP3009\b/.test(output);
}

/**
 * Decide whether a failed `migrate deploy` is the one failure retried here.
 *
 * @param {object} input
 * @param {string} input.output    everything Prisma printed
 * @param {Array<{migration_name: string, logs: string | null}> | null} input.failedRows
 *   the unfinished, not-rolled-back rows of `_prisma_migrations`, or null
 *   when they were not read
 * @param {(name: string) => string | null} input.readMigration
 *   the migration's SQL, or null when the image does not ship it
 * @returns {{ retry: true, migration: string, code: string } | { retry: false, reason: string }}
 */
export function decideLockRetry({ output, failedRows, readMigration }) {
  let migration = lockTimeoutInReport(output);
  let code = migration ? errorCodeInReport(output) : null;
  if (!migration && isFailedMigrationOnRecord(output) && failedRows) {
    // More than one failed row is not a state this boot can reason about.
    if (failedRows.length === 1) {
      migration = lockTimeoutInReport(failedRows[0].logs);
      code = migration ? errorCodeInReport(failedRows[0].logs) : null;
    }
  }
  if (!migration) {
    return { retry: false, reason: "not a lock timeout" };
  }
  if (!MIGRATION_NAME.test(migration)) {
    return { retry: false, reason: `unexpected migration name ${migration}` };
  }
  const sql = readMigration(migration);
  if (sql === null) {
    return { retry: false, reason: `${migration} is not in this image` };
  }
  if (!RETRY_MARKER.test(sql)) {
    return {
      retry: false,
      reason: `${migration} timed out on a lock but is not marked safe to re-run`,
    };
  }
  return { retry: true, migration, code };
}

/** `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS "<name>"`, comments aside. */
const CONCURRENT_INDEX =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/gim;

/** The indexes a migration file builds concurrently. */
export function concurrentIndexesIn(sql) {
  if (typeof sql !== "string") return [];
  const code = sql.replace(/--[^\n]*/g, "");
  return [...code.matchAll(CONCURRENT_INDEX)].map((m) => m[1]);
}

/**
 * What to do about the INVALID indexes in the schema.
 *
 * @param {object} input
 * @param {string[]} input.invalid      names of the INVALID indexes
 * @param {Map<string, string>} input.builtBy
 *   index name → the migration that builds it concurrently
 * @param {Set<string>} input.applied   migrations recorded applied
 * @returns {{ drop: Array<{ index: string, migration: string }>, report: Array<{ index: string, migration: string | null }> }}
 */
export function invalidIndexPlan({ invalid, builtBy, applied }) {
  const drop = [];
  const report = [];
  for (const index of invalid) {
    const migration = builtBy.get(index) ?? null;
    if (migration !== null && !applied.has(migration)) {
      drop.push({ index, migration });
    } else {
      report.push({ index, migration });
    }
  }
  return { drop, report };
}

/** Every concurrently built index in the migrations directory, by name. */
function concurrentIndexMap(dir) {
  const builtBy = new Map();
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return builtBy;
  }
  const read = migrationReader(dir);
  for (const name of names) {
    for (const index of concurrentIndexesIn(read(name))) {
      builtBy.set(index, name);
    }
  }
  return builtBy;
}

/**
 * Prisma's migration lock: `migrate deploy` holds this advisory lock (in the
 * schema engine, `pg_advisory_lock(72707369)`) for as long as it migrates.
 */
export const PRISMA_MIGRATE_LOCK = 72707369;

/**
 * Drop the INVALID indexes a migration still to run will build, and name the
 * others. Best effort: a database that cannot be read here is left to
 * `migrate deploy`, which reports its own errors.
 *
 * A concurrent build that is still running looks exactly like a failed one,
 * INVALID with its migration not yet finished. With the web and worker roles
 * in two containers, both run this script, and dropping the index the other
 * one is building cancels its migration and leaves it failed. So the check
 * and the drop run in one transaction that first takes Prisma's migration
 * lock without waiting: when another instance is migrating, nothing here is
 * touched, and while this transaction holds it, no migration starts. An
 * index Postgres reports as being built is never dropped either. One
 * transaction also keeps `lock_timeout` on the statement it bounds behind a
 * transaction pooler.
 */
export async function clearInvalidConcurrentIndexes(
  connectionString,
  migrationsDir,
) {
  if (!connectionString) return;
  const builtBy = concurrentIndexMap(migrationsDir);
  let client;
  try {
    const { default: pg } = await import("pg");
    const url = new URL(connectionString);
    const schema = url.searchParams.get("schema") || "public";
    url.searchParams.delete("schema");
    client = new pg.Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 5_000,
    });
    await client.connect();
    const schemaSql = client.escapeIdentifier(schema);
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT pg_try_advisory_xact_lock($1) AS ok",
      [PRISMA_MIGRATE_LOCK],
    );
    if (!locked.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return;
    }
    // Dropping an index takes its table's lock for a moment; never wait on
    // it for long at boot.
    await client.query("SET LOCAL lock_timeout = '5s'");
    const invalid = await client.query(
      `SELECT c.relname AS name FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT i.indisvalid AND n.nspname = $1
          AND NOT EXISTS (
            SELECT 1 FROM pg_stat_progress_create_index p
             WHERE p.index_relid = i.indexrelid
          )`,
      [schema],
    );
    if (invalid.rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }
    const table = `${schemaSql}._prisma_migrations`;
    const exists = await client.query("SELECT to_regclass($1) AS t", [table]);
    const applied = new Set(
      exists.rows[0]?.t
        ? (
            await client.query(
              `SELECT migration_name FROM ${table}
                WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
            )
          ).rows.map((row) => row.migration_name)
        : [],
    );
    const plan = invalidIndexPlan({
      invalid: invalid.rows.map((row) => row.name),
      builtBy,
      applied,
    });
    for (const { index } of plan.drop) {
      await client.query(
        `DROP INDEX IF EXISTS ${schemaSql}.${client.escapeIdentifier(index)}`,
      );
    }
    await client.query("COMMIT");
    for (const { index, migration } of plan.drop) {
      console.log(
        `HealthLog: dropped the invalid index ${index} a failed concurrent ` +
          `build left behind; ${migration} builds it again.`,
      );
    }
    for (const { index, migration } of plan.report) {
      console.error(
        `HealthLog: WARNING — index ${index} is INVALID` +
          (migration ? ` (built by ${migration}, recorded applied)` : "") +
          `; the planner does not use it. Rebuild it with ` +
          `REINDEX INDEX CONCURRENTLY "${index}".`,
      );
    }
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    console.error(
      `HealthLog: could not check for invalid indexes before migrating: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await client?.end().catch(() => {});
  }
}

/** The backoff schedule, from the environment or the default. */
export function retryDelays(raw) {
  if (!raw) return DEFAULT_RETRY_DELAYS_S;
  const delays = raw.split(",").map((part) => Number(part.trim()));
  return delays.every((d) => Number.isFinite(d) && d >= 0)
    ? delays
    : DEFAULT_RETRY_DELAYS_S;
}

/**
 * `DATABASE_URL` with the session time zone pinned to UTC, for Prisma.
 *
 * Appends to an `options` value the operator set rather than replacing it;
 * a later `-c` wins, so an operator's own `TimeZone` gives way to UTC. A URL
 * that does not parse, or a host that disabled the startup options, is
 * returned unchanged.
 *
 * @param {string | undefined} raw
 * @param {{ optionsDisabled?: boolean }} [opts]
 * @returns {string | undefined}
 */
export function utcSessionUrl(raw, { optionsDisabled = false } = {}) {
  if (!raw || optionsDisabled) return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const existing = url.searchParams.get("options")?.trim();
  if (existing && existing.endsWith(TIME_ZONE_OPTION)) return raw;
  url.searchParams.set(
    "options",
    existing ? `${existing} ${TIME_ZONE_OPTION}` : TIME_ZONE_OPTION,
  );
  return url.toString();
}

/** The same switch the app reads in `src/lib/db-session.ts`. */
function sessionOptionsDisabled(env) {
  const raw = env.DATABASE_SESSION_OPTIONS_DISABLED?.trim();
  return raw !== undefined && /^(1|true|yes)$/i.test(raw);
}

/** The environment every Prisma call runs in. */
export function prismaEnv(env = process.env) {
  const url = utcSessionUrl(env.DATABASE_URL, {
    optionsDisabled: sessionOptionsDisabled(env),
  });
  return url === undefined ? { ...env } : { ...env, DATABASE_URL: url };
}

function runPrisma(cli, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: prismaEnv(),
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      output += String(error);
      resolve({ code: 1, output });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** The failed rows of `_prisma_migrations`, or null when they cannot be read. */
async function readFailedRows(connectionString) {
  if (!connectionString) return null;
  try {
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
      const { rows } = await client.query(
        `SELECT migration_name, logs FROM ${client.escapeIdentifier(schema)}._prisma_migrations
         WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
      );
      return rows;
    } finally {
      await client.end().catch(() => {});
    }
  } catch {
    return null;
  }
}

function migrationReader(dir) {
  return (name) => {
    try {
      return readFileSync(join(dir, name, "migration.sql"), "utf8");
    } catch {
      return null;
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main({
  cli = process.env.HEALTHLOG_PRISMA_CLI ||
    "/opt/prisma-cli/node_modules/prisma/build/index.js",
  migrationsDir = process.env.HEALTHLOG_MIGRATIONS_DIR ||
    join(process.cwd(), "prisma", "migrations"),
  delays = retryDelays(process.env.HEALTHLOG_MIGRATE_LOCK_RETRY_DELAYS),
  extraArgs = process.argv.slice(2),
} = {}) {
  const readMigration = migrationReader(migrationsDir);
  for (let attempt = 0; ; attempt++) {
    await clearInvalidConcurrentIndexes(
      process.env.DATABASE_URL,
      migrationsDir,
    );
    const deploy = await runPrisma(cli, ["migrate", "deploy", ...extraArgs]);
    if (deploy.code === 0) return 0;

    const failedRows = isFailedMigrationOnRecord(deploy.output)
      ? await readFailedRows(process.env.DATABASE_URL)
      : null;
    const decision = decideLockRetry({
      output: deploy.output,
      failedRows,
      readMigration,
    });
    if (!decision.retry) {
      if (decision.reason !== "not a lock timeout") {
        console.error(
          `HealthLog: not retrying the migration: ${decision.reason}.`,
        );
      }
      return deploy.code;
    }
    if (attempt >= delays.length) {
      console.error(
        `HealthLog: ERROR — migration ${decision.migration} timed out on a lock ` +
          `${attempt + 1} times in a row; giving up. Something holds the table ` +
          "for minutes: see docs/ops/deploy.md, " +
          '"A migration that timed out on a lock".',
      );
      return deploy.code;
    }
    const delay = delays[attempt];
    const cause =
      decision.code === "40P01"
        ? "was cancelled in a deadlock (40P01)"
        : "timed out waiting for a lock (55P03)";
    console.log(
      `HealthLog: migration ${decision.migration} ${cause} ` +
        `and changed nothing; marking it rolled back and retrying in ` +
        `${delay}s (retry ${attempt + 1} of ${delays.length}).`,
    );
    const resolve = await runPrisma(cli, [
      "migrate",
      "resolve",
      "--rolled-back",
      decision.migration,
      ...extraArgs,
    ]);
    if (resolve.code !== 0) return resolve.code;
    await sleep(delay * 1000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
