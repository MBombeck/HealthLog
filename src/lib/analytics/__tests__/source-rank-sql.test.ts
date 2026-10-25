/**
 * Unit pins for the source-rank SQL builders.
 *
 * `canonicalMeasurementsCte` (v1.18.11 perf#3a) was extracted so a statement
 * that references the canonical-source set more than once can bind it as a
 * single `WITH cm AS (…)` CTE and fold away the duplicate DISTINCT-ON
 * self-join. These tests pin:
 *   1. the alias-wrapped `canonicalMeasurementsFrom` is exactly the CTE body
 *      wrapped in `( … ) m` — so the single-reference call site is unchanged;
 *   2. the canonical body reads `measurements` once and picks with one window
 *      function, with no join for the planner to run as a nested loop — so a
 *      fold that references the CTE twice runs the pick once, and a table
 *      without statistics cannot turn it quadratic;
 *   3. the interval whitelist still rejects an unsafe splice;
 *   4. the window counts from an instant the caller took, never from the
 *      database clock.
 */
import { describe, expect, it } from "vitest";

import { boundInstantSql, instantLiteralSql } from "../request-clock-sql";
import {
  canonicalMeasurementsCte,
  canonicalMeasurementsFrom,
} from "../source-rank-sql";

const RANK = "90";
const NINETY_DAYS = { from: boundInstantSql(2), interval: "90 days" };

describe("canonicalMeasurementsCte / canonicalMeasurementsFrom", () => {
  it("wraps the CTE body verbatim in the ( … ) m alias", () => {
    const cte = canonicalMeasurementsCte(RANK, NINETY_DAYS);
    const from = canonicalMeasurementsFrom(RANK, NINETY_DAYS);
    // The alias form is the CTE body plus the closing `) m` wrapper. Pinning
    // equality means the single-reference call sites keep byte-stable SQL
    // while the CTE body can be reused for the folded double-reference case.
    expect(from).toBe(`(${cte}\n      ) m`);
  });

  it("picks with one window over one scan, with no join", () => {
    const cte = canonicalMeasurementsCte(RANK, NINETY_DAYS);
    expect(cte.match(/FROM measurements\b/g) ?? []).toHaveLength(1);
    expect(cte.match(/FIRST_VALUE\(/g) ?? []).toHaveLength(1);
    expect(cte).not.toMatch(/\bJOIN\b|DISTINCT ON/);
  });

  it("binds the user id as $1 and scopes the scan to the window", () => {
    const cte = canonicalMeasurementsCte(RANK, NINETY_DAYS);
    // user id is always a bound parameter, never spliced.
    expect(cte).toContain('"user_id" = $1');
    // The trailing-window bound scopes the one scan, so the pick and the rows
    // it keeps are cut by the same window.
    const intervalMatches =
      cte.match(/>= \$2::timestamp - INTERVAL '90 days'/g) ?? [];
    expect(intervalMatches).toHaveLength(1);
  });

  it("never cuts its window on the database clock", () => {
    for (const cte of [
      canonicalMeasurementsCte(RANK, NINETY_DAYS),
      canonicalMeasurementsCte(RANK, { from: boundInstantSql(3) }),
      canonicalMeasurementsCte(RANK, {
        from: instantLiteralSql(new Date("2026-03-01T06:30:00.000Z")),
        interval: "1 day",
      }),
    ]) {
      expect(cte).not.toMatch(/NOW\(\)|CURRENT_|LOCALTIMESTAMP/i);
    }
    expect(
      canonicalMeasurementsCte(RANK, {
        from: instantLiteralSql(new Date("2026-03-01T06:30:00.000Z")),
        interval: "1 day",
      }),
    ).toContain(`>= '2026-03-01 06:30:00.000'::timestamp - INTERVAL '1 day'`);
  });

  it("omits the window clause entirely when no interval is given", () => {
    const cte = canonicalMeasurementsCte(RANK);
    expect(cte).not.toContain("INTERVAL");
  });

  it("rejects an unsafe interval splice", () => {
    expect(() =>
      canonicalMeasurementsCte(RANK, {
        from: boundInstantSql(2),
        interval: "90 days; DROP TABLE",
      }),
    ).toThrow(/unsafe interval/);
  });

  it("rejects an instant that is neither a bound parameter nor a literal it wrote", () => {
    for (const from of [
      "NOW()",
      "$2",
      "'2026-03-01'::timestamp",
      "$2::timestamp; DROP TABLE",
    ]) {
      expect(() =>
        canonicalMeasurementsCte(RANK, { from, interval: "90 days" }),
      ).toThrow(/unsafe instant/);
    }
  });
});
