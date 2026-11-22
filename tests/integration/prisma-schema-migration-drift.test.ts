/**
 * The migrations and `prisma/schema.prisma` describe the same database.
 *
 * `prisma-schema-name-drift.test.ts` proves one direction for names only:
 * everything the schema names exists. Types, nullability, defaults, foreign
 * keys and indexes were checked by nobody, and they had drifted by 61
 * statements: `prisma migrate diff` against a freshly migrated database
 * wanted to drop the GIN index the document search runs on, convert five
 * `timestamptz` columns to `timestamp`, relax two NOT NULL columns, drop two
 * foreign keys and rename some thirty indexes. Every `prisma migrate dev` writes
 * that diff into the next generated migration, so a contributor who did not
 * prune it by hand shipped it.
 *
 * So this asks Prisma itself: the database the integration run migrated from
 * `prisma/migrations`, diffed against the schema, must need no statement at
 * all. It diffs a fresh copy of the migrated template, not this worker's
 * clone: the clone carries whatever earlier files in the worker did to it,
 * and a migration test that replays an old migration whole (0515, in
 * `dose-slot-merge.test.ts`) rebuilds an index a later migration (0538)
 * dropped, so the check failed or passed on the order the files ran in. Objects Prisma cannot express
 * (expression and partial indexes, CHECK constraints, triggers) do not show
 * up in its diff; should one ever surface, it goes in `ALLOWED` with the reason.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cloneTemplateDatabase,
  dropClonedDatabase,
  workerDatabaseName,
} from "./worker-database";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");

/**
 * Statements the diff may contain, each with the reason Prisma cannot be
 * told about the object. Empty today.
 */
const ALLOWED: ReadonlyArray<{ statement: RegExp; reason: string }> = [];

/** The worker's clone, which earlier files in the worker may have changed. */
const WORKER_URL = process.env.DATABASE_URL!;
/** A copy of the template as the migrations left it, for this file alone. */
const FRESH = `${workerDatabaseName()}_drift`;
let freshUrl = "";

const dirs: string[] = [];
beforeAll(async () => {
  freshUrl = await cloneTemplateDatabase(WORKER_URL, FRESH);
});
afterAll(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  await dropClonedDatabase(WORKER_URL, FRESH);
});

function diff(
  schemaPath: string,
  databaseUrl = freshUrl,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, "node_modules", "prisma", "build", "index.js"),
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        schemaPath,
        "--script",
      ],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl } },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("close", (code) =>
      resolve({ code: code ?? 1, output: code === 0 ? output : errors }),
    );
  });
}

/** The SQL statements of a `migrate diff --script`, comments dropped. */
function statements(script: string): string[] {
  return script
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => statement.length > 0);
}

function unexplained(script: string): string[] {
  return statements(script).filter(
    (statement) => !ALLOWED.some(({ statement: s }) => s.test(statement)),
  );
}

describe("prisma schema and migrations", () => {
  it("leave nothing for migrate diff to do", async () => {
    const result = await diff(SCHEMA);
    expect(result.code, result.output).toBe(0);
    const drift = unexplained(result.output);
    expect(
      drift,
      `schema.prisma and prisma/migrations disagree. Fix the schema (or add a migration) until \`prisma migrate diff\` is empty:\n${drift.join(";\n")}`,
    ).toEqual([]);
  });

  it("does not see what an earlier file did to the worker's clone", async () => {
    // The stray index a replayed migration leaves behind. The worker's clone
    // shows it (so the probe is real); the fresh copy the check reads does not.
    const worker = new Client({ connectionString: WORKER_URL });
    await worker.connect();
    try {
      await worker.query(
        `CREATE INDEX IF NOT EXISTS "drift_probe_stray_idx" ON "users" ("created_at")`,
      );
      const polluted = await diff(SCHEMA, WORKER_URL);
      expect(polluted.code, polluted.output).toBe(0);
      expect(unexplained(polluted.output)).toContain(
        'DROP INDEX "drift_probe_stray_idx"',
      );
      const result = await diff(SCHEMA);
      expect(result.code, result.output).toBe(0);
      expect(unexplained(result.output)).toEqual([]);
    } finally {
      await worker.query(`DROP INDEX IF EXISTS "drift_probe_stray_idx"`);
      await worker.end();
    }
  });

  it("sees a drift when there is one", async () => {
    // A schema that forgot one index the migrations build: the check must
    // name the DROP, or it is a check that cannot fail.
    const original = readFileSync(SCHEMA, "utf8");
    const forgotten = original.replace(
      '  @@index([searchTokens], type: Gin, map: "document_content_index_search_tokens_gin")\n',
      "",
    );
    expect(forgotten).not.toBe(original);
    const dir = mkdtempSync(join(tmpdir(), "hl-schema-drift-"));
    dirs.push(dir);
    const path = join(dir, "schema.prisma");
    writeFileSync(path, forgotten);
    const result = await diff(path);
    expect(result.code, result.output).toBe(0);
    expect(unexplained(result.output)).toEqual([
      'DROP INDEX "document_content_index_search_tokens_gin"',
    ]);
  });
});
