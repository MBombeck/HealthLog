/**
 * Structural guard: how a migration bounds its lock wait, and when the boot
 * may retry it.
 *
 * `prisma migrate deploy` runs a migration file statement by statement, each
 * committing on its own; it does not wrap the file in a transaction. Two
 * consequences were written into this repository the other way round:
 *
 * - A top-level `SET LOCAL lock_timeout` does nothing (there is no
 *   transaction for it to be local to), so the migration waits as long as
 *   the lock is held, and every write to the table queues behind it.
 * - A file that fails half-way stays half-applied, so marking it rolled back
 *   and running it again can fail on what already exists, or apply a change
 *   twice.
 *
 * So a lock wait is bounded inside a `DO` block with
 * `set_config('lock_timeout', …, true)`, which is one statement and rolls back
 * whole; and the `-- @retry-on-lock-timeout` marker, which lets
 * `scripts/migrate-deploy.mjs` retry a 55P03 failure on boot, is allowed only
 * on a file whose every other statement is harmless to run again.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RETIRED_MEASUREMENT_INDEXES } from "@/lib/jobs/measurement-maintenance";

import { RETRY_MARKER } from "../../scripts/migrate-deploy.mjs";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

function migrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(MIGRATIONS_DIR, entry.name, "migration.sql"))
    .filter((file) => existsSync(file))
    .map((file) => ({
      name: file.split("/").at(-2) ?? file,
      sql: readFileSync(file, "utf8"),
    }));
}

/** The statements of a file, comments removed, dollar-quoted bodies blanked. */
function topLevelStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "$BODY$")
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => statement.length > 0);
}

/** Statements that leave the database as they found it when run twice. */
const REPEATABLE = [
  /^DO \$BODY\$$/i,
  /^CREATE OR REPLACE (FUNCTION|VIEW|PROCEDURE) /i,
  /^CREATE (UNIQUE )?INDEX IF NOT EXISTS /i,
  /^CREATE TABLE IF NOT EXISTS /i,
  /^ALTER TABLE "?\w+"? ADD COLUMN IF NOT EXISTS /i,
  /^DROP (INDEX|TRIGGER|FUNCTION|TABLE) IF EXISTS /i,
];

/** A session setting changed outside a transaction-scoped `DO` body. */
const TOP_LEVEL_TIMEOUT =
  /^SET (LOCAL |SESSION )?(lock_timeout|statement_timeout)\b|^SET LOCAL\b/i;

