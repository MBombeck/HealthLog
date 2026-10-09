import { describe, expect, it } from "vitest";
import {
  buildAssessmentContextBlock,
  computeSteadyRun,
  formatDataStrength,
  formatRelationsBlock,
  formatRepetitionSignal,
  formatVarietyHint,
  pickVarietyLead,
  type RelevantCorrelation,
} from "../assessment-context";

describe("pickVarietyLead — deterministic per-render variety token", () => {
  it("is stable for the same (user, metric, day)", () => {
    const a = pickVarietyLead("u-1", "RESTING_HEART_RATE", "2026-06-05");
    const b = pickVarietyLead("u-1", "RESTING_HEART_RATE", "2026-06-05");
    expect(a).toBe(b);
  });

  it("rotates across days and across metrics (not a constant)", () => {
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"].map(
      (d) => pickVarietyLead("u-1", "STEPS", d),
    );
    const metrics = ["STEPS", "SLEEP_DURATION", "VO2_MAX", "BLOOD_GLUCOSE"].map(
      (m) => pickVarietyLead("u-1", m, "2026-06-05"),
    );
    // Across these inputs we expect more than one distinct lead to appear,
    // proving the token is not collapsed to a single constant.
    expect(new Set([...days, ...metrics]).size).toBeGreaterThan(1);
  });

  it("only ever returns one of the three known leads", () => {
    for (let i = 0; i < 50; i++) {
      const lead = pickVarietyLead("u", `M${i}`, "2026-06-05");
      expect(["trend", "latest", "consistency"]).toContain(lead);
    }
  });

  it("never uses Math.random / Date.now (reproducible across calls in different ticks)", () => {
    const first = pickVarietyLead(
      "u-7",
      "HEART_RATE_VARIABILITY",
      "2026-06-05",
    );
    // A second call after some work must match — proves no time/random seed.
    for (let i = 0; i < 1000; i++) fnvBusy(i);
    const second = pickVarietyLead(
      "u-7",
      "HEART_RATE_VARIABILITY",
      "2026-06-05",
    );
    expect(second).toBe(first);
  });
});

function fnvBusy(n: number): number {
  let x = n;
  for (let i = 0; i < 100; i++) x = (x * 31 + i) >>> 0;
  return x;
}

describe("formatVarietyHint", () => {
  it("never forces a trend — advisory only", () => {
    for (const lead of ["trend", "latest", "consistency"] as const) {
      expect(formatVarietyHint(lead, "en")).toMatch(/never invent a trend/i);
      expect(formatVarietyHint(lead, "de")).toMatch(
        /nie einen Trend erfinden/i,
      );
    }
  });
});

describe("formatDataStrength — surfaces n + recency for honest hedging", () => {
  it("flags thin data so the prose hedges (English)", () => {
    const out = formatDataStrength({ points: 3, newestDaysAgo: 1 }, "en");
    expect(out).toContain("DATA STRENGTH");
    expect(out).toContain("3 day-buckets");
    expect(out).toMatch(/too few points/i);
  });

  it("flags stale data when newest reading is old (German)", () => {
    const out = formatDataStrength({ points: 30, newestDaysAgo: 19 }, "de");
    expect(out).toContain("DATENLAGE");
    expect(out).toMatch(/19 Tagen/);
    expect(out).toMatch(/veralten/i);
  });

  it("adds no hedge guidance when data is strong and fresh", () => {
    const out = formatDataStrength({ points: 40, newestDaysAgo: 0 }, "en");
    expect(out).toContain("40 day-buckets");
    expect(out).not.toMatch(/too few points/i);
    expect(out).not.toMatch(/going stale/i);
  });
});

describe("formatRepetitionSignal — streak-aware anti-repetition", () => {
  it("is silent when there is no run to call out", () => {
    expect(formatRepetitionSignal(0, "en")).toBe("");
    expect(formatRepetitionSignal(-1, "de")).toBe("");
  });

  it("tells the model to pivot, not restate, on a run (English)", () => {
    const out = formatRepetitionSignal(3, "en");
    expect(out).toContain("REPETITION");
    expect(out).toContain("3 time(s)");
    expect(out).toMatch(/pivot to a DIFFERENT facet/i);
    expect(out).toMatch(/skip the manufactured step/i);
  });

  it("renders the continuity clause in German", () => {
    const out = formatRepetitionSignal(2, "de");
    expect(out).toContain("WIEDERHOLUNG");
    expect(out).toMatch(/3 Checks in Folge/);
  });
});

