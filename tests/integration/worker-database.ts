/**
 * One database per Vitest worker, cloned from the migrated template.
 *
 * `global-setup.ts` migrates `TEMPLATE_DATABASE` once. Each worker, on its
 * first file, copies it into `healthlog_test_w<pool id>` with
 * `CREATE DATABASE … TEMPLATE`, and every later file in that worker reuses
 * the copy. Rows, advisory locks (scoped per database), `LISTEN` channels and
 * the pg-boss schema therefore never cross between files running at the same
 * time in different workers.
 *
 * Postgres refuses to copy a database while anyone is connected to it,
 * including another copy in progress, so clones are serialised with an
 * advisory lock held on the maintenance database. Nothing connects to the
 * template after global setup has read it.
 *
 * This module deliberately imports nothing from the application: it runs
 * from `environment-setup.ts` before `DATABASE_URL` is final.
 */
import { Client } from "pg";

export const TEMPLATE_DATABASE = "healthlog_test";

/**
 * Tables the migrations seed but a test starts without.
 *
 * `app_settings` holds the instance singleton. The application creates it on
 * first read, and tests create it with the values they mean to test; a seeded
 * copy would make every such `create` collide. Every other seeded table (the
 * mood-tag, cycle-symptom and illness-symptom catalogues) is reference data a
 * fresh install always has, so it is put back after each truncate.
 */
export const START_EMPTY_TABLES: readonly string[] = ["app_settings"];

export interface ReferenceTable {
  table: string;
  /** The template's rows as a JSON array, in insert order across tables. */
  rowsJson: string;
}

export interface IntegrationDatabasePlan {
  /** Schemas a fresh install has; anything else is runtime state. */
  templateSchemas: string[];
  /** Every table in `public` except the migration bookkeeping. */
  tables: string[];
  /** Seeded tables in foreign-key order, with their seeded rows. */
  reference: ReferenceTable[];
}

/** The worker's database name. `VITEST_POOL_ID` runs from 1 to maxWorkers. */
export function workerDatabaseName(
  poolId: string | undefined = process.env.VITEST_POOL_ID,
): string {
  const id = Number.parseInt(poolId ?? "1", 10);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(`unusable VITEST_POOL_ID: ${String(poolId)}`);
  }
  return `${TEMPLATE_DATABASE}_w${id}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Copy the migrated template into `name` unless it exists, under the clone
 * lock, and return its URL. `templateUrl` is any URL on the run's server.
 *
 * Besides the worker clones, a file that must see exactly what the
 * migrations built (the schema drift check) takes a fresh copy of its own:
 * the worker's clone carries whatever earlier files in that worker did to it,
 * such as a migration test that replays an old migration and so rebuilds an
 * index a later one dropped.
 */
export async function cloneTemplateDatabase(
  templateUrl: string,
  name: string,
): Promise<string> {
  const maintenance = new Client({
    connectionString: withDatabase(templateUrl, "postgres"),
  });
  await maintenance.connect();
  try {
    const exists = async () =>
      (
        await maintenance.query(
          `SELECT 1 FROM pg_database WHERE datname = $1`,
          [name],
        )
      ).rowCount === 1;
    if (!(await exists())) {
      await maintenance.query(
        `SELECT pg_advisory_lock(hashtext('healthlog-integration-clone'))`,
      );
      try {
        if (!(await exists())) {
          await maintenance.query(
            `CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`,
          );
        }
      } finally {
        await maintenance.query(
          `SELECT pg_advisory_unlock(hashtext('healthlog-integration-clone'))`,
        );
      }
    }
  } finally {
    await maintenance.end();
  }
  return withDatabase(templateUrl, name);
}

/** Drop a database `cloneTemplateDatabase` made, closing its connections. */
export async function dropClonedDatabase(
  templateUrl: string,
  name: string,
): Promise<void> {
  const maintenance = new Client({
    connectionString: withDatabase(templateUrl, "postgres"),
  });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}

/**
 * Make sure this worker's clone exists and carries no runtime schema left by
 * an earlier file, then return its URL.
 *
 * Runtime schemas are the ones a fresh install does not have: pg-boss creates
 * `pgboss` the first time a queue starts, and a few migration tests create
 * probe schemas. A file starts without them, so whether a queue table exists
 * never depends on which file happened to run earlier in the same worker.
 */
export async function prepareWorkerDatabase(
  templateUrl: string,
  plan: IntegrationDatabasePlan,
): Promise<string> {
  const url = await cloneTemplateDatabase(templateUrl, workerDatabaseName());
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
          AND nspname <> ALL($1::text[])`,
      [plan.templateSchemas],
    );
    for (const { nspname } of rows) {
      await db.query(`DROP SCHEMA "${nspname.replace(/"/g, '""')}" CASCADE`);
    }
  } finally {
    await db.end();
  }
  return url;
}
