/**
 * Vitest globalSetup — boots ONE Postgres testcontainer for the whole
 * integration run, migrates ONE template database, and hands the workers
 * what they need to clone it. The teardown returned at the end stops the
 * container after all test files have finished.
 *
 * Why one container and a template:
 *   - Applying the migration history takes seconds; copying a migrated
 *     database with `CREATE DATABASE … TEMPLATE` takes a fraction of one.
 *     Each Vitest worker therefore gets its own clone (see
 *     `worker-database.ts`), cloned once per worker rather than once per
 *     file or test, and files run in parallel without seeing each other's
 *     rows, advisory locks or queue schema.
 *   - The application's Prisma singleton in `src/lib/db.ts` is built at
 *     module load time from `process.env.DATABASE_URL`. A worker's URL is
 *     fixed before any application module loads (`environment-setup.ts`),
 *     so the singleton always points at that worker's clone.
 *
 * What the template carries besides the schema is recorded here as well:
 * the rows the migrations seed (the mood-tag and symptom catalogues, the
 * settings singleton). `setup.ts -> truncateAllTables` empties every table
 * and puts exactly these rows back, so a test starts from the state a fresh
 * install has, and the truncate list is the catalogue rather than a list
 * somebody has to remember to extend.
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import type { TestProject } from "vitest/node";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

import {
  TEMPLATE_DATABASE,
  type IntegrationDatabasePlan,
  type ReferenceTable,
} from "./worker-database";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");

// The compose file ships Postgres 18; INTEGRATION_PG_IMAGE runs the same
// suite against another major. The nightly run uses it for Postgres 16, the
// oldest major a self-host on its own database may still run.
const POSTGRES_IMAGE =
  process.env.INTEGRATION_PG_IMAGE?.trim() || "postgres:18-alpine";

let started: StartedPostgreSqlContainer | null = null;

declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
    integrationDatabasePlan: IntegrationDatabasePlan;
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  let container = new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(TEMPLATE_DATABASE)
    .withUsername("healthlog")
    .withPassword("healthlog")
    // A throwaway cluster: durability buys nothing here and costs every
    // commit a flush. Several workers each hold a Prisma pool and, in the
    // queue tests, a pg-boss pool, so the default of 100 connections is
    // raised well past what parallel workers can open.
    .withCommand([
      "postgres",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "max_connections=400",
    ]);
  // A CPU quota for the database container, to reproduce a CI runner's
  // contention on a larger machine: HEALTHLOG_INTEGRATION_PG_CPUS=2.
  const cpus = Number.parseFloat(
    process.env.HEALTHLOG_INTEGRATION_PG_CPUS ?? "",
  );
  if (Number.isFinite(cpus) && cpus > 0) {
    container = container.withResourcesQuota({ cpu: cpus });
  }
  started = await container.start();

  const url = started.getConnectionUri() + "?schema=public&pgbouncer=false";
  process.env.DATABASE_URL = url;

  // The explicit child environment keeps Prisma CLI on the same container.
  execSync("pnpm db:migrate:deploy", {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });

  project.provide("integrationDatabaseUrl", url);
  project.provide("integrationDatabasePlan", await readTemplate(url));

  return async () => {
    if (started) {
      await started.stop({ remove: true });
      started = null;
    }
  };
}

/**
 * Read what a fresh install holds: its schemas, its tables, and the rows the
 * migrations seed, in an order that satisfies the foreign keys between them.
 * The connection is closed before any worker clones the template, because
 * Postgres refuses to copy a database somebody is connected to.
 */
async function readTemplate(url: string): Promise<IntegrationDatabasePlan> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const schemas = (
      await client.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace
          WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
          ORDER BY nspname`,
      )
    ).rows.map((r) => r.nspname);

    const tables = (
      await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
          ORDER BY tablename`,
      )
    ).rows.map((r) => r.tablename);
    if (tables.length < 100) {
      throw new Error(
        `the migrated template has only ${tables.length} tables; the migration step did not run`,
      );
    }

    const seeded: string[] = [];
    for (const table of tables) {
      const { rows } = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM "${table}") AS present`,
      );
      if (rows[0]?.present) seeded.push(table);
    }

    // A seeded table whose key comes from a sequence would collide with the
    // next insert once `RESTART IDENTITY` rewinds it. None does today; the
    // check keeps it that way rather than leaving a silent collision.
    const sequenced = await client.query<{ table: string }>(
      `SELECT DISTINCT c.relname AS table
         FROM pg_depend d
         JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
         JOIN pg_class c ON c.oid = d.refobjid
        WHERE c.relname = ANY($1::text[])`,
      [seeded],
    );
    if (sequenced.rows.length > 0) {
      throw new Error(
        `seeded tables with sequence-backed keys are not supported by the reseed: ${sequenced.rows.map((r) => r.table).join(", ")}`,
      );
    }

    const edges = (
      await client.query<{ child: string; parent: string }>(
        `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
           FROM pg_constraint
          WHERE contype = 'f'
            AND conrelid::regclass::text = ANY($1::text[])
            AND confrelid::regclass::text = ANY($1::text[])
            AND conrelid <> confrelid`,
        [seeded],
      )
    ).rows;

    const reference: ReferenceTable[] = [];
    for (const table of topologicalOrder(seeded, edges)) {
      const { rows } = await client.query<{ rows: string }>(
        `SELECT COALESCE(json_agg(t), '[]'::json)::text AS rows FROM "${table}" t`,
      );
      reference.push({ table, rowsJson: rows[0].rows });
    }

    return { templateSchemas: schemas, tables, reference };
  } finally {
    await client.end();
  }
}

function topologicalOrder(
  tables: readonly string[],
  edges: ReadonlyArray<{ child: string; parent: string }>,
): string[] {
  const ordered: string[] = [];
  const pending = new Set(tables);
  while (pending.size > 0) {
    const ready = [...pending].filter(
      (t) => !edges.some((e) => e.child === t && pending.has(e.parent)),
    );
    if (ready.length === 0) {
      throw new Error(
        `seeded tables reference each other in a cycle: ${[...pending].join(", ")}`,
      );
    }
    for (const t of ready.sort()) {
      ordered.push(t);
      pending.delete(t);
    }
  }
  return ordered;
}
