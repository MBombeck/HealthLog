/**
 * Structural guard: how a migration bounds its lock wait, how long it holds
 * what it takes, and when the boot may retry it.
 *
 * `prisma migrate deploy` runs a file one of two ways, and which one depends
 * on the file (pinned against the real CLI by
 * `tests/integration/migration-file-transaction.test.ts`):
 *
 * - A file with a dollar-quoted body anywhere (a `DO` block, a function) is
 *   sent as one query: one implicit transaction. It applies whole or not at
 *   all, and every lock any statement takes is held until the file's last
 *   statement has run.
 * - A file without one is sent statement by statement, each committing on its
 *   own. A failure leaves the earlier statements applied, and a top-level
 *   `SET LOCAL lock_timeout` does nothing.
 *
 * The rules that follow from that:
 *
 * - A lock wait is bounded inside a `DO` block with
 *   `set_config('lock_timeout', …, true)`. The block makes the file one
 *   transaction, so the bound holds for every statement after it.
 * - The `-- @retry-on-lock-timeout` marker, which lets
 *   `scripts/migrate-deploy.mjs` retry a 55P03 failure on boot, is safe on a
 *   one-transaction file by construction; on a file split by statement it is
 *   allowed only when every statement is harmless to run again.
 * - In a one-transaction file, splitting `ADD CONSTRAINT … NOT VALID` from
 *   `VALIDATE CONSTRAINT` buys nothing: the scan runs while the ACCESS
 *   EXCLUSIVE lock of the `ADD` is still held. Long work (a `VALIDATE`, a
 *   backfill on a large table, a plain index build on one) therefore stands
 *   in a file that takes no other table lock, and bounds its own run time
 *   with `SET LOCAL statement_timeout` as a statement of its own before the
 *   work, since `lock_timeout` only bounds the wait for a lock, never the
 *   time spent holding it. Set with `set_config` inside the block that does
 *   the work, the timeout does not bound that block.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RETIRED_MEASUREMENT_INDEXES } from "@/lib/jobs/measurement-maintenance";

import {
  RETRY_MARKER,
  runsAsOneTransaction,
  topLevelStatements,
} from "../../scripts/migrate-deploy.mjs";

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

/**
 * The one top-level setting that takes effect: `SET LOCAL statement_timeout`
 * in a file that runs as one transaction. The timeout is armed when a
 * statement starts, so only a statement of its own before the work can bound
 * it (see "long work since 0517" below). A lock wait is still bounded inside
 * the block, where `set_config('lock_timeout', …, true)` works.
 */
const LOCAL_STATEMENT_TIMEOUT = /^SET LOCAL statement_timeout\b/i;

