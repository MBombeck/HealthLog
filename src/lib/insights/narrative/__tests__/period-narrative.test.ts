import { describe, it, expect } from "vitest";

import {
  assemblePeriodNarrativeContext,
  type AssembleInput,
  type PeriodNarrativeContext,
} from "../period-narrative";
import type {
  DailySeriesPoint,
  NamedSeries,
} from "@/lib/insights/correlation-discovery";
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { buildDeterministicNarrative } from "../period-narrative-deterministic";
import { buildNarrativeUserPrompt } from "../period-narrative-generate";
import { coupledPair } from "../../__tests__/helpers/seeded-series";

/**
 * Build a contiguous daily series ending at `endDay` (YYYY-MM-DD), one point
 * per day going backwards, oldest → newest. Used to lay both period halves on
 * the same calendar so the split boundaries are unambiguous.
 */
function seriesEndingAt(values: number[], endDay: string): DailySeriesPoint[] {
  const end = new Date(`${endDay}T00:00:00Z`);
  const n = values.length;
  return values.map((value, i) => {
    const d = new Date(end.getTime() - (n - 1 - i) * 86_400_000);
    return { day: d.toISOString().slice(0, 10), value };
  });
}

/** A 30-day month context skeleton with the standard split boundaries. */
function monthInput(
  seriesByMetric: Map<string, DailySeriesPoint[]>,
  discoverySeries: NamedSeries[] = [],
): AssembleInput {
  return {
    period: "month",
    // current = the most recent 30 days; prior = the 30 before that.
    currentFrom: "2026-04-01",
    priorFrom: "2026-03-02",
    window: {
      from: "2026-03-02T00:00:00.000Z",
      to: "2026-04-30T00:00:00.000Z",
    },
    seriesByMetric,
    discoverySeries,
    locale: "en",
    computedAt: "2026-04-30T12:00:00.000Z",
    units: DEFAULT_UNIT_PREFERENCES,
  };
}

function assertReady(
  r: ReturnType<typeof assemblePeriodNarrativeContext>,
): PeriodNarrativeContext {
  if (r.status !== "ready") {
    throw new Error(`expected ready, got ${r.status}`);
  }
  return r;
}

describe("assemblePeriodNarrativeContext — availability gate", () => {
  it("returns insufficient with zero covered metrics on empty input", () => {
    const r = assemblePeriodNarrativeContext(monthInput(new Map()));
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.reason).toBe("not_enough_history");
      expect(r.coverage.metricsWithData).toBe(0);
      expect(r.coverage.required).toBe(2);
    }
  });

  it("returns insufficient with a single covered metric (floor is 2)", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    m.set("WEIGHT", seriesEndingAt([80, 80, 80, 80], "2026-04-30"));
    const r = assemblePeriodNarrativeContext(monthInput(m));
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.coverage.metricsWithData).toBe(1);
    }
  });

  it("a metric below the per-metric covered-day floor does not count", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    // 2 covered days < MIN_COVERED_DAYS_PER_METRIC (3) → not counted.
    m.set("WEIGHT", seriesEndingAt([80, 80], "2026-04-30"));
    m.set("PULSE", seriesEndingAt([60, 61, 62, 63], "2026-04-30"));
    const r = assemblePeriodNarrativeContext(monthInput(m));
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.coverage.metricsWithData).toBe(1);
    }
  });
});

describe("assemblePeriodNarrativeContext — metric deltas", () => {
  it("computes current vs prior period mean, delta and percent", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    // 60 contiguous days: first 30 prior @ 80, last 30 current @ 82.
    const weight = [...Array(30).fill(80), ...Array(30).fill(82)];
    m.set("WEIGHT", seriesEndingAt(weight, "2026-04-30"));
    const pulse = [...Array(30).fill(60), ...Array(30).fill(63)];
    m.set("PULSE", seriesEndingAt(pulse, "2026-04-30"));

    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    const w = ctx.metricDeltas.find((d) => d.type === "WEIGHT");
    expect(w).toBeDefined();
    expect(w!.current).toBe(82);
    expect(w!.prior).toBe(80);
    expect(w!.delta).toBe(2);
    expect(w!.deltaPercent).toBe(2.5);
    expect(w!.currentDays).toBe(30);
    expect(w!.priorDays).toBe(30);
  });

  it("emits null delta when only one side of the period has data", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    // current-only weight: last 5 days.
    m.set("WEIGHT", seriesEndingAt([80, 81, 80, 79, 80], "2026-04-30"));
    m.set("PULSE", seriesEndingAt([60, 61, 62, 63], "2026-04-30"));
    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    const w = ctx.metricDeltas.find((d) => d.type === "WEIGHT")!;
    expect(w.prior).toBeNull();
    expect(w.delta).toBeNull();
    expect(w.deltaPercent).toBeNull();
    expect(w.current).not.toBeNull();
  });
});

