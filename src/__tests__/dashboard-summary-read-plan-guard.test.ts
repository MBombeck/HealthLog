/**
 * Structural guards on the two per-type reads behind the dashboard tiles.
 *
 * A database audit against a multi-year account measured both of them as
 * full passes over the largest tables on the dashboard path. The cause is
 * the same in both cases: PostgreSQL 16 has no index skip scan, so a
 * query that wants one row per measurement type but never names a type
 * cannot be served by any index on `(user_id, type, …)` and falls back to
 * reading everything the account owns.
 *
 * Neither shape is a bug a behavioural test can see — both return the
 * right rows. What changes is the plan, and the plan is decided by two
 * properties of the SQL text: that the latest-reading read is driven FROM
 * the type list rather than grouped down to it, and that the rollup read
 * carries a `type` predicate at all. So the guards assert on the SQL.
 *
 * They are tripwires, not proofs. They cannot show a plan is good — only
 * that the two shapes the audit found have not come back. The measured
 * plans live in the integration companion
 * (`tests/integration/dashboard-summary-reads.test.ts`), which runs the
 * same functions against a real Postgres.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./helpers/source-files";

const READS = join(process.cwd(), "src/lib/dashboard/summary-reads.ts");
/** The summary's builder, moved out of its route; it makes the reads. */
const ROUTE = join(process.cwd(), "src/lib/dashboard/summary/build.ts");

/**
 * Source with every comment removed, so a guard matches the SQL the
 * database actually receives and never the prose explaining it. Both
 * files discuss `DISTINCT ON` in their comments on purpose — that is the
 * shape being warned about.
 */
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"), path);
}

describe("dashboard summary reads — latest reading per type", () => {
  it("does not group the account's whole live set down with DISTINCT ON", () => {
    // The shape the audit measured: `SELECT DISTINCT ON (m."type") … FROM
    // measurements`. Whitespace-tolerant, because a reformat must not be
    // able to slip it back past the matcher.
    const distinctOn = /DISTINCT\s+ON\s*\(/i;
    expect(code(READS)).not.toMatch(distinctOn);
    expect(code(ROUTE)).not.toMatch(distinctOn);
  });

  it("drives the read from the type list with a LATERAL lookup per type", () => {
    const sql = code(READS);
    const lateral = sql.match(/CROSS\s+JOIN\s+LATERAL/gi) ?? [];
    expect(lateral.length).toBeGreaterThan(0);
    // The type list has to reach SQL as the driving relation, and the
    // per-type branch has to stop at the first row — without the LIMIT the
    // LATERAL still reads every row of the type partition.
    expect(sql).toMatch(/FROM\s+unnest\(\$\{/);
    expect(sql).toMatch(/ORDER\s+BY\s+m\."measured_at"\s+DESC\s+LIMIT\s+1/);
  });
});

describe("dashboard summary reads — sparkline rollup buckets", () => {
  it("carries a type predicate so the rollup key can drive the read", () => {
    const sql = code(READS);
    // `measurement_rollups` is keyed (user_id, type, granularity,
    // bucket_start, source). Without an equality on `type` the key's
    // second column is skipped and neither the primary key nor the
    // user/type/granularity/bucket index can serve the read.
    const rollupRead = sql.slice(sql.indexOf("FROM measurement_rollups r"));
    expect(rollupRead.length).toBeGreaterThan(0);
    const typePredicate = rollupRead.match(/r\."type"\s*=\s*ANY\(\$\{/g) ?? [];
    expect(typePredicate.length).toBe(1);
    // It has to sit alongside the user and granularity filters, not in a
    // later subquery that the planner reaches only after the scan.
    expect(rollupRead).toMatch(
      /WHERE\s+r\."user_id"\s*=\s*\$\{[^}]+\}\s+AND\s+r\."type"\s*=\s*ANY\(/,
    );
  });

  it("binds the type list as a parameter rather than splicing it", () => {
    // Raw SQL is parameter-bound or whitelist-spliced. The type list is a
    // bound array with an explicit enum cast; a spliced list would also
    // defeat statement reuse.
    const sql = code(READS);
    const casts = sql.match(/\}::"measurement_type"\[\]/g) ?? [];
    expect(casts.length).toBe(3);
    expect(sql).not.toMatch(/\$queryRawUnsafe/);
  });
});

describe("dashboard summary reads — the route keeps using them", () => {
  it("calls the shared readers instead of inlining its own SQL", () => {
    const route = code(ROUTE);
    expect(route).toMatch(/readLatestEver\(prisma, userId, measurementTypes\)/);
    expect(route).toMatch(
      /readSparkBuckets\(\s*prisma,\s*userId,\s*measurementTypes,/,
    );
    expect(route).toMatch(/readActivityDayKeys\(\s*prisma,\s*userId,/);
    // No second copy of a read can drift out of the guarded module.
    expect(route.includes("FROM measurement_rollups")).toBe(false);
    expect(route.includes("FROM measurements")).toBe(false);
  });
});