function violations(name: string, sql: string): string[] {
  const found: string[] = [];
  const statements = topLevelStatements(sql);
  const oneTransaction = runsAsOneTransaction(sql);
  for (const statement of statements) {
    if (oneTransaction && LOCAL_STATEMENT_TIMEOUT.test(statement)) continue;
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
  if (marked && !runsAsOneTransaction(sql)) {
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
 * transaction block (SQLSTATE 25001), which a file with any dollar-quoted body
 * is. A file split by statement would run it, but would also leave the
 * statements before a failed build applied. Such a statement therefore stands
 * alone in its file.
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
    // A split file has no transaction for SET LOCAL to be local to.
    expect(
      violations("a2", "SET LOCAL statement_timeout = '5min';"),
    ).toHaveLength(1);
    // A session-wide SET outlives the file even in one transaction.
    expect(
      violations(
        "a3",
        "SET statement_timeout = '5min';\nDO $x$ BEGIN PERFORM 1; END $x$;",
      ),
    ).toHaveLength(1);
    expect(
      violations(
        "a4",
        "SET LOCAL statement_timeout = '5min';\nDO $x$ BEGIN PERFORM 1; END $x$;",
      ),
    ).toEqual([]);
    expect(
      violations(
        "b",
        "DO $x$ BEGIN PERFORM set_config('lock_timeout', '1s', true); END $x$;",
      ),
    ).toHaveLength(1);
    // Split by statement (no dollar-quoted body): a failed attempt leaves
    // the trigger behind, and the retry fails on it.
    expect(
      violations(
        "c",
        '-- @retry-on-lock-timeout\nCREATE TRIGGER t BEFORE UPDATE ON m FOR EACH ROW EXECUTE FUNCTION f();\nCREATE INDEX IF NOT EXISTS "i" ON "m" ("c");',
      ),
    ).toEqual([expect.stringContaining("is not repeatable")]);
    // The same statement beside a `DO` block is one transaction, which a
    // failed attempt rolls back whole.
    expect(
      violations(
        "c2",
        "-- @retry-on-lock-timeout\nCREATE TRIGGER t BEFORE UPDATE ON m FOR EACH ROW EXECUTE FUNCTION f();\nDO $x$ BEGIN PERFORM set_config('lock_timeout', '1s', true); END $x$;",
      ),
    ).toEqual([]);
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

/**
 * From 0517 on, long work in a one-transaction file stands apart from every
 * table lock: the locks a file takes are held until it ends, so an `ADD
 * CONSTRAINT … NOT VALID` followed by its `VALIDATE` in the same file scans
 * the table under ACCESS EXCLUSIVE after all (0476, 0509, 0511 did), and a
 * backfill beside an `ALTER TABLE` keeps the table closed to reads and writes
 * for the whole backfill (0476). The long work also bounds its own run time.
 */
const LONG_WORK_FROM = 517;

/**
 * Tables that grow with every reading, dose, or delivery and keep growing.
 * A ledger that a retention purge holds to a few weeks or months is not one.
 */
const LARGE_TABLES = new Set([
  "measurements",
  "measurement_rollups",
  "medication_intake_events",
  "audit_logs",
  "push_attempts",
  "notification_events",
  "workout_samples",
]);

const TABLE = String.raw`(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?`;

function matches(pattern: RegExp, sql: string): string[] {
  return [...sql.matchAll(pattern)].map((m) => m[1].toLowerCase());
}

/** Each match of `pattern` as its lower-cased table and its offset. */
function located(
  pattern: RegExp,
  sql: string,
): Array<{ table: string; at: number }> {
  return [...sql.matchAll(pattern)].map((m) => ({
    table: m[1].toLowerCase(),
    at: m.index ?? 0,
  }));
}

/** What in the file runs long (a scan, a backfill, a plain index build), and where. */
function longWorkAt(sql: string): Array<{ label: string; at: number }> {
  const work: Array<{ label: string; at: number }> = [];
  for (const { table, at } of located(
    new RegExp(
      String.raw`\bALTER\s+TABLE\s+${TABLE}\s+VALIDATE\s+CONSTRAINT\b`,
      "gi",
    ),
    sql,
  )) {
    work.push({ label: `VALIDATE on ${table}`, at });
  }
  for (const { table, at } of located(
    new RegExp(String.raw`\b(?:UPDATE|DELETE\s+FROM)\s+${TABLE}`, "gi"),
    sql,
  )) {
    if (LARGE_TABLES.has(table))
      work.push({ label: `backfill on ${table}`, at });
  }
  for (const { table, at } of located(
    new RegExp(
      String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)[^;]*?\bON\s+${TABLE}`,
      "gi",
    ),
    sql,
  )) {
    if (LARGE_TABLES.has(table)) {
      work.push({ label: `index build on ${table}`, at });
    }
  }
  return work.sort((a, b) => a.at - b.at);
}

function longWork(sql: string): string[] {
  return longWorkAt(sql).map(({ label }) => label);
}

/**
 * The file with every dollar-quoted body blanked to spaces, so an offset in
 * it is an offset in the file, and only top-level text is left to match.
 */
function topLevelOnly(sql: string): string {
  return sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, (body) =>
    " ".repeat(body.length),
  );
}

/**
 * `statement_timeout` is armed when a top-level statement starts. Set from
 * inside a `DO` block, it bounds only the statements that start after that
 * block, never the block's own work (probed on Postgres 18, pinned through
 * the real CLI in `tests/integration/migration-file-transaction.test.ts`).
 * The bound that holds is `SET LOCAL statement_timeout` as a statement of its
 * own, before the statement that does the work, in a one-transaction file.
 */
const TOP_LEVEL_STATEMENT_TIMEOUT = /\bSET\s+LOCAL\s+statement_timeout\b/i;
const STATEMENT_TIMEOUT_SET_CONFIG = /set_config\(\s*'statement_timeout'/i;

function statementTimeoutViolations(name: string, sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, "");
  const top = topLevelOnly(code);
  if (
    STATEMENT_TIMEOUT_SET_CONFIG.test(code) &&
    !STATEMENT_TIMEOUT_SET_CONFIG.test(top)
  ) {
    return [
      `${name}: set_config('statement_timeout') inside a dollar-quoted body does not bound that body; use SET LOCAL statement_timeout as its own statement before it`,
    ];
  }
  return [];
}

/** The tables the file locks for longer than a statement's own work. */
function heldLocks(sql: string): string[] {
  return [
    ...matches(
      new RegExp(String.raw`\bALTER\s+TABLE\s+${TABLE}\s+(?!VALIDATE\s)`, "gi"),
      sql,
    ),
    ...matches(
      new RegExp(String.raw`\bLOCK\s+(?:TABLE\s+)?${TABLE}`, "gi"),
      sql,
    ),
  ];
}

function longWorkViolations(name: string, sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, "");
  const work = longWork(code);
  if (work.length === 0) return [];
  const found: string[] = [];
  if (!runsAsOneTransaction(code)) {
    found.push(
      `${name}: ${work.join(", ")} outside a DO block cannot bound its run time`,
    );
  } else {
    const bound = topLevelOnly(code).search(TOP_LEVEL_STATEMENT_TIMEOUT);
    const first = longWorkAt(code)[0].at;
    if (bound < 0 || bound > first) {
      found.push(
        `${name}: ${work.join(", ")} without SET LOCAL statement_timeout as its own statement before it`,
      );
    }
  }
  const held = [...new Set(heldLocks(code))];
  if (held.length > 0) {
    found.push(
      `${name}: ${work.join(", ")} runs while the file holds its lock on ${held.join(", ")}; move one of them to a file of its own`,
    );
  }
  return found;
}

describe("long work since 0517", () => {
  it("stands apart from table locks and bounds its run time", () => {
    const checked = migrations().filter(
      ({ name }) => Number.parseInt(name.slice(0, 4), 10) >= LONG_WORK_FROM,
    );
    // No count floor: until a migration at or past 0517 exists there is
    // nothing to check, and "names the history" below proves the matcher bites.
    const found = checked.flatMap(({ name, sql }) => [
      ...longWorkViolations(name, sql),
      ...statementTimeoutViolations(name, sql),
    ]);
    expect(found, found.join("\n")).toEqual([]);
  });

  it("names the history it was written from", () => {
    // These ran before the rule and are not run again; the rule must still
    // see what they did, or it would pass the next one that does the same.
    const history = new Map(migrations().map(({ name, sql }) => [name, sql]));
    for (const name of [
      "0476_token_apple_health_mirror",
      "0509_hypertension_event",
      "0511_apple_health_v2_types",
    ]) {
      const sql = history.get(name);
      expect(sql, name).toBeDefined();
      expect(longWorkViolations(name, sql ?? ""), name).toContainEqual(
        expect.stringMatching(/holds its lock on .*\bmeasurements\b/),
      );
    }
  });

  it("catches each shape it exists to refuse", () => {
    const block = (body: string) =>
      `SET LOCAL statement_timeout = '5min';\nDO $m$ BEGIN PERFORM set_config('lock_timeout', '5s', true); ${body} END $m$;`;
    expect(
      longWorkViolations(
        "a",
        block(
          'ALTER TABLE "t" ADD CONSTRAINT "c" CHECK (x > 0) NOT VALID; ALTER TABLE "t" VALIDATE CONSTRAINT "c";',
        ),
      ),
    ).toEqual([expect.stringContaining("holds its lock on t")]);
    expect(
      longWorkViolations(
        "b",
        block('UPDATE "measurements" SET "x" = 1 WHERE "x" IS NULL;'),
      ),
    ).toEqual([]);
    expect(
      longWorkViolations(
        "c",
        'DO $m$ BEGIN UPDATE "measurements" SET "x" = 1; END $m$;',
      ),
    ).toEqual([expect.stringContaining("SET LOCAL statement_timeout")]);
    expect(
      longWorkViolations(
        "d",
        block(
          'CREATE INDEX "i" ON "measurements" ("x"); ALTER TABLE "users" ADD COLUMN "y" INT;',
        ),
      ),
    ).toEqual([expect.stringContaining("holds its lock on users")]);
    // The bound set inside the block that does the work, or after it, does
    // not hold; the one before it in a comment is no bound at all.
    const inside = `DO $m$ BEGIN PERFORM set_config('statement_timeout', '5min', true); UPDATE "measurements" SET "x" = 1; END $m$;`;
    expect(longWorkViolations("f", inside)).toEqual([
      expect.stringContaining("SET LOCAL statement_timeout"),
    ]);
    expect(statementTimeoutViolations("f", inside)).toEqual([
      expect.stringContaining("does not bound that body"),
    ]);
    expect(
      longWorkViolations(
        "g",
        `DO $m$ BEGIN UPDATE "measurements" SET "x" = 1; END $m$;\nSET LOCAL statement_timeout = '5min';`,
      ),
    ).toEqual([expect.stringContaining("SET LOCAL statement_timeout")]);
    expect(
      longWorkViolations(
        "h",
        `-- SET LOCAL statement_timeout = '5min';\nDO $m$ BEGIN UPDATE "measurements" SET "x" = 1; END $m$;`,
      ),
    ).toEqual([expect.stringContaining("SET LOCAL statement_timeout")]);
    expect(
      statementTimeoutViolations(
        "i",
        `SET LOCAL statement_timeout = '5min';\nDO $m$ BEGIN UPDATE "measurements" SET "x" = 1; END $m$;`,
      ),
    ).toEqual([]);
    // A small table's update is not long work, nor is a comment.
    expect(
      longWorkViolations(
        "e",
        '-- UPDATE "measurements" SET x = 1;\nALTER TABLE "users" ADD COLUMN "y" INT; UPDATE "users" SET "y" = 1;',
      ),
    ).toEqual([]);
  });
});

/**
 * From 0517 on, a unique index built in place on a table the file first
 * checks or rewrites takes a write-blocking lock on that table before the
 * check. Between a clash count (0517) or a de-duplication (0529) and the
 * build, an older container still serving during the upgrade can write a
 * row that clashes again: the build fails with 23505, and the boot stops at
 * P3009. `SHARE ROW EXCLUSIVE` holds writes back for the rest of the file
 * and lets reads go on; the file's `lock_timeout` bounds the wait for it. A
 * table the same file creates has no other writer.
 */
const UNIQUE_RACE_FROM = 517;

const WRITE_BLOCKING_LOCK = new RegExp(
  String.raw`\bLOCK\s+(?:TABLE\s+)?${TABLE}\s+IN\s+(?:SHARE\s+ROW\s+EXCLUSIVE|EXCLUSIVE|ACCESS\s+EXCLUSIVE)\s+MODE\b`,
  "gi",
);

function uniqueBuildRaceViolations(name: string, sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, "");
  const found: string[] = [];
  const builds = located(
    new RegExp(
      String.raw`\bCREATE\s+UNIQUE\s+INDEX\s+(?!CONCURRENTLY)[^;]*?\bON\s+${TABLE}`,
      "gi",
    ),
    code,
  );
  const seen = new Set<string>();
  for (const { table, at } of builds) {
    if (seen.has(table)) continue;
    seen.add(table);
    const before = code.slice(0, at);
    const created = located(
      new RegExp(
        String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}`,
        "gi",
      ),
      before,
    ).some((m) => m.table === table);
    if (created) continue;
    const firstTouch = located(
      new RegExp(String.raw`\b(?:FROM|UPDATE|INTO)\s+${TABLE}`, "gi"),
      before,
    ).find((m) => m.table === table);
    if (!firstTouch) continue;
    const locked = located(WRITE_BLOCKING_LOCK, before).some(
      (m) => m.table === table && m.at < firstTouch.at,
    );
    if (!locked) {
      found.push(
        `${name}: reads or rewrites ${table} before its unique index without LOCK TABLE "${table}" IN SHARE ROW EXCLUSIVE MODE first; a concurrent write can fail the build`,
      );
    }
  }
  return found;
}

describe("unique index builds since 0517", () => {
  it("lock out writes between their check and the build", () => {
    const found = migrations()
      .filter(
        ({ name }) => Number.parseInt(name.slice(0, 4), 10) >= UNIQUE_RACE_FROM,
      )
      .flatMap(({ name, sql }) => uniqueBuildRaceViolations(name, sql));
    expect(found, found.join("\n")).toEqual([]);
  });

  it("sees the files it was written from", () => {
    const byName = new Map(migrations().map(({ name, sql }) => [name, sql]));
    for (const [name, table] of [
      ["0517_case_insensitive_identity_and_retention_indexes", "users"],
      ["0529_push_relay_hardening", "devices"],
    ] as const) {
      const sql = byName.get(name);
      expect(sql, name).toBeDefined();
      // Without its lock the file is exactly the shape the rule refuses.
      const unlocked = (sql ?? "").replace(
        new RegExp(
          String.raw`LOCK TABLE "${table}" IN SHARE ROW EXCLUSIVE MODE;`,
        ),
        "",
      );
      expect(unlocked).not.toBe(sql);
      expect(uniqueBuildRaceViolations(name, unlocked)).toEqual([
        expect.stringContaining(`rewrites ${table} before its unique index`),
      ]);
    }
  });

  it("catches each shape it exists to refuse", () => {
    const check =
      'SELECT count(*) FROM "users" GROUP BY lower("email") HAVING count(*) > 1;';
    const build =
      'CREATE UNIQUE INDEX IF NOT EXISTS "k" ON "users" (lower("email"));';
    const lock = 'LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE;';
    const block = (body: string) => `DO $m$ BEGIN ${body} END $m$;`;
    expect(uniqueBuildRaceViolations("a", block(check + build))).toHaveLength(
      1,
    );
    expect(uniqueBuildRaceViolations("b", block(lock + check + build))).toEqual(
      [],
    );
    // A lock taken after the check comes too late.
    expect(
      uniqueBuildRaceViolations("c", block(check + lock + build)),
    ).toHaveLength(1);
    // A weaker lock lets writes through.
    expect(
      uniqueBuildRaceViolations(
        "d",
        block(
          'LOCK TABLE "users" IN SHARE MODE;' +
            'UPDATE "users" SET "email" = lower("email");' +
            build,
        ),
      ),
    ).toHaveLength(1);
    // A build with no check before it, or on a table the file creates.
    expect(uniqueBuildRaceViolations("e", block(build))).toEqual([]);
    expect(
      uniqueBuildRaceViolations(
        "f",
        block(
          'CREATE TABLE IF NOT EXISTS "users" ("email" TEXT);' +
            "INSERT INTO \"users\" VALUES ('a');" +
            build,
        ),
      ),
    ).toEqual([]);
  });
});