describe("assemblePeriodNarrativeContext — the reader's units", () => {
  function glucoseAndWeight() {
    const m = new Map<string, DailySeriesPoint[]>();
    // Prior 30 days at 90 mg/dL / 80 kg, current 30 at 108 mg/dL / 82 kg.
    m.set(
      "BLOOD_GLUCOSE",
      seriesEndingAt(
        [...Array(30).fill(90), ...Array(30).fill(108)],
        "2026-04-30",
      ),
    );
    m.set(
      "WEIGHT",
      seriesEndingAt(
        [...Array(30).fill(80), ...Array(30).fill(82)],
        "2026-04-30",
      ),
    );
    return m;
  }

  it("narrates glucose in mmol/L and weight in pounds when the reader chose them", () => {
    const ctx = assertReady(
      assemblePeriodNarrativeContext({
        ...monthInput(glucoseAndWeight()),
        units: { system: "imperial", glucoseUnit: "mmol/L" },
      }),
    );
    const g = ctx.metricDeltas.find((d) => d.type === "BLOOD_GLUCOSE")!;
    expect(g.unit).toBe("mmol/L");
    expect(g.current).toBe(6);
    expect(g.prior).toBe(5);
    expect(g.delta).toBe(1);
    // Percent is unit-free.
    expect(g.deltaPercent).toBe(20);
    const w = ctx.metricDeltas.find((d) => d.type === "WEIGHT")!;
    expect(w.unit).toBe("lb");
    expect(w.current).toBe(180.8);
    expect(w.delta).toBe(4.4);

    const prose = buildDeterministicNarrative(ctx, "en");
    expect(prose).toContain("mmol/L");
    expect(prose).toContain("lb");
    expect(prose).not.toContain("mg/dL");
    expect(prose).not.toContain("kg");
    const prompt = buildNarrativeUserPrompt(ctx, "en");
    expect(prompt).toContain("BLOOD_GLUCOSE: 6 mmol/L");
    expect(prompt).not.toContain("mg/dL");
  });

  it("keeps mg/dL and kilograms on the default preferences", () => {
    const ctx = assertReady(
      assemblePeriodNarrativeContext(monthInput(glucoseAndWeight())),
    );
    const g = ctx.metricDeltas.find((d) => d.type === "BLOOD_GLUCOSE")!;
    expect(g.unit).toBe("mg/dL");
    expect(g.current).toBe(108);
    expect(ctx.metricDeltas.find((d) => d.type === "WEIGHT")!.unit).toBe("kg");
  });

  it("narrates sleep minutes as hours, the unit it always claimed", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    m.set(
      "SLEEP_DURATION",
      seriesEndingAt(
        [...Array(30).fill(420), ...Array(30).fill(450)],
        "2026-04-30",
      ),
    );
    m.set(
      "WEIGHT",
      seriesEndingAt(
        [...Array(30).fill(80), ...Array(30).fill(82)],
        "2026-04-30",
      ),
    );
    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    const s = ctx.metricDeltas.find((d) => d.type === "SLEEP_DURATION")!;
    expect(s.unit).toBe("h");
    expect(s.current).toBe(7.5);
    expect(s.delta).toBe(0.5);
  });

  it("states a band transition with its unit, converted", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    const prior = Array.from({ length: 30 }, (_, i) => 90 + (i % 3));
    m.set(
      "BLOOD_GLUCOSE",
      seriesEndingAt([...prior, ...Array(30).fill(140)], "2026-04-30"),
    );
    m.set(
      "WEIGHT",
      seriesEndingAt(
        [...Array(30).fill(80), ...Array(30).fill(82)],
        "2026-04-30",
      ),
    );
    const ctx = assertReady(
      assemblePeriodNarrativeContext({
        ...monthInput(m),
        units: { system: "metric", glucoseUnit: "mmol/L" },
      }),
    );
    const t = ctx.bandTransitions.find((b) => b.type === "BLOOD_GLUCOSE")!;
    expect(t.unit).toBe("mmol/L");
    expect(t.center).toBe(7.8);
    expect(t.movedOut).toBe(true);
    expect(buildNarrativeUserPrompt(ctx, "en")).toContain(
      "BLOOD_GLUCOSE: 7.8 mmol/L",
    );
  });
});

