/**
 * v1.18.1 — illness correlation engine (the pure math).
 *
 * The reliability battery for `computeIllnessCorrelation`:
 *   - golden-fixture recovery-gap math (felt-better vs physiological return)
 *   - baseline-contamination guard (episode days must not poison the baseline)
 *   - thin-data / coverage-gate (asserts NOTHING below the floor)
 *   - pre-onset anomaly scan + nadir direction (adverse vs not)
 *   - red-flag escalation (sustained SpO2 drop / fever)
 *   - CHRONIC_ONGOING exclusion from the gap
 *
 * Pure — no DB. Series are hand-built so each finding is exactly predictable.
 */
import { describe, expect, it } from "vitest";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  computeIllnessCorrelation,
  dayDiff,
  FUNCTIONAL_IMPACT_RETURN_KEY,
  ILLNESS_SCAN_TYPES,
  isAdverseDeviation,
  MIN_BASELINE_DAYS,
  MIN_EPISODE_COVERAGE_DAYS,
  SLEEP_CONTEXT_MIN_DELTA_MINUTES,
  type IllnessCorrelationInput,
  type SleepNightPoint,
  type SymptomBurdenPoint,
  type VitalDayPoint,
} from "../correlation";

const NOW = new Date("2026-02-01T00:00:00Z");