describe("formatRelationsBlock — cross-metric correlations, descriptive only", () => {
  const rels: RelevantCorrelation[] = [
    {
      interpretation:
        "Higher time in daylight tends to go with higher next-day sleep duration in your data. It is a pattern to watch, not a cause.",
      n: 42,
      r: 0.51,
    },
    { interpretation: "Second relation here.", n: 30, r: -0.44 },
    { interpretation: "Third relation should be capped out.", n: 25, r: 0.4 },
  ];

  it("is empty when no correlations involve the metric", () => {
    expect(formatRelationsBlock([], "en")).toBe("");
  });

  it("passes the engine interpretation verbatim and caps at two", () => {
    const out = formatRelationsBlock(rels, "en");
    expect(out).toContain("Higher time in daylight tends to go with");
    expect(out).toContain("Second relation here.");
    expect(out).not.toContain("Third relation");
    expect(out).toContain("n=42");
    expect(out).toContain("r=0.51");
  });

  it("frames the block as association, never cause (both locales)", () => {
    expect(formatRelationsBlock(rels, "en")).toMatch(/NEVER causal/);
    expect(formatRelationsBlock(rels, "de")).toMatch(/NIE kausal/);
  });
});

describe("computeSteadyRun — grounded repetition proxy from the graded series", () => {
  const monthly = [{ mean: 100 }, { mean: 100 }, { mean: 100 }];

  it("returns 0 with too few weekly buckets", () => {
    expect(computeSteadyRun([{ mean: 100 }], monthly)).toBe(0);
  });

  it("counts a trailing run of weeks inside the band", () => {
    const weekly = [
      { mean: 130 }, // far from baseline → breaks the run
      { mean: 101 },
      { mean: 99 },
      { mean: 102 },
    ];
    // The last three weeks are within 8% of baseline 100 → run = 3.
    expect(computeSteadyRun(weekly, monthly)).toBe(3);
  });

  it("returns 0 when the most recent week deviates (not steady right now)", () => {
    const weekly = [{ mean: 100 }, { mean: 100 }, { mean: 130 }];
    expect(computeSteadyRun(weekly, monthly)).toBe(0);
  });

  it("treats a single steady week as not-yet-repetition (returns 0)", () => {
    const weekly = [{ mean: 130 }, { mean: 100 }];
    expect(computeSteadyRun(weekly, monthly)).toBe(0);
  });

  it("falls back to the weekly mean when no monthly history exists", () => {
    const weekly = [{ mean: 50 }, { mean: 50 }, { mean: 50 }];
    expect(computeSteadyRun(weekly, [])).toBe(3);
  });
});

describe("buildAssessmentContextBlock — assembles only the non-empty blocks", () => {
  it("drops empty blocks (first-run thin metric, no correlations)", () => {
    const out = buildAssessmentContextBlock(
      {
        varietyLead: "latest",
        dataStrength: { points: 2, newestDaysAgo: 0 },
        repeatCount: 0,
        relations: [],
      },
      "en",
    );
    expect(out).toContain("VARIETY");
    expect(out).toContain("DATA STRENGTH");
    expect(out).not.toContain("REPETITION");
    expect(out).not.toContain("RELATIONS");
  });

  it("includes every block when all signals are present", () => {
    const out = buildAssessmentContextBlock(
      {
        varietyLead: "trend",
        dataStrength: { points: 40, newestDaysAgo: 0 },
        repeatCount: 3,
        relations: [{ interpretation: "A relation.", n: 30, r: 0.5 }],
      },
      "en",
    );
    expect(out).toContain("VARIETY");
    expect(out).toContain("DATA STRENGTH");
    expect(out).toContain("REPETITION");
    expect(out).toContain("RELATIONS");
  });
});
