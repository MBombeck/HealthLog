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
 * `prisma/migrations` (this worker's clone of the template), diffed against
 * the schema, must need no statement at all. Objects Prisma cannot express
 * (expression and partial indexes, CHECK constraints, triggers) do not show
 * up in its diff; should one ever surface, it goes in `ALLOWED` with the reason.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");

/**
 * Statements the diff may contain, each with the reason Prisma cannot be
 * told about the object. Empty today.
 */
const ALLOWED: ReadonlyArray<{ statement: RegExp; reason: string }> = [];

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function diff(schemaPath: string): Promise<{ code: number; output: string }> {
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
      { cwd: ROOT, env: { ...process.env } },
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
