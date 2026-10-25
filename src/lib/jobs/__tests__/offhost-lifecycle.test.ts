/**
 * Which lifecycle rules retire the database dumps under `database/`, apart
 * from the account copies: a rule scoped to another prefix, or to a tag, does
 * not touch them.
 */
import { describe, expect, it } from "vitest";
import type { LifecycleRule } from "@aws-sdk/client-s3";

import { lifecycleFromRules, ruleAppliesTo } from "../offhost-lifecycle";

const DUMP = "database/healthlog-20261025T013000Z-daily.dump.enc";

function rule(days: number, extra: Partial<LifecycleRule> = {}): LifecycleRule {
  return { Status: "Enabled", Expiration: { Days: days }, ...extra };
}

describe("lifecycle rules and the database dumps", () => {
  it("counts a rule for the whole bucket, or for database/, for both", () => {
    expect(lifecycleFromRules([rule(30)])).toEqual({
      state: "configured",
      expirationDays: 30,
      database: { state: "configured", expirationDays: 30 },
    });
    expect(
      lifecycleFromRules([
        rule(30, { Filter: { Prefix: "2026-" } }),
        rule(14, { Filter: { Prefix: "database/" } }),
      ]).database,
    ).toEqual({ state: "configured", expirationDays: 14 });
  });

  it("says database/ is not covered when the only rule is scoped elsewhere", () => {
    const result = lifecycleFromRules([
      rule(30, { Filter: { Prefix: "2026-" } }),
    ]);
    expect(result.state).toBe("configured");
    expect(result.database).toEqual({ state: "missing", expirationDays: null });
  });

  it("reads the legacy prefix, the And filter, tags and disabled rules", () => {
    expect(ruleAppliesTo(rule(5, { Prefix: "database/" }), DUMP)).toBe(true);
    expect(ruleAppliesTo(rule(5, { Prefix: "other/" }), DUMP)).toBe(false);
    expect(
      ruleAppliesTo(
        rule(5, {
          Filter: { And: { Prefix: "database/", ObjectSizeGreaterThan: 1 } },
        }),
        DUMP,
      ),
    ).toBe(true);
    expect(
      ruleAppliesTo(
        rule(5, { Filter: { Tag: { Key: "k", Value: "v" } } }),
        DUMP,
      ),
    ).toBe(false);
    expect(
      lifecycleFromRules([rule(7, { Status: "Disabled" })]).database.state,
    ).toBe("missing");
  });
});