describe("assemblePeriodNarrativeContext — band transitions", () => {
  it("flags a vital whose current center moved above its prior band", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    // Prior 30 days tight around 60 (establishes a narrow band); current 30
    // days centred at 90 — well outside.
    const prior = Array.from({ length: 30 }, (_, i) => 60 + (i % 2));
    const current = Array.from({ length: 30 }, () => 90);
    m.set(
      "RESTING_HEART_RATE",
      seriesEndingAt([...prior, ...current], "2026-04-30"),
    );
    // second covered metric to clear the gate
    m.set(
      "WEIGHT",
      seriesEndingAt(
        [...Array(30).fill(80), ...Array(30).fill(80)],
        "2026-04-30",
      ),
    );

    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    const t = ctx.bandTransitions.find((b) => b.type === "RESTING_HEART_RATE");
    expect(t).toBeDefined();
    expect(t!.movedOut).toBe(true);
    expect(t!.direction).toBe("above");
    expect(t!.center).toBe(90);
    expect(t!.baselineDays).toBe(30);
  });

  it("does not flag a vital whose center stayed inside its band", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    const prior = Array.from({ length: 30 }, (_, i) => 60 + (i % 5));
    const current = Array.from({ length: 30 }, (_, i) => 61 + (i % 5));
    m.set("PULSE", seriesEndingAt([...prior, ...current], "2026-04-30"));
    m.set(
      "WEIGHT",
      seriesEndingAt(
        [...Array(30).fill(80), ...Array(30).fill(80)],
        "2026-04-30",
      ),
    );

    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    const t = ctx.bandTransitions.find((b) => b.type === "PULSE");
    expect(t).toBeDefined();
    expect(t!.movedOut).toBe(false);
    expect(t!.direction).toBe("in");
  });

  it("skips band transitions when the prior period is too short", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    // only 5 prior days < MIN_BASELINE_DAYS (7) → no band
    const pulse = [
      ...seriesEndingAt(Array(5).fill(60), "2026-03-31"),
      ...seriesEndingAt(Array(5).fill(90), "2026-04-30"),
    ];
    m.set("PULSE", pulse);
    m.set(
      "WEIGHT",
      seriesEndingAt(
        [...Array(30).fill(80), ...Array(30).fill(80)],
        "2026-04-30",
      ),
    );
    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    expect(ctx.bandTransitions.find((b) => b.type === "PULSE")).toBeUndefined();
  });
});

describe("assemblePeriodNarrativeContext — drivers (FDR-controlled)", () => {
  it("surfaces a strong lagged relationship and keeps it descriptive-only", () => {
    // 31 contiguous days; outcome[D+1] = 2 * behaviour[D] + noise (seeded),
    // so the lag-1 join yields a strong day-to-day r over ≥ 20 paired days.
    // Not two straight lines: a shared trend is removed before correlating.
    const { behaviour: bVals, outcome: oVals } = coupledPair(3, 31, 2, {
      noiseSd: 0.5,
    });
    const behaviour = seriesEndingAt(bVals, "2026-04-30");
    const outcome = seriesEndingAt(oVals, "2026-04-30");
    const discoverySeries: NamedSeries[] = [
      { key: "ACTIVITY_STEPS", role: "behaviour", points: behaviour },
      { key: "SLEEP_DURATION", role: "outcome", points: outcome },
    ];

    const m = new Map<string, DailySeriesPoint[]>();
    m.set("ACTIVITY_STEPS", behaviour);
    m.set("SLEEP_DURATION", outcome);

    const ctx = assertReady(
      assemblePeriodNarrativeContext(monthInput(m, discoverySeries)),
    );
    expect(ctx.drivers.length).toBeGreaterThan(0);
    const d = ctx.drivers[0];
    expect(d.behaviour).toBe("ACTIVITY_STEPS");
    expect(d.outcome).toBe("SLEEP_DURATION");
    expect(d.n).toBeGreaterThanOrEqual(20);
    expect(d.qValue).toBeLessThanOrEqual(ctx.fdrQ);
    // Descriptive-only: the interpretation frames the pair as a pattern, not
    // a mechanism. It carries the conservative disclaimer verbatim and never
    // upgrades the correlation to a causal claim ("X causes/leads to Y").
    const interp = d.interpretation.toLowerCase();
    expect(interp).toContain("not a cause");
    expect(interp).not.toMatch(/\bcauses\b|\bcausing\b|\bleads to\b|\bmakes\b/);
    expect(ctx.pairsTested).toBeGreaterThan(0);
  });

  it("emits no drivers when no pair clears FDR", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    m.set(
      "WEIGHT",
      seriesEndingAt(
        [...Array(30).fill(80), ...Array(30).fill(80)],
        "2026-04-30",
      ),
    );
    m.set(
      "PULSE",
      seriesEndingAt(
        [...Array(30).fill(60), ...Array(30).fill(60)],
        "2026-04-30",
      ),
    );
    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    expect(ctx.drivers).toEqual([]);
  });

  it("surfaces a RATED-factor channel as a driver with humanised prose", () => {
    // A `FACTOR:work` daily score whose next-day sleep tracks it linearly.
    const fVals = Array.from({ length: 31 }, (_, i) => (i % 5) + 1);
    const sVals = Array.from({ length: 31 }, (_, i) =>
      i === 0 ? 400 : ((i - 1) % 5) * 40 + 360 + (i % 2 === 0 ? 1 : -1),
    );
    const factor = seriesEndingAt(fVals, "2026-04-30");
    const sleep = seriesEndingAt(sVals, "2026-04-30");
    // Two real vitals with current-period coverage so the availability gate
    // (≥ 2 DELTA metrics covered) is satisfied — a factor channel is not a
    // vital delta and does not count toward coverage by design.
    const weight = seriesEndingAt(
      Array.from({ length: 31 }, () => 80),
      "2026-04-30",
    );
    const steps = seriesEndingAt(
      Array.from({ length: 31 }, (_, i) => 8000 + i),
      "2026-04-30",
    );
    const discoverySeries: NamedSeries[] = [
      { key: "FACTOR:work", role: "behaviour", points: factor },
      { key: "SLEEP_DURATION", role: "outcome", points: sleep },
    ];
    const m = new Map<string, DailySeriesPoint[]>();
    m.set("FACTOR:work", factor);
    m.set("SLEEP_DURATION", sleep);
    m.set("WEIGHT", weight);
    m.set("ACTIVITY_STEPS", steps);

    const ctx = assertReady(
      assemblePeriodNarrativeContext(monthInput(m, discoverySeries)),
    );
    const driver = ctx.drivers.find((d) => d.behaviour === "FACTOR:work");
    expect(driver).toBeDefined();
    // The prose strips the namespace prefix and reads "rated work", stays
    // causation-banned.
    expect(driver!.interpretation).toContain("rated work");
    expect(driver!.interpretation).not.toContain("FACTOR:");
    expect(driver!.interpretation.toLowerCase()).toContain("not a cause");
  });
});

