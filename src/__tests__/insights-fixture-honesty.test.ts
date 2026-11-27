/**
 * The populated Insights fixture paints only what a server could send.
 *
 * Screenshots of the score pages are taken over `mockPopulatedInsights`, and
 * a fixture state reads in a screenshot exactly like a defect: a failed
 * lipids read on an account that never had a lab, a delta of +2 above a
 * history chart that says no score was ever recorded. Both shipped in the
 * fixture once, and both were reported as product bugs.
 *
 * So the default fixture is an account a person could have, and its delta is
 * the move between two points of the history it serves. The states a
 * geometry guard needs and no account carries together stay behind the
 * explicit `everyState` switch.
 */
import { describe, expect, it } from "vitest";

import {
  HEALTH_SCORE_SHOWN,
  healthScoreHistoryPoints,
  healthScoreReport,
} from "../../e2e/utils/mock-populated-insights";

function reasons(report: ReturnType<typeof healthScoreReport>): string[] {
  return report.pillars.flatMap((pillar) =>
    pillar.result.status === "insufficient" ? [pillar.result.reason] : [],
  );
}

describe("the populated Insights fixture", () => {
  it("carries no failed read and no withheld pillar by default", () => {
    const fixture = reasons(healthScoreReport(false));
    expect(fixture).not.toContain("read_failed");
    expect(fixture).not.toContain("crisis_signposting");
  });

  it("keeps both rare states behind the explicit switch", () => {
    const fixture = reasons(healthScoreReport(true));
    expect(fixture).toContain("read_failed");
    expect(fixture).toContain("crisis_signposting");
  });

  it("serves a delta that is the move between two points of its history", () => {
    const report = healthScoreReport(false);
    const points = healthScoreHistoryPoints(30);
    const today = points.at(-1)!;
    const weekAgo = points.at(-8)!;
    expect(report.composite.value.score).toBe(HEALTH_SCORE_SHOWN);
    expect(today.value).toBe(report.composite.value.score);
    expect(report.delta).toBe(today.value - weekAgo.value);
    expect(report.deltaReason).toBeNull();
  });
});
