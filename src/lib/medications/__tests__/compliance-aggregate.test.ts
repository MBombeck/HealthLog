import { describe, expect, it } from "vitest";

import { aggregateCompliance } from "../compliance-payload";

function result(taken: number, missed: number, skipped = 0, streak = 0) {
  return {
    totalExpected: taken + missed + skipped,
    taken,
    skipped,
    missed,
    rate:
      taken + missed > 0 ? Math.round((100 * taken) / (taken + missed)) : 100,
    streak,
  };
}

describe("aggregateCompliance", () => {
  it("weights by expected doses rather than averaging the rates", () => {
    // A three-times-daily tablet at 60/90 and a weekly injection at 4/4.
    // The mean of the rates would read 83 %; the doses say 64/94 = 68 %.
    const out = aggregateCompliance([result(60, 30), result(4, 0)]);
    expect(out).toMatchObject({
      totalExpected: 94,
      taken: 64,
      missed: 30,
      rate: 68,
    });
  });

  it("keeps skipped doses out of the rate, as a single medication's tally does", () => {
    expect(aggregateCompliance([result(9, 1, 5)])?.rate).toBe(90);
    expect(aggregateCompliance([result(9, 1, 5)])?.totalExpected).toBe(15);
  });

  it("takes the shortest streak, because a day counts only when every medication was taken", () => {
    expect(
      aggregateCompliance([result(5, 0, 0, 12), result(5, 0, 0, 3)])?.streak,
    ).toBe(3);
  });

  it("is null when nothing contributes", () => {
    expect(aggregateCompliance([])).toBeNull();
  });
});
