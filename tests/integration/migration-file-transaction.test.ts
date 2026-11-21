/**
 * How the real Prisma CLI runs a migration file, against the real Postgres.
 *
 * The lock guard (`src/__tests__/migration-lock-timeout-guard.test.ts`) and
 * the boot's retry (`scripts/migrate-deploy.mjs`) both rest on one fact that
 * neither can see from the SQL alone, and that the repository had written down
 * two contradicting ways:
 *
 * - a file with a dollar-quoted body anywhere is sent as one query, which
 *   Postgres runs as one implicit transaction: all of it or none of it, every
 *   lock held to the end;
 * - a file without one is split and sent statement by statement, each
 *   committing on its own: a failure leaves the earlier statements applied.
 *
 * Both are proven here through `prisma migrate deploy` itself, in a schema of
 * their own, and so is where a `statement_timeout` has to be set to bound a
 * block's work: as a statement of its own before the block, since the timeout
 * is armed when a statement starts. A multi-statement `pg` query would show the first behaviour for
 * every file and prove nothing about the split.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { runsAsOneTransaction } from "../../scripts/migrate-deploy.mjs";

const SCHEMA = "migration_file_probe";
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

async function connect(): Promise<Client> {
  const url = new URL(baseUrl());
  url.searchParams.delete("schema");
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

function deploy(dir: string): Promise<{ code: number; output: string }> {
  const url = new URL(baseUrl());
  url.searchParams.set("schema", SCHEMA);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, "node_modules", "prisma", "build", "index.js"),
        "migrate",
        "deploy",
        "--schema",
        join(dir, "schema.prisma"),
      ],
      // The repository root, for its Prisma config; `--schema` points the
      // migrations directory at the probe.
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: url.toString() } },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** A migrations directory holding one migration, `0001_probe`. */
function probe(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hl-migration-file-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "schema.prisma"),
    'datasource db {\n  provider = "postgresql"\n}\n',
  );
  mkdirSync(join(dir, "migrations", "0001_probe"), { recursive: true });
  cpSync(
    join(ROOT, "prisma", "migrations", "migration_lock.toml"),
    join(dir, "migrations", "migration_lock.toml"),
  );
  writeFileSync(join(dir, "migrations", "0001_probe", "migration.sql"), sql);
  return dir;
}

async function tableExists(db: Client, table: string): Promise<boolean> {
  const { rows } = await db.query<{ t: string | null }>(
    "SELECT to_regclass($1) AS t",
    [`${SCHEMA}.${table}`],
  );
  return rows[0]?.t !== null;
}

beforeEach(async () => {
  const db = await connect();
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
});

describe("prisma migrate deploy, one file", () => {
  it("runs a file with a DO block as one transaction, rolled back whole on failure", async () => {
    const sql = [
      'CREATE TABLE "before_failure" ("n" integer);',
      "DO $m$ BEGIN PERFORM 1; END $m$;",
      "SELECT 1 / 0;",
      "",
    ].join("\n");
    expect(runsAsOneTransaction(sql)).toBe(true);
    const result = await deploy(probe(sql));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Database error code: 22012");
    const db = await connect();
    try {
      expect(await tableExists(db, "before_failure")).toBe(false);
    } finally {
      await db.end();
    }
  });

  it("runs a file without one statement by statement, leaving what came before a failure", async () => {
    const sql = [
      'CREATE TABLE "before_failure" ("n" integer);',
      "SELECT 1 / 0;",
      "",
    ].join("\n");
    expect(runsAsOneTransaction(sql)).toBe(false);
    const result = await deploy(probe(sql));
    expect(result.code).not.toBe(0);
    const db = await connect();
    try {
      expect(await tableExists(db, "before_failure")).toBe(true);
    } finally {
      await db.end();
    }
  });

  it("gives every statement of a DO-block file the same transaction, and a split file one each", async () => {
    const one = await deploy(
      probe(
        [
          'CREATE TABLE "tx" ("n" integer, "xid" bigint);',
          'INSERT INTO "tx" VALUES (1, txid_current());',
          "DO $m$ BEGIN PERFORM 1; END $m$;",
          'INSERT INTO "tx" VALUES (2, txid_current());',
          "",
        ].join("\n"),
      ),
    );
    expect(one.code, one.output).toBe(0);
    const db = await connect();
    try {
      const joint = await db.query<{ n: string }>(
        `SELECT count(DISTINCT xid) AS n FROM ${SCHEMA}.tx`,
      );
      expect(Number(joint.rows[0].n)).toBe(1);
      await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    } finally {
      await db.end();
    }

    const split = await deploy(
      probe(
        [
          'CREATE TABLE "tx" ("n" integer, "xid" bigint);',
          'INSERT INTO "tx" VALUES (1, txid_current());',
          'INSERT INTO "tx" VALUES (2, txid_current());',
          "",
        ].join("\n"),
      ),
    );
    expect(split.code, split.output).toBe(0);
    const again = await connect();
    try {
      const apart = await again.query<{ n: string }>(
        `SELECT count(DISTINCT xid) AS n FROM ${SCHEMA}.tx`,
      );
      expect(Number(apart.rows[0].n)).toBe(2);
    } finally {
      await again.end();
    }
  });

  it("bounds a block's run time by SET LOCAL statement_timeout before it", async () => {
    const result = await deploy(
      probe(
        [
          "SET LOCAL statement_timeout = '1s';",
          "DO $m$ BEGIN PERFORM pg_sleep(3); END $m$;",
          "",
        ].join("\n"),
      ),
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Database error code: 57014");
  });

  it("does not bound a block by set_config('statement_timeout') inside it", async () => {
    // The shape the migrations guard refuses: the block runs past the bound
    // it sets for itself, and the file applies.
    const result = await deploy(
      probe(
        [
          "DO $m$ BEGIN",
          "  PERFORM set_config('statement_timeout', '1s', true);",
          "  PERFORM pg_sleep(2);",
          "END $m$;",
          "",
        ].join("\n"),
      ),
    );
    expect(result.code, result.output).toBe(0);
  });
});
