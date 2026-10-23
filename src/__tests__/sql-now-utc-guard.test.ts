/**
 * Raw SQL never reads the clock through the session time zone.
 *
 * Stored times are UTC in `timestamp` columns without a zone. Postgres
 * compares such a column with `NOW()` / `CURRENT_TIMESTAMP` /
 * `clock_timestamp()` by converting through the session time zone, and
 * assigns one of them to such a column the same way, so on a database whose
 * default is not UTC a fresh passkey challenge read as already expired. Every
 * connection is pinned to UTC (`@/lib/db-session`), and on top of that every
 * raw-SQL clock read writes `NOW() AT TIME ZONE 'UTC'`, which yields the naive
 * UTC timestamp whatever the session says.
 *
 * The few bare reads left are listed below with the reason they are safe:
 * each feeds a `timestamptz` column or returns the instant to JavaScript.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, readSourceText } from "./helpers/source-files";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/**
 * Every bare clock read that is deliberately left: the file, how many such
 * reads it holds, and why. The count makes the exception cover those reads
 * and not the next one written into the same file.
 */
const ALLOWED: Record<string, { hits: number; why: string }> = {
  "src/lib/rollups/mood-rollups.ts": {
    hits: 1,
    why: "computed_at is timestamptz",
  },
  "src/lib/jobs/job-failures.ts": {
    hits: 2,
    why: "pg-boss tables are timestamptz",
  },
  "src/lib/jobs/heavy-lane.ts": {
    hits: 1,
    why: "pg-boss start_after is timestamptz",
  },
  "src/lib/jobs/backup-restore-wait.ts": {
    hits: 1,
    why: "pg-boss start_after is timestamptz",
  },
  "src/lib/jobs/reminder/registrar-shared.ts": {
    hits: 1,
    why: "pg-boss tables are timestamptz",
  },
  "src/lib/db-compat.ts": {
    hits: 1,
    why: "DDL default on a timestamptz column",
  },
};

const SQL_CLOCK =
  /(?<![.\w])(?:NOW\(\)|CURRENT_TIMESTAMP\b|clock_timestamp\(\))|(?:(?<!=)[<>]|=)\s*now\(\)\s*(?:$|[,)]|[-+]\s*(?:make_interval|INTERVAL))|\bnow\(\)\s*[-+]\s*(?:make_interval|INTERVAL)/;
const ANCHORED =
  /(?:NOW\(\)|CURRENT_TIMESTAMP|clock_timestamp\(\)) AT TIME ZONE 'UTC'/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "generated" || name === "__tests__") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(full);
  }
  return out;
}

/** Every bare clock read in the tree, allowed or not. */
function bareReads(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    readSourceText(file)
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*|--)/.test(line)) return;
        if (SQL_CLOCK.test(line.replace(ANCHORED, ""))) {
          found.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  return found;
}

describe("raw SQL clock reads are anchored to UTC", () => {
  it("finds the anchored form across the swept files", () => {
    // The matcher must see something, or a broken walk would pass.
    const passkey = readSource("src/lib/auth/passkey.ts", ANCHORED);
    expect(passkey.match(ANCHORED)?.length).toBeGreaterThanOrEqual(3);
    expect(SQL_CLOCK.test("AND expires_at > NOW()")).toBe(true);
    expect(SQL_CLOCK.test("updated_at = now()")).toBe(true);
    expect(SQL_CLOCK.test("const started = now();")).toBe(false);
    expect(SQL_CLOCK.test("elapsedMs: () => now() - started,")).toBe(false);
    expect(SQL_CLOCK.test("const ends = now() + perCallMs;")).toBe(false);
    expect(
      SQL_CLOCK.test("deleted_at >= now() - make_interval(days => 1)"),
    ).toBe(true);
    expect(SQL_CLOCK.test("Date.now()")).toBe(false);
  });

  it("leaves no bare NOW() / CURRENT_TIMESTAMP outside the allowlist", () => {
    const reads = bareReads();
    const inFile = (rel: string) =>
      reads.filter((r) => r.startsWith(`${rel}:`)).length;
    const over = reads.filter((r) => {
      const rel = r.slice(0, r.indexOf(":"));
      return !ALLOWED[rel] || inFile(rel) > ALLOWED[rel].hits;
    });
    expect(over).toEqual([]);
  });

  it("keeps the allowlist honest: every entry holds exactly its count", () => {
    const reads = bareReads();
    for (const [rel, { hits }] of Object.entries(ALLOWED)) {
      expect(reads.filter((r) => r.startsWith(`${rel}:`)).length, rel).toBe(
        hits,
      );
    }
  });
});