describe("assemblePeriodNarrativeContext — coincident flags", () => {
  it("fires on a day with ≥ 2 vitals outside their prior bands", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    // Two vitals: tight prior bands, current period mostly in-band but ONE
    // shared day far out of band on both.
    const priorP = Array.from({ length: 30 }, () => 60);
    const priorH = Array.from({ length: 30 }, () => 50);
    const curP = Array.from({ length: 30 }, () => 60);
    const curH = Array.from({ length: 30 }, () => 50);
    // spike both on the last current day
    curP[29] = 120;
    curH[29] = 10;
    m.set("PULSE", seriesEndingAt([...priorP, ...curP], "2026-04-30"));
    m.set(
      "RESTING_HEART_RATE",
      seriesEndingAt([...priorH, ...curH], "2026-04-30"),
    );

    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    expect(ctx.coincidentFlags.length).toBe(1);
    const flag = ctx.coincidentFlags[0];
    expect(flag.day).toBe("2026-04-30");
    expect(flag.vitals.map((v) => v.type).sort()).toEqual([
      "PULSE",
      "RESTING_HEART_RATE",
    ]);
    expect(flag.vitals.find((v) => v.type === "PULSE")!.direction).toBe(
      "above",
    );
    expect(
      flag.vitals.find((v) => v.type === "RESTING_HEART_RATE")!.direction,
    ).toBe("below");
  });

  it("does not fire when only one vital deviates on any day", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    const priorP = Array.from({ length: 30 }, () => 60);
    const priorH = Array.from({ length: 30 }, () => 50);
    const curP = Array.from({ length: 30 }, () => 60);
    const curH = Array.from({ length: 30 }, () => 50);
    curP[29] = 120; // only one vital deviates
    m.set("PULSE", seriesEndingAt([...priorP, ...curP], "2026-04-30"));
    m.set(
      "RESTING_HEART_RATE",
      seriesEndingAt([...priorH, ...curH], "2026-04-30"),
    );
    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    expect(ctx.coincidentFlags).toEqual([]);
  });
});

describe("assemblePeriodNarrativeContext — provenance", () => {
  it("carries window, computedAt and the metrics that backed a beat", () => {
    const m = new Map<string, DailySeriesPoint[]>();
    m.set(
      "WEIGHT",
      seriesEndingAt(
        [...Array(30).fill(80), ...Array(30).fill(81)],
        "2026-04-30",
      ),
    );
    m.set(
      "PULSE",
      seriesEndingAt(
        [...Array(30).fill(60), ...Array(30).fill(62)],
        "2026-04-30",
      ),
    );
    const ctx = assertReady(assemblePeriodNarrativeContext(monthInput(m)));
    expect(ctx.provenance.computedAt).toBe("2026-04-30T12:00:00.000Z");
    expect(ctx.provenance.window.from).toBe("2026-03-02T00:00:00.000Z");
    expect(ctx.provenance.metrics).toContain("WEIGHT");
    expect(ctx.provenance.metrics).toContain("PULSE");
    expect(ctx.period).toBe("month");
  });
});