function violations(name: string, sql: string): string[] {
  const found: string[] = [];
  const statements = topLevelStatements(sql);
  for (const statement of statements) {
    if (TOP_LEVEL_TIMEOUT.test(statement)) {
      found.push(`${name}: top-level "${statement}" has no effect`);
    }
  }
  const boundsLockWait = /set_config\(\s*'lock_timeout'/i.test(sql);
  const marked = RETRY_MARKER.test(sql);
  if (boundsLockWait && !marked) {
    found.push(
      `${name}: bounds its lock wait but lacks -- @retry-on-lock-timeout`,
    );
  }
  if (marked) {
    for (const statement of statements) {
      if (!REPEATABLE.some((pattern) => pattern.test(statement))) {
        found.push(
          `${name}: marked retry-safe, but "${statement.slice(0, 60)}" is not repeatable`,
        );
      }
    }
  }
  return found;
}

/**
 * `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` refuse to run in a
 * transaction block, and under `migrate deploy` they do so whenever the file
 * holds any other statement (SQLSTATE 25001, seen against Prisma 7 and
 * Postgres 16). Such a statement therefore stands alone in its file.
 */
function concurrentViolations(name: string, sql: string): string[] {
  const statements = topLevelStatements(sql);
  const concurrent = statements.filter((statement) =>
    /\bCONCURRENTLY\b/i.test(statement),
  );
  if (concurrent.length === 0 || statements.length === 1) return [];
  return [
    `${name}: a CONCURRENTLY statement must be the only statement in its file`,
  ];
}

describe("concurrent index statements", () => {
  it("stand alone in their migration file", () => {
    const found = migrations().flatMap(({ name, sql }) =>
      concurrentViolations(name, sql),
    );
    expect(found, found.join("\n")).toEqual([]);
  });

  it("reads the statements there are", () => {
    // No migration holds a concurrent statement since 0416 stopped dropping
    // concurrently; the rule stands for the next one. A reader that stopped
    // splitting statements would see none and pass, so it must see many.
    const statements = migrations().flatMap(({ sql }) =>
      topLevelStatements(sql),
    );
    expect(statements.length).toBeGreaterThan(1000);
  });

  it("refuses a concurrent statement beside another one", () => {
    expect(
      concurrentViolations(
        "a",
        'DROP INDEX CONCURRENTLY IF EXISTS "x";\nDROP INDEX CONCURRENTLY IF EXISTS "y";',
      ),
    ).toHaveLength(1);
    expect(
      concurrentViolations(
        "b",
        '-- CONCURRENTLY in a comment\nDROP INDEX CONCURRENTLY IF EXISTS "x";',
      ),
    ).toEqual([]);
  });
});

/**
 * `DROP INDEX CONCURRENTLY` blocks no reader or writer, but it waits without
 * bound for every transaction on the table, and in a migration that wait is
 * the boot's: a pg_dump or a backfill outlasts the container's start period,
 * the half-applied migration is left on record, and the next boot stops at
 * P3009. An index is retired instead by a bounded `DROP INDEX` that tolerates
 * the timeout, finished by the nightly measurement maintenance (0416).
 */
function concurrentDropViolations(name: string, sql: string): string[] {
  return topLevelStatements(sql).some((statement) =>
    /^DROP INDEX CONCURRENTLY\b/i.test(statement),
  )
    ? [`${name}: DROP INDEX CONCURRENTLY waits on the table at boot`]
    : [];
}

describe("retired indexes", () => {
  it("are never dropped concurrently in the boot path", () => {
    const found = migrations().flatMap(({ name, sql }) =>
      concurrentDropViolations(name, sql),
    );
    expect(found, found.join("\n")).toEqual([]);
  });

  it("are each dropped by a migration that bounds its wait and tolerates the timeout", () => {
    expect(RETIRED_MEASUREMENT_INDEXES.length).toBeGreaterThan(0);
    for (const index of RETIRED_MEASUREMENT_INDEXES) {
      const owner = migrations().find(({ sql }) =>
        new RegExp(`DROP INDEX IF EXISTS "${index}"`).test(sql),
      );
      expect(owner, index).toBeDefined();
      expect(owner?.sql).toMatch(/set_config\(\s*'lock_timeout'/);
      expect(owner?.sql).toMatch(/EXCEPTION WHEN lock_not_available THEN/);
    }
  });

  it("counter-check: refuses a concurrent drop, not one in a comment", () => {
    expect(
      concurrentDropViolations(
        "a",
        'DROP INDEX CONCURRENTLY IF EXISTS "measurements_x_idx";',
      ),
    ).toHaveLength(1);
    expect(
      concurrentDropViolations(
        "b",
        '-- DROP INDEX CONCURRENTLY "x";\nDROP INDEX IF EXISTS "x";',
      ),
    ).toEqual([]);
  });
});

describe("migration lock waits", () => {
  it("bounds lock waits where they take effect and marks only repeatable files", () => {
    const found = migrations().flatMap(({ name, sql }) =>
      violations(name, sql),
    );
    expect(found, found.join("\n")).toEqual([]);
  });

  it("sees the migrations that bound their wait", () => {
    const marked = migrations()
      .filter(({ sql }) => RETRY_MARKER.test(sql))
      .map(({ name }) => name);
    expect(marked).toContain("0412_measurement_hot_updates");
    expect(marked).toContain("0414_drop_medication_compliance_rollups");
    expect(marked).toContain("0415_foreign_key_and_prefix_indexes");
    expect(marked).toContain("0416_drop_measurements_type_prefix_index");
  });

  it("catches each shape it exists to refuse", () => {
    expect(violations("a", "SET LOCAL lock_timeout = '10s';")).toHaveLength(1);
    expect(
      violations(
        "b",
        "DO $x$ BEGIN PERFORM set_config('lock_timeout', '1s', true); END $x$;",
      ),
    ).toHaveLength(1);
    expect(
      violations(
        "c",
        "-- @retry-on-lock-timeout\nCREATE TRIGGER t BEFORE UPDATE ON m FOR EACH ROW EXECUTE FUNCTION f();\nDO $x$ BEGIN PERFORM set_config('lock_timeout', '1s', true); END $x$;",
      ),
    ).toEqual([expect.stringContaining("is not repeatable")]);
    expect(
      violations(
        "d",
        "-- @retry-on-lock-timeout\nCREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;\nDO $x$ BEGIN PERFORM set_config('lock_timeout', '1s', true); END $x$;",
      ),
    ).toEqual([]);
  });
});

/**
 * From 0475 on, a statement that takes a table lock runs inside a `DO` block
 * that bounds its wait. A bare `ALTER TABLE` waits behind every open
 * transaction on the table, and every write to it queues behind the waiting
 * `ALTER`, for as long as the longest of them runs: under a backfill or a
 * pg_dump that is the boot's start period gone, and the half-applied file is
 * left on record. Older files are history; they ran and are not run again.
 */
const LOCK_BOUND_FROM = 475;

/** Top-level statements that take a table lock and wait for it. */
const TABLE_LOCK =
  /^(ALTER TABLE|CREATE (UNIQUE )?INDEX (?!CONCURRENTLY)|DROP (TABLE|INDEX) (?!CONCURRENTLY)|LOCK )/i;

function unboundedLockViolations(name: string, sql: string): string[] {
  const number = Number.parseInt(name.slice(0, 4), 10);
  if (!(number >= LOCK_BOUND_FROM)) return [];
  return topLevelStatements(sql)
    .filter((statement) => TABLE_LOCK.test(statement))
    .map(
      (statement) =>
        `${name}: "${statement.slice(0, 60)}" waits for its table lock without bound; run it in a DO block with set_config('lock_timeout', …, true)`,
    );
}

describe("table locks since 0475", () => {
  it("are taken inside a block that bounds the wait", () => {
    const checked = migrations().filter(
      ({ name }) => Number.parseInt(name.slice(0, 4), 10) >= LOCK_BOUND_FROM,
    );
    expect(checked.length).toBeGreaterThan(5);
    const found = checked.flatMap(({ name, sql }) =>
      unboundedLockViolations(name, sql),
    );
    expect(found, found.join("\n")).toEqual([]);
  });

  it("catches each shape it exists to refuse", () => {
    expect(
      unboundedLockViolations(
        "0999_a",
        'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c" INTEGER;',
      ),
    ).toHaveLength(1);
    expect(
      unboundedLockViolations("0999_b", 'CREATE INDEX "i" ON "t" ("c");'),
    ).toHaveLength(1);
    expect(
      unboundedLockViolations(
        "0999_c",
        "DO $m$ BEGIN PERFORM set_config('lock_timeout', '5s', true); ALTER TABLE \"t\" ADD COLUMN \"c\" INTEGER; END $m$;",
      ),
    ).toEqual([]);
    expect(
      unboundedLockViolations(
        "0999_d",
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" ("c");',
      ),
    ).toEqual([]);
    // History is not re-run.
    expect(
      unboundedLockViolations("0100_e", 'ALTER TABLE "t" ADD COLUMN "c" INT;'),
    ).toEqual([]);
  });
});
