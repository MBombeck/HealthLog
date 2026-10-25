/**
 * A concurrent index build that failed leaves an INVALID index behind, and
 * `CREATE INDEX CONCURRENTLY IF NOT EXISTS` finds that index and does
 * nothing: the migration re-run after `migrate resolve --rolled-back` is
 * recorded applied while the index it exists for is never used, and nothing
 * says so (0477 has this shape).
 *
 * The boot (`scripts/migrate-deploy.mjs`) drops such an index first, when the
 * migration that builds it is not applied, so the re-run builds it again. The
 * probe runs the real script and the real CLI against a schema of its own.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearInvalidConcurrentIndexes,
  PRISMA_MIGRATE_LOCK,
} from "../../scripts/migrate-deploy.mjs";

const SCHEMA = "invalid_index_probe";
const NAME = "0002_probe_value_index";
const INDEX = "probe_value_key";
const ROOT = process.cwd();

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  const db = await connect();
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
});

function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set for the integration run");
  return url;
}

function probeUrl(): string {
  const url = new URL(baseUrl());
  url.searchParams.set("schema", SCHEMA);
  return url.toString();
}

async function connect(): Promise<Client> {
  const url = new URL(baseUrl());
  url.searchParams.delete("schema");
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

function write(dir: string, name: string, sql: string) {
  mkdirSync(join(dir, "migrations", name), { recursive: true });
  writeFileSync(join(dir, "migrations", name, "migration.sql"), sql);
}

function prisma(dir: string, args: string[]) {
  return run(join(ROOT, "node_modules", "prisma", "build", "index.js"), [
    ...args,
    "--schema",
    join(dir, "schema.prisma"),
  ]);
}

function migrateDeploy(dir: string) {
  return run(join(ROOT, "scripts", "migrate-deploy.mjs"), [
    "--schema",
    join(dir, "schema.prisma"),
  ]);
}

function run(
  script: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: probeUrl(),
        HEALTHLOG_PRISMA_CLI: join(
          ROOT,
          "node_modules",
          "prisma",
          "build",
          "index.js",
        ),
        HEALTHLOG_MIGRATIONS_DIR: currentDir,
        HEALTHLOG_MIGRATE_LOCK_RETRY_DELAYS: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

let currentDir = "";

async function indexState(db: Client) {
  const { rows } = await db.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [SCHEMA, INDEX],
  );
  return rows[0]?.valid ?? null;
}

beforeEach(async () => {
  const db = await connect();
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
});

describe("a concurrent index build that failed", () => {
  it("is built again when its migration is re-run, not skipped as present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hl-invalid-index-"));
    dirs.push(dir);
    currentDir = join(dir, "migrations");
    writeFileSync(
      join(dir, "schema.prisma"),
      'datasource db {\n  provider = "postgresql"\n}\n',
    );
    mkdirSync(join(dir, "migrations"), { recursive: true });
    cpSync(
      join(ROOT, "prisma", "migrations", "migration_lock.toml"),
      join(dir, "migrations", "migration_lock.toml"),
    );
    // Two rows that break the unique build, the way a constraint violation,
    // a cancel or a killed container leaves a concurrent build half done.
    write(
      dir,
      "0001_probe_table",
      `CREATE TABLE "probe" ("id" integer PRIMARY KEY, "value" integer);
       INSERT INTO "probe" VALUES (1, 7), (2, 7);`,
    );
    write(
      dir,
      NAME,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "probe" ("value");`,
    );

    const failed = await migrateDeploy(dir);
    expect(failed.code).not.toBe(0);
    const db = await connect();
    try {
      expect(await indexState(db)).toBe(false);

      // The operator mends the data and marks the attempt rolled back, as
      // docs/ops/deploy.md says.
      await db.query(`DELETE FROM ${SCHEMA}.probe WHERE id = 2`);
      const resolved = await prisma(dir, [
        "migrate",
        "resolve",
        "--rolled-back",
        NAME,
      ]);
      expect(resolved.code, resolved.stderr).toBe(0);

      const again = await migrateDeploy(dir);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain(`dropped the invalid index ${INDEX}`);
      expect(await indexState(db)).toBe(true);
    } finally {
      await db.end();
    }
  });
});

/**
 * A build still running is INVALID too, and with the web and worker roles in
 * two containers the second one's boot runs the cleanup while the first one
 * migrates. Dropping that index cancels the first one's migration and leaves
 * it failed, so the cleanup must leave a running build alone.
 */
describe("a concurrent index build still running", () => {
  async function slowBuildFixture(db: Client): Promise<void> {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(
      `CREATE TABLE ${SCHEMA}.probe (id integer PRIMARY KEY, value integer)`,
    );
    await db.query(
      `INSERT INTO ${SCHEMA}.probe SELECT g, g FROM generate_series(1, 400) g`,
    );
    // Slow on purpose, so the build is caught half way.
    await db.query(
      `CREATE FUNCTION ${SCHEMA}.probe_slow(v integer) RETURNS integer
         LANGUAGE plpgsql IMMUTABLE AS $$
         BEGIN PERFORM pg_sleep(0.005); RETURN v; END $$`,
    );
    const dir = mkdtempSync(join(tmpdir(), "hl-running-index-"));
    dirs.push(dir);
    currentDir = join(dir, "migrations");
    write(
      dir,
      NAME,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "probe" (probe_slow("value"));`,
    );
  }

  async function caughtHalfWay(
    holdMigrateLock: boolean,
  ): Promise<{ builder: Client; build: Promise<unknown> }> {
    const builder = await connect();
    if (holdMigrateLock) {
      await builder.query("SELECT pg_advisory_lock($1)", [PRISMA_MIGRATE_LOCK]);
    }
    const build = builder.query(
      `CREATE INDEX CONCURRENTLY "${INDEX}" ON ${SCHEMA}.probe (${SCHEMA}.probe_slow(value))`,
    );
    const db = await connect();
    try {
      const until = Date.now() + 10_000;
      while ((await indexState(db)) !== false && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await indexState(db)).toBe(false);
    } finally {
      await db.end();
    }
    return { builder, build };
  }

  for (const [label, holdMigrateLock] of [
    ["another instance migrating", true],
    ["a build outside any migration", false],
  ] as const) {
    it(`leaves the index of ${label} alone`, async () => {
      const db = await connect();
      try {
        await slowBuildFixture(db);
        const { builder, build } = await caughtHalfWay(holdMigrateLock);
        try {
          await clearInvalidConcurrentIndexes(probeUrl(), currentDir);
          await expect(build).resolves.toBeDefined();
          expect(await indexState(db)).toBe(true);
        } finally {
          await builder.end();
        }
      } finally {
        await db.end();
      }
    }, 60_000);
  }
});