/** Build a flat baseline series of `days` days at `value`, ending `endDay`. */
function flatBaseline(
  value: number,
  days: number,
  endDay: string,
): VitalDayPoint[] {
  const out: VitalDayPoint[] = [];
  let cursor = Date.parse(`${endDay}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    out.unshift({
      day: new Date(cursor).toISOString().slice(0, 10),
      mean: value,
    });
    cursor -= 24 * 60 * 60 * 1000;
  }
  return out;
}

/**
 * A baseline whose per-day means spread evenly so the MAD (and thus the band)
 * is non-zero and stable. Means cycle through `center − jitter … center +
 * jitter` so the median is `center` and the MAD is ~`jitter/2`.
 */
function jitteredBaseline(
  center: number,
  jitter: number,
  days: number,
  endDay: string,
): VitalDayPoint[] {
  const base = flatBaseline(center, days, endDay);
  const offsets = [-jitter, -jitter / 2, 0, jitter / 2, jitter];
  return base.map((p, i) => ({
    ...p,
    mean: center + offsets[i % offsets.length],
  }));
}

function input(
  over: Partial<IllnessCorrelationInput>,
): IllnessCorrelationInput {
  return {
    episodeId: "ep1",
    window: {
      onsetDay: "2026-01-10",
      feltBetterDay: "2026-01-17",
      lifecycle: "ACUTE",
    },
    series: [],
    source: "DAY",
    now: NOW,
    ...over,
  };
}

describe("computeIllnessCorrelation — coverage gate", () => {
  it("returns insufficient with no baselined vitals", () => {
    const out = computeIllnessCorrelation(input({ series: [] }));
    expect(out.status).toBe("insufficient");
    if (out.status === "insufficient")
      expect(out.reason).toBe("no_baselined_vitals");
  });

  it("returns insufficient when a vital lacks the min baseline days", () => {
    const type: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays: flatBaseline(55, MIN_BASELINE_DAYS - 1, "2026-01-02"),
            episodeDays: flatBaseline(55, 6, "2026-01-15"),
          },
        ],
      }),
    );
    expect(out.status).toBe("insufficient");
  });

  it("returns insufficient when episode coverage is below the floor", () => {
    const type: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays: jitteredBaseline(55, 1, 14, "2026-01-02"),
            episodeDays: flatBaseline(55, 2, "2026-01-11"), // only 2 episode days
          },
        ],
      }),
    );
    expect(out.status).toBe("insufficient");
    if (out.status === "insufficient")
      expect(out.reason).toBe("insufficient_episode_coverage");
  });
});

describe("computeIllnessCorrelation — golden recovery-gap", () => {
  it("computes a positive gap when the body lags the felt-better marker", () => {
    // RHR baseline 55, MAD-band ≈ ±4.4 (spread ≈ 2.22, NOTABLE = 2σ). Onset
    // 01-10, felt better 01-17. RHR spikes to 75, stays clearly out-of-band
    // (≥62) through 01-19, then re-enters the band and holds from 01-20.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-09", mean: 55 }, // pre-onset, in band
      { day: "2026-01-10", mean: 70 },
      { day: "2026-01-12", mean: 75 }, // nadir
      { day: "2026-01-15", mean: 68 },
      { day: "2026-01-17", mean: 64 }, // felt-better day, still out-of-band
      { day: "2026-01-19", mean: 62 }, // still out-of-band
      { day: "2026-01-20", mean: 55 }, // return start (in band)
      { day: "2026-01-21", mean: 55 },
      { day: "2026-01-22", mean: 55 }, // stable 3 days
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    // returned 01-20, felt better 01-17 → gap +3
    expect(out.value.recoveryGapDays).toBe(dayDiff("2026-01-17", "2026-01-20"));
    expect(out.value.recoveryGapDays).toBe(3);
    // nadir at 01-12, value 75, adverse (RHR up = adverse)
    expect(out.value.nadir[0]?.day).toBe("2026-01-12");
    expect(out.value.nadir[0]?.value).toBe(75);
    expect(out.value.nadir[0]?.adverse).toBe(true);
    expect(out.value.nadir[0]?.direction).toBe("above");
  });

  it("flags a pre-onset anomaly when the body deviated before onset", () => {
    const type: MeasurementType = "HEART_RATE_VARIABILITY";
    // HRV baseline 60±2. Drops to 30 two days before onset → adverse (down).
    const baselineDays = jitteredBaseline(60, 2, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-08", mean: 30 }, // pre-onset crash (notable)
      { day: "2026-01-10", mean: 28 },
      { day: "2026-01-12", mean: 32 },
      { day: "2026-01-14", mean: 45 },
      { day: "2026-01-15", mean: 60 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.preOnset[0]?.day).toBe("2026-01-08");
    expect(out.value.preOnset[0]?.direction).toBe("below");
    expect(out.value.preOnset[0]?.adverse).toBe(true);
  });

  it("excludes CHRONIC_ONGOING from the recovery-gap", () => {
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 70 },
      { day: "2026-01-12", mean: 75 },
      { day: "2026-01-15", mean: 55 },
      { day: "2026-01-16", mean: 55 },
      { day: "2026-01-17", mean: 55 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-15",
          lifecycle: "CHRONIC_ONGOING",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.recoveryGapDays).toBeNull();
    expect(out.value.returns).toHaveLength(0);
  });

  it("leaves the gap null when the vital never stably returns (still active)", () => {
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 72 },
      { day: "2026-01-12", mean: 75 },
      { day: "2026-01-14", mean: 73 },
      { day: "2026-01-16", mean: 70 }, // never returns to band
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: null,
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.recoveryGapDays).toBeNull();
    expect(out.value.returns[0]?.returnedDay).toBeNull();
  });

  it("still reports the settle day when a single transient out-of-band reading trails the recovery", () => {
    // R-REG-1: a non-relapse episode that settles for ≥ RETURN_STABILITY_DAYS
    // and then has ONE noisy out-of-band reading on the last logged day. A lone
    // trailing outlier is measurement noise, not a relapse, so the recovery day
    // must NOT be dropped to null. RHR settles 01-18..01-21 (4 in-band days),
    // then a single 63 spike on 01-22.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 70 }, // onset, out of band
      { day: "2026-01-12", mean: 75 }, // nadir
      { day: "2026-01-17", mean: 64 }, // felt-better day, still elevated
      { day: "2026-01-18", mean: 55 }, // settle starts
      { day: "2026-01-19", mean: 55 },
      { day: "2026-01-20", mean: 55 },
      { day: "2026-01-21", mean: 55 }, // 4 stable in-band days
      { day: "2026-01-22", mean: 63 }, // lone trailing outlier (transient)
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.returns[0]?.returnedDay).toBe("2026-01-18");
    // returned 01-18, felt better 01-17 → gap +1 (a non-null number)
    expect(out.value.recoveryGapDays).toBe(dayDiff("2026-01-17", "2026-01-18"));
    expect(out.value.recoveryGapDays).toBe(1);
  });

  it("reports the FINAL settle day after a genuine relapse that re-settles", () => {
    // R-REG-1: settle → genuine sustained re-deviation (a real flare, not noise)
    // → re-settle. The LAST sustained in-band run wins. RHR settles 01-13..01-15,
    // flares out-of-band 01-16..01-18 (3 days = a genuine relapse), then settles
    // again 01-19..01-21. The return is the SECOND settle, 01-19.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 72 }, // onset, out of band
      { day: "2026-01-12", mean: 75 }, // nadir
      { day: "2026-01-13", mean: 55 }, // first settle starts
      { day: "2026-01-14", mean: 55 },
      { day: "2026-01-15", mean: 55 }, // 3 in-band days
      { day: "2026-01-16", mean: 68 }, // genuine relapse (sustained)
      { day: "2026-01-17", mean: 67 },
      { day: "2026-01-18", mean: 66 }, // 3 out-of-band days
      { day: "2026-01-19", mean: 55 }, // second settle starts
      { day: "2026-01-20", mean: 55 },
      { day: "2026-01-21", mean: 55 }, // 3 in-band days
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.returns[0]?.returnedDay).toBe("2026-01-19");
    expect(out.value.recoveryGapDays).toBe(dayDiff("2026-01-14", "2026-01-19"));
    expect(out.value.recoveryGapDays).toBe(5);
  });

  it("returns null when a sustained re-deviation follows the settle with no re-settle (still elevated)", () => {
    // R-REG-1 boundary: the noise tolerance must NOT swallow a genuine ongoing
    // relapse. Settle 01-13..01-15, then a SUSTAINED out-of-band tail
    // (01-16..01-18, ≥ RETURN_STABILITY_DAYS) with no re-settle → the vital is
    // still elevated at the end → null, exactly as a still-active episode.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 72 },
      { day: "2026-01-12", mean: 75 },
      { day: "2026-01-13", mean: 55 }, // settle
      { day: "2026-01-14", mean: 55 },
      { day: "2026-01-15", mean: 55 },
      { day: "2026-01-16", mean: 68 }, // sustained re-deviation, no re-settle
      { day: "2026-01-17", mean: 67 },
      { day: "2026-01-18", mean: 66 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.returns[0]?.returnedDay).toBeNull();
    expect(out.value.recoveryGapDays).toBeNull();
  });

  it("flags a return adverse only when the vital deviated in the adverse direction", () => {
    // A neutral-direction vital (WEIGHT) can deviate out of band and stably
    // return — it produces a return finding, but `adverse` must stay false so
    // it never gets named the recovery driver. An up-adverse vital (RHR) that
    // spikes and returns must read adverse: true.
    const weight: MeasurementType = "WEIGHT";
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [
          {
            type: weight,
            baselineDays: jitteredBaseline(80, 1, 21, "2026-01-02"),
            episodeDays: [
              { day: "2026-01-10", mean: 90 }, // far out of band, neutral
              { day: "2026-01-11", mean: 91 },
              { day: "2026-01-15", mean: 80 }, // back in band
              { day: "2026-01-16", mean: 80 },
              { day: "2026-01-17", mean: 80 },
            ],
          },
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: [
              { day: "2026-01-10", mean: 75 }, // up = adverse
              { day: "2026-01-11", mean: 74 },
              { day: "2026-01-15", mean: 55 }, // back in band
              { day: "2026-01-16", mean: 55 },
              { day: "2026-01-17", mean: 55 },
            ],
          },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const weightReturn = out.value.returns.find((r) => r.type === weight);
    const rhrReturn = out.value.returns.find((r) => r.type === rhr);
    expect(weightReturn?.adverse).toBe(false);
    expect(rhrReturn?.adverse).toBe(true);
  });
});

describe("computeIllnessCorrelation — baseline-contamination guard", () => {
  it("uses ONLY baselineDays for the band, never the episode-span values", () => {
    // If episode-span spikes contaminated the band, the 75 readings would
    // widen the band and the deviation would shrink. We assert the band is
    // built purely from baselineDays by comparing two episodes whose
    // baselineDays are identical but episodeDays differ wildly — the nadir
    // deviationSd for the SAME nadir value must be identical.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");

    const calm = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays,
            episodeDays: [
              { day: "2026-01-10", mean: 56 },
              { day: "2026-01-11", mean: 75 }, // single nadir
              { day: "2026-01-12", mean: 56 },
              { day: "2026-01-13", mean: 55 },
            ],
          },
        ],
      }),
    );
    const stormy = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays,
            episodeDays: [
              { day: "2026-01-10", mean: 90 },
              { day: "2026-01-11", mean: 75 }, // SAME nadir value as calm
              { day: "2026-01-12", mean: 88 },
              { day: "2026-01-13", mean: 92 },
            ],
          },
        ],
      }),
    );
    expect(calm.status).toBe("ok");
    expect(stormy.status).toBe("ok");
    if (calm.status !== "ok" || stormy.status !== "ok") return;
    // The band center is the clean baseline median (55) in BOTH episodes —
    // the wildly different episode-span values never shift it. A contaminated
    // baseline (one that ingested the 75–92 readings) would pull the center
    // upward and the two centers would diverge.
    const calmCenter = calm.value.nadir[0]?.baselineCenter;
    const stormyCenter = stormy.value.nadir[0]?.baselineCenter;
    expect(calmCenter).toBe(55);
    expect(stormyCenter).toBe(55);
    expect(stormyCenter).toBe(calmCenter);
  });
});

describe("computeIllnessCorrelation — red-flag escalation", () => {
  it("escalates a sustained low SpO2 run", () => {
    const type: MeasurementType = "OXYGEN_SATURATION";
    const baselineDays = jitteredBaseline(98, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 91 },
      { day: "2026-01-11", mean: 90 },
      { day: "2026-01-12", mean: 89 }, // 3 consecutive ≤92
      { day: "2026-01-13", mean: 96 },
      { day: "2026-01-14", mean: 98 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.redFlags).toHaveLength(1);
    expect(out.value.redFlags[0].reason).toBe("sustained_low_spo2");
    expect(out.value.redFlags[0].worstValue).toBe(89);
    expect(out.value.redFlags[0].days).toBe(3);
  });

  it("does not escalate a single low SpO2 day", () => {
    const type: MeasurementType = "OXYGEN_SATURATION";
    const baselineDays = jitteredBaseline(98, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 91 }, // one dip only
      { day: "2026-01-11", mean: 97 },
      { day: "2026-01-12", mean: 98 },
      { day: "2026-01-13", mean: 98 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.redFlags).toHaveLength(0);
  });

  it("escalates a MAD=0 (rock-steady) SpO2 that drops — decoupled from the band", () => {
    // A perfectly steady 98 baseline → MAD=0 → the band is DROPPED, so this
    // vital never participates in the banded loop. A 90% SpO2 run must STILL
    // escalate (the safety-critical case the band filter previously hid). To
    // satisfy the episode-coverage floor we add a separate banded RHR vital.
    const spo2: MeasurementType = "OXYGEN_SATURATION";
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: spo2,
            baselineDays: flatBaseline(98, 21, "2026-01-02"), // MAD = 0 → no band
            episodeDays: [
              { day: "2026-01-10", mean: 90 },
              { day: "2026-01-11", mean: 89 },
              { day: "2026-01-12", mean: 90 }, // 3 days ≤ 92
              { day: "2026-01-13", mean: 97 },
            ],
          },
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const spo2Flag = out.value.redFlags.find(
      (f) => f.reason === "sustained_low_spo2",
    );
    expect(spo2Flag).toBeDefined();
    expect(spo2Flag?.worstValue).toBe(89);
    expect(spo2Flag?.days).toBe(3);
  });

  it("escalates the same SpO2 run regardless of input order (order-independence)", () => {
    // The SpO2 red-flag scan is calendar-consecutive and so depends on
    // chronological input. It must sort defensively rather than trust an
    // upstream sort — a shuffled `episodeDays` yields the SAME verdict as a
    // sorted one (parity with the fever path's local sort). Days 01-10/01-11/
    // 01-12 are all ≤92 → a genuine 3-day run; the order they arrive in is noise.
    const type: MeasurementType = "OXYGEN_SATURATION";
    const baselineDays = jitteredBaseline(98, 1, 21, "2026-01-02");
    const shuffled: VitalDayPoint[] = [
      { day: "2026-01-13", mean: 96 },
      { day: "2026-01-11", mean: 90 },
      { day: "2026-01-14", mean: 98 },
      { day: "2026-01-10", mean: 91 },
      { day: "2026-01-12", mean: 89 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays: shuffled }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.redFlags).toHaveLength(1);
    expect(out.value.redFlags[0].reason).toBe("sustained_low_spo2");
    expect(out.value.redFlags[0].worstValue).toBe(89);
    expect(out.value.redFlags[0].days).toBe(3);
  });

  it("does NOT escalate a sparse low-SpO2 series with calendar GAPS (cries-wolf guard)", () => {
    // Mirror of the fever gap guard for SpO2: three isolated low readings on
    // 01-10/01-15/01-20 with multi-day gaps are NOT a sustained run. The scan
    // compares calendar deltas, not array adjacency → longest run 1 → no flag.
    // A banded RHR vital clears the episode-coverage floor.
    const spo2: MeasurementType = "OXYGEN_SATURATION";
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: spo2,
            baselineDays: jitteredBaseline(98, 1, 21, "2026-01-02"),
            episodeDays: [
              { day: "2026-01-10", mean: 91 },
              { day: "2026-01-15", mean: 90 },
              { day: "2026-01-20", mean: 89 },
            ],
          },
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(
      out.value.redFlags.find((f) => f.reason === "sustained_low_spo2"),
    ).toBeUndefined();
  });

  it("escalates a sustained fever logged via the day-log feverC (no temp series)", () => {
    // No BODY_TEMPERATURE vital at all — the canonical journaling-fever path.
    // A banded RHR vital satisfies the coverage floor; the fever escalates
    // purely from the day-log feverC union.
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
        dayLogFever: [
          { day: "2026-01-10", feverC: 39.2 },
          { day: "2026-01-11", feverC: 38.9 },
          { day: "2026-01-12", feverC: 38.6 }, // 3 days ≥ 38.5
          { day: "2026-01-13", feverC: 37.4 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const fever = out.value.redFlags.find(
      (f) => f.reason === "sustained_fever",
    );
    expect(fever).toBeDefined();
    expect(fever?.days).toBe(3);
    expect(fever?.worstValue).toBe(39.2);
  });

  it("uses per-day MAX for fever so an evening spike is not masked by the mean", () => {
    // The mean episode series stays sub-fever; the per-day MAX crosses 38.5.
    const temp: MeasurementType = "BODY_TEMPERATURE";
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: temp,
            baselineDays: jitteredBaseline(36.6, 0.2, 21, "2026-01-02"),
            episodeDays: [
              { day: "2026-01-10", mean: 37.4 },
              { day: "2026-01-11", mean: 37.5 },
              { day: "2026-01-12", mean: 37.6 },
            ],
            episodeDayMax: [
              { day: "2026-01-10", mean: 38.8 },
              { day: "2026-01-11", mean: 38.7 },
              { day: "2026-01-12", mean: 38.9 }, // 3 days max ≥ 38.5
            ],
          },
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const fever = out.value.redFlags.find(
      (f) => f.reason === "sustained_fever",
    );
    expect(fever).toBeDefined();
    expect(fever?.days).toBe(3);
  });

  it("does NOT mis-escalate when the thermometer and day-log fever interleave (false-positive guard)", () => {
    // The fever red-flag unions two individually-sorted sources — the passive
    // BODY_TEMPERATURE series and the day-log feverC — into a Map. Unless the
    // unioned points are re-sorted by day, the run scan sees Map-insertion
    // order, not chronology. Here the thermometer covers {01-10, 01-12} and the
    // day-log covers {01-11, 01-13, 01-14}. True chronology
    // 01-10..01-14 = 39,39,37,39,39 → the fever breaks on 01-12, so the longest
    // run ≥38.5 is 2 → NO escalation. Read in insertion order (temp first:
    // 39,37 then fever: 39,39,39) it would read as a spurious 3-day run.
    const temp: MeasurementType = "BODY_TEMPERATURE";
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: temp,
            baselineDays: jitteredBaseline(36.6, 0.2, 21, "2026-01-02"),
            episodeDays: [
              { day: "2026-01-10", mean: 39.0 },
              { day: "2026-01-12", mean: 37.0 }, // fever broke here
            ],
          },
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
        dayLogFever: [
          { day: "2026-01-11", feverC: 39.0 },
          { day: "2026-01-13", feverC: 39.0 },
          { day: "2026-01-14", feverC: 39.0 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const fever = out.value.redFlags.find(
      (f) => f.reason === "sustained_fever",
    );
    expect(fever).toBeUndefined();
  });

  it("escalates a genuine cross-source run that insertion order would hide (false-negative guard)", () => {
    // The mirror case: a real consecutive 3-day fever run (01-11..01-13) spans
    // both sources, but Map-insertion order scatters the days and breaks it.
    // The thermometer covers {01-12 (fever), 01-10 (broke)} and the day-log
    // covers {01-11, 01-13}. True chronology 01-10..01-13 = 37,39,39,39 → a
    // real 3-day run ≥38.5. In Map-insertion order (temp first: 01-12=39,
    // 01-10=37; then day-log: 01-11=39, 01-13=39) the 01-10 reset lands BETWEEN
    // the fever days → longest run 2 → the genuine escalation is hidden. The
    // explicit chronological sort is what recovers the streak.
    const temp: MeasurementType = "BODY_TEMPERATURE";
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: temp,
            baselineDays: jitteredBaseline(36.6, 0.2, 21, "2026-01-02"),
            episodeDays: [
              { day: "2026-01-12", mean: 39.0 }, // fever, listed first
              { day: "2026-01-10", mean: 37.0 }, // broke, listed second
            ],
          },
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
        dayLogFever: [
          { day: "2026-01-11", feverC: 39.0 },
          { day: "2026-01-13", feverC: 39.0 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const fever = out.value.redFlags.find(
      (f) => f.reason === "sustained_fever",
    );
    expect(fever).toBeDefined();
    expect(fever?.days).toBe(3);
    expect(fever?.worstValue).toBe(39.0);
  });

  it("does NOT escalate a sparse febrile series with calendar GAPS (cries-wolf guard)", () => {
    // Symptom/vital points are present-days-only (never zero-filled). A user
    // who logs a fever on 01-10/01-15/01-20/01-25 has FOUR isolated febrile
    // days with multi-day gaps between them — NOT a sustained run. The run
    // scan must compare calendar-day deltas, not array adjacency, or it falsely
    // fires sustained_fever (which surfaces a "seek medical care" string AND an
    // urgent cross-channel push). No two of these days are calendar-adjacent →
    // the longest run is 1 → NO escalation.
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
        dayLogFever: [
          { day: "2026-01-10", feverC: 39.2 },
          { day: "2026-01-15", feverC: 39.0 },
          { day: "2026-01-20", feverC: 38.8 },
          { day: "2026-01-25", feverC: 38.7 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const fever = out.value.redFlags.find(
      (f) => f.reason === "sustained_fever",
    );
    expect(fever).toBeUndefined();
  });

  it("DOES escalate a genuinely consecutive 3-calendar-day febrile run", () => {
    // The mirror of the gap guard: three truly adjacent calendar days
    // (01-10/01-11/01-12) all ≥ 38.5 → a real sustained fever → escalate.
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
        dayLogFever: [
          { day: "2026-01-10", feverC: 39.2 },
          { day: "2026-01-11", feverC: 38.9 },
          { day: "2026-01-12", feverC: 38.6 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const fever = out.value.redFlags.find(
      (f) => f.reason === "sustained_fever",
    );
    expect(fever).toBeDefined();
    expect(fever?.days).toBe(3);
    expect(fever?.worstValue).toBe(39.2);
  });
});

describe("isAdverseDeviation", () => {
  it("pins per-metric adverse direction (up for RHR, down for HRV)", () => {
    expect(isAdverseDeviation("RESTING_HEART_RATE", "above")).toBe(true);
    expect(isAdverseDeviation("RESTING_HEART_RATE", "below")).toBe(false);
    expect(isAdverseDeviation("HEART_RATE_VARIABILITY", "below")).toBe(true);
    expect(isAdverseDeviation("HEART_RATE_VARIABILITY", "above")).toBe(false);
  });

  it("reads a drop in the nightly RMSSD series as adverse, like SDNN", () => {
    expect(ILLNESS_SCAN_TYPES).toContain("HRV_RMSSD");
    expect(isAdverseDeviation("HRV_RMSSD", "below")).toBe(true);
    expect(isAdverseDeviation("HRV_RMSSD", "above")).toBe(false);
  });

  it("treats neutral-direction vitals (WEIGHT) as never adverse", () => {
    expect(isAdverseDeviation("WEIGHT", "above")).toBe(false);
    expect(isAdverseDeviation("WEIGHT", "below")).toBe(false);
  });
});

describe("computeIllnessCorrelation — adverse-coverage qualifying floor", () => {
  it("counts only days with a notable ADVERSE-direction reading", () => {
    // RHR (up = adverse) spikes out-of-band on 3 distinct active days, then
    // settles. Those 3 days — and only those — count toward the floor.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 75 }, // adverse spike
      { day: "2026-01-11", mean: 74 }, // adverse spike
      { day: "2026-01-12", mean: 73 }, // adverse spike
      { day: "2026-01-15", mean: 55 }, // in band
      { day: "2026-01-16", mean: 55 },
      { day: "2026-01-17", mean: 55 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.adverseCoverageDays).toBe(3);
  });

  it("does NOT count a WEIGHT-only (no adverse direction) episode toward the floor", () => {
    // WEIGHT has no illness-adverse direction. Even with plenty of out-of-band
    // WEIGHT days (so raw coverage `historyDays` clears the engine floor), the
    // adverse-coverage floor stays 0 — a WEIGHT-only episode must not feed the
    // cross-episode typical-gap median.
    const type: MeasurementType = "WEIGHT";
    const baselineDays = jitteredBaseline(80, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 90 }, // far out of band, but neutral direction
      { day: "2026-01-11", mean: 91 },
      { day: "2026-01-12", mean: 92 },
      { day: "2026-01-13", mean: 70 }, // out of band the other way — still neutral
      { day: "2026-01-14", mean: 69 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    // Coverage clears the engine floor (5 banded days) so the engine returns ok…
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.coverage.historyDays).toBeGreaterThanOrEqual(
      MIN_EPISODE_COVERAGE_DAYS,
    );
    // …but NO day counts toward the adverse-coverage qualifying floor.
    expect(out.value.adverseCoverageDays).toBe(0);
  });

  it("ignores a non-adverse-direction move on an adverse-typed vital", () => {
    // RHR is up-adverse. A big DROP (below band) is notable but NOT adverse, so
    // it must not count toward the floor. Pair with a banded neutral vital to
    // clear the engine coverage floor without adding adverse days.
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const weight: MeasurementType = "WEIGHT";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: [
              { day: "2026-01-10", mean: 40 }, // far BELOW band — not adverse for RHR
              { day: "2026-01-11", mean: 41 },
              { day: "2026-01-12", mean: 55 },
              { day: "2026-01-13", mean: 55 },
            ],
          },
          {
            type: weight,
            baselineDays: jitteredBaseline(80, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(80, 5, "2026-01-15"),
          },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.adverseCoverageDays).toBe(0);
  });
});

describe("computeIllnessCorrelation — return anchor", () => {
  it("never reports a return BEFORE the first deviation (no spurious gap)", () => {
    // The vital is IN BAND for the first 4 active days (the run-up), then
    // spikes, then settles. A naive scan from i=0 would call the early in-band
    // run the 'return' and yield a negative gap. The anchored search must pick
    // the post-deviation settle (01-19), giving a positive gap.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 55 }, // in band (run-up)
      { day: "2026-01-11", mean: 55 },
      { day: "2026-01-12", mean: 55 },
      { day: "2026-01-13", mean: 75 }, // FIRST deviation
      { day: "2026-01-14", mean: 74 },
      { day: "2026-01-15", mean: 70 },
      { day: "2026-01-19", mean: 55 }, // settle start
      { day: "2026-01-20", mean: 55 },
      { day: "2026-01-21", mean: 55 }, // stable 3 days
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-15",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    // The return is the post-deviation settle, NOT the 01-10 run-up.
    expect(out.value.returns[0]?.returnedDay).toBe("2026-01-19");
    // Gap = 01-19 − 01-15 = +4 (positive — body lagged), never negative.
    expect(out.value.recoveryGapDays).toBe(4);
    expect(out.value.recoveryGapDays).toBeGreaterThan(0);
  });
});

describe("computeIllnessCorrelation — symptom-burden return track", () => {
  // A banded RHR vital present in EVERY case below clears the engine's
  // episode-coverage floor (the gate counts banded-vital days, not symptom
  // days). Its band stays IN throughout so it produces no adverse signal and
  // never competes with the symptom track for the driver — it is scaffolding.
  const rhr: MeasurementType = "RESTING_HEART_RATE";
  const rhrBaseline = jitteredBaseline(55, 1, 21, "2026-01-02");
  const rhrFlat: VitalDayPoint[] = [
    { day: "2026-01-10", mean: 55 },
    { day: "2026-01-11", mean: 55 },
    { day: "2026-01-12", mean: 55 },
    { day: "2026-01-13", mean: 55 },
    { day: "2026-01-14", mean: 55 },
  ];

  it("folds a functional-impact return into the gap with a constant-0 baseline", () => {
    // Onset 01-10, felt better 01-14. Logged impact: bedbound early, eases to 0
    // on 01-16 and HOLDS for 3 logged days → symptom return 01-16, gap +2.
    const symptomBurden: SymptomBurdenPoint[] = [
      { day: "2026-01-10", impact: 3 },
      { day: "2026-01-12", impact: 2 },
      { day: "2026-01-14", impact: 1 }, // felt-better day, still symptomatic
      { day: "2026-01-16", impact: 0 }, // return start
      { day: "2026-01-17", impact: 0 },
      { day: "2026-01-18", impact: 0 }, // 3 logged in-band days → stable
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        symptomBurden,
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const sym = out.value.returns.find(
      (r) => r.type === FUNCTIONAL_IMPACT_RETURN_KEY,
    );
    expect(sym).toBeDefined();
    expect(sym?.returnedDay).toBe("2026-01-16");
    expect(sym?.adverse).toBe(true);
    // Gap = 01-16 − 01-14 = +2. RHR stayed flat (no gap), so the symptom track
    // is the only contributor → headline gap = +2.
    expect(sym?.gapDays).toBe(dayDiff("2026-01-14", "2026-01-16"));
    expect(out.value.recoveryGapDays).toBe(2);
    // It contributes to the adverse-coverage floor (3 logged adverse days).
    expect(out.value.adverseCoverageDays).toBeGreaterThanOrEqual(3);
    expect(out.value.gapDriverType).toBe(FUNCTIONAL_IMPACT_RETURN_KEY);
  });

  it("WITHHOLDS the symptom return when logging is too sparse to stabilise", () => {
    // The user logs while sick, then logs impact-0 ONCE and stops — the
    // 3-logged-day stability run can never fire. The symptom track must
    // contribute NO gap (honest withholding), never fabricate recovery from the
    // absence of further logs.
    const symptomBurden: SymptomBurdenPoint[] = [
      { day: "2026-01-10", impact: 3 },
      { day: "2026-01-12", impact: 2 },
      { day: "2026-01-16", impact: 0 }, // single trailing in-band log
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        symptomBurden,
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const sym = out.value.returns.find(
      (r) => r.type === FUNCTIONAL_IMPACT_RETURN_KEY,
    );
    expect(sym).toBeDefined();
    expect(sym?.returnedDay).toBeNull();
    expect(sym?.gapDays).toBeNull();
    // No vital returned either → no headline gap fabricated.
    expect(out.value.recoveryGapDays).toBeNull();
    expect(out.value.gapDriverType).toBeNull();
    // The logged adverse days still count toward coverage (honest).
    expect(out.value.adverseCoverageDays).toBeGreaterThanOrEqual(2);
  });

  it("WITHHOLDS the symptom return when the in-band logs span calendar GAPS", () => {
    // Three impact-0 logs exist, but on 01-16/01-23/01-30 — spread across two
    // weeks, not three consecutive days. The stability run is CALENDAR-adjacent,
    // so this sparse settle must NOT register as a "stable symptom return" and
    // must NOT move the headline gap (parity with the vital `lastStableReturn`
    // and `runFlag` calendar-adjacency rule). Without the fix the array-adjacent
    // walk would stamp a return on 01-16 across a 14-day span.
    const symptomBurden: SymptomBurdenPoint[] = [
      { day: "2026-01-10", impact: 3 },
      { day: "2026-01-12", impact: 2 },
      { day: "2026-01-16", impact: 0 },
      { day: "2026-01-23", impact: 0 },
      { day: "2026-01-30", impact: 0 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        symptomBurden,
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const sym = out.value.returns.find(
      (r) => r.type === FUNCTIONAL_IMPACT_RETURN_KEY,
    );
    expect(sym).toBeDefined();
    expect(sym?.returnedDay).toBeNull();
    expect(sym?.gapDays).toBeNull();
    expect(out.value.recoveryGapDays).toBeNull();
    expect(out.value.gapDriverType).toBeNull();
  });

  it("DOES fold a symptom return when the in-band logs are calendar-consecutive", () => {
    // The mirror: three impact-0 logs on truly adjacent days 01-16/01-17/01-18
    // → a genuine stable return on 01-16, gap +2. Confirms the calendar-
    // adjacency requirement does not regress the honest dense-logging case.
    const symptomBurden: SymptomBurdenPoint[] = [
      { day: "2026-01-10", impact: 3 },
      { day: "2026-01-12", impact: 2 },
      { day: "2026-01-16", impact: 0 },
      { day: "2026-01-17", impact: 0 },
      { day: "2026-01-18", impact: 0 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        symptomBurden,
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const sym = out.value.returns.find(
      (r) => r.type === FUNCTIONAL_IMPACT_RETURN_KEY,
    );
    expect(sym?.returnedDay).toBe("2026-01-16");
    expect(sym?.gapDays).toBe(dayDiff("2026-01-14", "2026-01-16"));
    expect(out.value.recoveryGapDays).toBe(2);
    expect(out.value.gapDriverType).toBe(FUNCTIONAL_IMPACT_RETURN_KEY);
  });

  it("lets the symptom track win the driver over a co-returning vital", () => {
    // Both the symptom curve AND an adverse RHR spike return and produce gaps;
    // the functional-impact track must win `gapDriverType` on a tie (it is the
    // most illness-specific signal).
    const rhrSpike: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 75 }, // adverse up
      { day: "2026-01-11", mean: 74 },
      { day: "2026-01-16", mean: 55 }, // back in band
      { day: "2026-01-17", mean: 55 },
      { day: "2026-01-18", mean: 55 }, // 3 stable
    ];
    const symptomBurden: SymptomBurdenPoint[] = [
      { day: "2026-01-10", impact: 3 },
      { day: "2026-01-12", impact: 2 },
      { day: "2026-01-16", impact: 0 }, // same return day → same gap as RHR
      { day: "2026-01-17", impact: 0 },
      { day: "2026-01-18", impact: 0 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrSpike },
        ],
        symptomBurden,
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const sym = out.value.returns.find(
      (r) => r.type === FUNCTIONAL_IMPACT_RETURN_KEY,
    );
    const rhrReturn = out.value.returns.find((r) => r.type === rhr);
    expect(sym?.gapDays).toBe(2);
    expect(rhrReturn?.gapDays).toBe(2);
    expect(out.value.recoveryGapDays).toBe(2);
    // Tie on |gap − median| → functional-impact wins.
    expect(out.value.gapDriverType).toBe(FUNCTIONAL_IMPACT_RETURN_KEY);
  });

  it("ignores a symptom curve with no adverse day (nothing to return from)", () => {
    const symptomBurden: SymptomBurdenPoint[] = [
      { day: "2026-01-10", impact: 0 },
      { day: "2026-01-12", impact: 0 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        symptomBurden,
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(
      out.value.returns.find((r) => r.type === FUNCTIONAL_IMPACT_RETURN_KEY),
    ).toBeUndefined();
  });

  it("never produces a symptom return for CHRONIC_ONGOING", () => {
    const symptomBurden: SymptomBurdenPoint[] = [
      { day: "2026-01-10", impact: 3 },
      { day: "2026-01-16", impact: 0 },
      { day: "2026-01-17", impact: 0 },
      { day: "2026-01-18", impact: 0 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "CHRONIC_ONGOING",
        },
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        symptomBurden,
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.recoveryGapDays).toBeNull();
    expect(out.value.gapDriverType).toBeNull();
    expect(
      out.value.returns.find((r) => r.type === FUNCTIONAL_IMPACT_RETURN_KEY),
    ).toBeUndefined();
  });
});

describe("computeIllnessCorrelation — relapse-aware return (last sustained)", () => {
  it("reports the LAST sustained return when the vital relapses mid-episode", () => {
    // Deviate 01-10, settle in-band 01-13..01-15 (a 3-day run that the OLD
    // first-return rule would have called the return), re-deviate 01-16..01-18,
    // then settle again 01-20..01-22 and hold. felt-better 01-14. The honest
    // answer is the SECOND settle (01-20), not the first — the relapse pushes
    // the return later and extends the gap.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 75 }, // first deviation
      { day: "2026-01-12", mean: 74 },
      { day: "2026-01-13", mean: 55 }, // first settle (old return)
      { day: "2026-01-14", mean: 55 },
      { day: "2026-01-15", mean: 55 }, // 3-day in-band run
      { day: "2026-01-16", mean: 75 }, // RELAPSE
      { day: "2026-01-17", mean: 74 },
      { day: "2026-01-18", mean: 73 },
      { day: "2026-01-20", mean: 55 }, // final settle start
      { day: "2026-01-21", mean: 55 },
      { day: "2026-01-22", mean: 55 }, // holds to end
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.returns[0]?.returnedDay).toBe("2026-01-20");
    // Gap = 01-20 − 01-14 = +6 (the old first-return would have given −1).
    expect(out.value.recoveryGapDays).toBe(dayDiff("2026-01-14", "2026-01-20"));
    expect(out.value.recoveryGapDays).toBe(6);
  });

  it("reports the LAST sustained symptom return when the curve relapses", () => {
    // Parity with the vital track on the symptom curve: impact eases to 0 for 3
    // logged days, flares back to 2, eases to 0 again for 3 logged days → the
    // return is the SECOND easing, not the first.
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const rhrBaseline = jitteredBaseline(55, 1, 21, "2026-01-02");
    const rhrFlat: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 55 },
      { day: "2026-01-11", mean: 55 },
      { day: "2026-01-12", mean: 55 },
      { day: "2026-01-13", mean: 55 },
      { day: "2026-01-14", mean: 55 },
    ];
    const symptomBurden: SymptomBurdenPoint[] = [
      { day: "2026-01-10", impact: 3 },
      { day: "2026-01-12", impact: 2 },
      { day: "2026-01-13", impact: 0 }, // first easing
      { day: "2026-01-14", impact: 0 },
      { day: "2026-01-15", impact: 0 }, // 3 logged in-band days
      { day: "2026-01-16", impact: 2 }, // FLARE
      { day: "2026-01-18", impact: 0 }, // final easing start
      { day: "2026-01-19", impact: 0 },
      { day: "2026-01-20", impact: 0 }, // 3 logged in-band days, holds
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        symptomBurden,
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const sym = out.value.returns.find(
      (r) => r.type === FUNCTIONAL_IMPACT_RETURN_KEY,
    );
    expect(sym?.returnedDay).toBe("2026-01-18");
    expect(sym?.gapDays).toBe(dayDiff("2026-01-14", "2026-01-18"));
    expect(out.value.recoveryGapDays).toBe(4);
  });

  it("withholds when the final in-band run is too short after a relapse", () => {
    // Deviate, settle, relapse, then only 2 in-band days to the window end —
    // the final run is shorter than RETURN_STABILITY_DAYS, so no return is
    // fabricated off the too-short tail.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 75 }, // deviation
      { day: "2026-01-12", mean: 55 }, // settle
      { day: "2026-01-13", mean: 55 },
      { day: "2026-01-14", mean: 55 }, // 3-day run
      { day: "2026-01-16", mean: 75 }, // RELAPSE
      { day: "2026-01-17", mean: 74 },
      { day: "2026-01-19", mean: 55 }, // only 2 in-band days to end
      { day: "2026-01-20", mean: 55 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.returns[0]?.returnedDay).toBeNull();
    expect(out.value.recoveryGapDays).toBeNull();
  });

  it("picks the FINAL settle across multiple relapses", () => {
    // settle → flare → settle → flare → settle: the last contiguous in-band
    // span wins regardless of how many intervening cycles.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 75 }, // deviation
      { day: "2026-01-11", mean: 55 }, // settle 1
      { day: "2026-01-12", mean: 55 },
      { day: "2026-01-13", mean: 55 },
      { day: "2026-01-14", mean: 75 }, // flare 1
      { day: "2026-01-15", mean: 55 }, // settle 2
      { day: "2026-01-16", mean: 55 },
      { day: "2026-01-17", mean: 55 },
      { day: "2026-01-18", mean: 75 }, // flare 2
      { day: "2026-01-20", mean: 55 }, // FINAL settle start
      { day: "2026-01-21", mean: 55 },
      { day: "2026-01-22", mean: 55 }, // holds to end
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.returns[0]?.returnedDay).toBe("2026-01-20");
    expect(out.value.recoveryGapDays).toBe(6);
  });

  it("returns null when the episode ends out-of-band after a relapse", () => {
    // Deviate, settle, relapse, never resolve (ends elevated) → no sustained
    // final return → null gap. Honest: it did not finally settle in-window.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 75 }, // deviation
      { day: "2026-01-12", mean: 55 }, // settle
      { day: "2026-01-13", mean: 55 },
      { day: "2026-01-14", mean: 55 }, // 3-day run
      { day: "2026-01-16", mean: 75 }, // RELAPSE
      { day: "2026-01-18", mean: 74 },
      { day: "2026-01-20", mean: 73 }, // still elevated at the end
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.returns[0]?.returnedDay).toBeNull();
    expect(out.value.recoveryGapDays).toBeNull();
  });

  it("WITHHOLDS a vital return when the in-band settle spans calendar GAPS", () => {
    // Three in-band readings exist after the deviation, but on 01-13/01-20/01-27
    // — a sparse settle across two weeks, not a sustained 3-day run. The settle
    // walk is calendar-adjacent (parity with `runFlag`), so this must NOT count
    // as a stable return and must not fabricate a gap. Array-adjacent walking
    // would have stamped a return on 01-13.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 75 }, // deviation
      { day: "2026-01-12", mean: 74 },
      { day: "2026-01-13", mean: 55 }, // in-band, then a 7-day gap
      { day: "2026-01-20", mean: 55 },
      { day: "2026-01-27", mean: 55 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-14",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.returns[0]?.returnedDay).toBeNull();
    expect(out.value.recoveryGapDays).toBeNull();
  });
});

describe("computeIllnessCorrelation — sleep-as-context observation", () => {
  // A banded RHR vital clears the engine coverage floor in every case; the
  // sleep context is computed independently from the night arrays.
  const rhr: MeasurementType = "RESTING_HEART_RATE";
  const rhrBaseline = jitteredBaseline(55, 1, 21, "2026-01-02");
  const rhrFlat = flatBaseline(55, 5, "2026-01-15");

  /** N baseline nights at `minutes`, ending the day before onset. */
  function nights(
    minutes: number,
    count: number,
    endDay: string,
  ): SleepNightPoint[] {
    const out: SleepNightPoint[] = [];
    let cursor = Date.parse(`${endDay}T00:00:00Z`);
    for (let i = 0; i < count; i++) {
      out.unshift({
        day: new Date(cursor).toISOString().slice(0, 10),
        asleepMinutes: minutes,
      });
      cursor -= 24 * 60 * 60 * 1000;
    }
    return out;
  }

  it("surfaces a slept-more observation when the episode delta clears the floor", () => {
    // Baseline ~420 min (7h), episode ~510 min (8.5h) → +90 min, well past the
    // 30-min floor. Episode nights are inside the active span.
    const out = computeIllnessCorrelation(
      input({
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        baselineNights: nights(420, 6, "2026-01-02"),
        episodeNights: [
          { day: "2026-01-10", asleepMinutes: 510 },
          { day: "2026-01-11", asleepMinutes: 505 },
          { day: "2026-01-12", asleepMinutes: 515 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.sleepContext).not.toBeNull();
    expect(out.value.sleepContext?.baselineMeanMinutes).toBe(420);
    expect(out.value.sleepContext?.deltaMinutes).toBeGreaterThanOrEqual(
      SLEEP_CONTEXT_MIN_DELTA_MINUTES,
    );
    expect(out.value.sleepContext?.nightsCounted).toBe(3);
    // It never touches the recovery-gap.
    expect(out.value.recoveryGapDays).toBeNull();
  });

  it("withholds when the delta is below the magnitude floor", () => {
    // Baseline 420, episode 430 → +10 min, sub-floor jitter → no observation.
    const out = computeIllnessCorrelation(
      input({
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        baselineNights: nights(420, 6, "2026-01-02"),
        episodeNights: [
          { day: "2026-01-10", asleepMinutes: 430 },
          { day: "2026-01-11", asleepMinutes: 425 },
          { day: "2026-01-12", asleepMinutes: 435 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.sleepContext).toBeNull();
  });

  it("withholds when too few episode nights are scorable", () => {
    const out = computeIllnessCorrelation(
      input({
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        baselineNights: nights(420, 6, "2026-01-02"),
        episodeNights: [
          { day: "2026-01-10", asleepMinutes: 520 },
          { day: "2026-01-11", asleepMinutes: 525 }, // only 2 episode nights
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.sleepContext).toBeNull();
  });

  it("withholds when the baseline night count is too thin", () => {
    const out = computeIllnessCorrelation(
      input({
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        baselineNights: nights(420, 3, "2026-01-02"), // only 3 baseline nights
        episodeNights: [
          { day: "2026-01-10", asleepMinutes: 520 },
          { day: "2026-01-11", asleepMinutes: 525 },
          { day: "2026-01-12", asleepMinutes: 515 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.sleepContext).toBeNull();
  });

  it("surfaces a slept-less observation with a negative delta", () => {
    const out = computeIllnessCorrelation(
      input({
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        baselineNights: nights(480, 6, "2026-01-02"),
        episodeNights: [
          { day: "2026-01-10", asleepMinutes: 360 },
          { day: "2026-01-11", asleepMinutes: 370 },
          { day: "2026-01-12", asleepMinutes: 350 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.sleepContext?.deltaMinutes).toBeLessThanOrEqual(
      -SLEEP_CONTEXT_MIN_DELTA_MINUTES,
    );
  });

  it("excludes pre-onset nights from the episode mean", () => {
    // A pre-onset night (before onsetDay 2026-01-10) must not count toward the
    // episode mean — only the active-span nights do.
    const out = computeIllnessCorrelation(
      input({
        series: [
          { type: rhr, baselineDays: rhrBaseline, episodeDays: rhrFlat },
        ],
        baselineNights: nights(420, 6, "2026-01-02"),
        episodeNights: [
          { day: "2026-01-08", asleepMinutes: 999 }, // pre-onset — must be dropped
          { day: "2026-01-10", asleepMinutes: 510 },
          { day: "2026-01-11", asleepMinutes: 510 },
          { day: "2026-01-12", asleepMinutes: 510 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.sleepContext?.episodeMeanMinutes).toBe(510);
    expect(out.value.sleepContext?.nightsCounted).toBe(3);
  });
});

describe("computeIllnessCorrelation — notable means 2 robust SDs", () => {
  // A resting pulse of 55 that swings ±2 bpm day to day (σ ≈ 1.5) and runs
  // 5 to 6 bpm high through a cold: 3 to 4 σ, a plain illness signal. The
  // deviation used to be divided by the band's whole half-width (3σ), so it
  // took a 6σ move to count, and an ordinary cold counted for nothing.
  const type: MeasurementType = "RESTING_HEART_RATE";
  const baselineDays = jitteredBaseline(55, 2, 30, "2026-01-02");
  const cold: VitalDayPoint[] = [
    { day: "2026-01-10", mean: 60 },
    { day: "2026-01-11", mean: 61 },
    { day: "2026-01-12", mean: 61 },
    { day: "2026-01-13", mean: 60 },
    { day: "2026-01-14", mean: 60 },
    { day: "2026-01-15", mean: 55 },
    { day: "2026-01-16", mean: 55 },
    { day: "2026-01-17", mean: 56 },
    { day: "2026-01-18", mean: 55 },
  ];

  it("counts a 3σ day as notable and adverse", () => {
    const out = computeIllnessCorrelation(
      input({
        window: {
          onsetDay: "2026-01-10",
          feltBetterDay: "2026-01-13",
          lifecycle: "ACUTE",
        },
        series: [{ type, baselineDays, episodeDays: cold }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.adverseCoverageDays).toBe(5);
    expect(out.value.nadir[0]?.deviationSd).toBeGreaterThanOrEqual(3);
    expect(out.value.returns[0]?.returnedDay).toBe("2026-01-15");
    expect(out.value.recoveryGapDays).toBe(2);
  });

  it("does not count ordinary day-to-day wobble", () => {
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays,
            episodeDays: cold.map((p) => ({ ...p, mean: 55 + (p.mean % 2) })),
          },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status === "ok") expect(out.value.adverseCoverageDays).toBe(0);
  });
});
