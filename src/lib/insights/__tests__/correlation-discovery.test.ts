import { describe, it, expect } from "vitest";

import {
  discoverCorrelations,
  lagJoin,
  benjaminiHochberg,
  type DailySeriesPoint,
  type NamedSeries,
} from "../correlation-discovery";
import { coupledPair } from "./helpers/seeded-series";

/** Build a contiguous daily series from day-1 of a month. */
function series(values: number[], startDay = 1): DailySeriesPoint[] {
  return values.map((value, i) => ({
    day: `2026-03-${String(startDay + i).padStart(2, "0")}`,
    value,
  }));
}

describe("lagJoin", () => {
  it("pairs a behaviour day with the next day's outcome", () => {
    const behaviour = series([1, 2, 3]); // Mar 1,2,3
    const outcome = series([10, 20, 30]); // Mar 1,2,3
    const { xs, ys } = lagJoin(behaviour, outcome, 1);
    // Mar1→Mar2 (1,20), Mar2→Mar3 (2,30); Mar3→Mar4 has no outcome.
    expect(xs).toEqual([1, 2]);
    expect(ys).toEqual([20, 30]);
  });
});

describe("benjaminiHochberg", () => {
  it("adjusts p-values monotonically and never exceeds 1", () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.5]);
    expect(q.every((v) => v <= 1 && v >= 0)).toBe(true);
    // Smallest p gets the smallest q under the monotone step-up.
    expect(q[0]).toBeLessThanOrEqual(q[1]);
  });

  it("controls discovery — a single tiny p stays significant, noise inflates", () => {
    // 1 true (p=0.001) + 19 noise (p≈0.5): BH keeps the true one well under q.
    const ps = [0.001, ...Array.from({ length: 19 }, () => 0.5)];
    const q = benjaminiHochberg(ps);
    expect(q[0]).toBeLessThan(0.05);
    expect(q[1]).toBeGreaterThan(0.1);
  });
});

describe("discoverCorrelations", () => {
  it("returns none when no pair clears the n ≥ 20 gate", () => {
    const behaviours: NamedSeries[] = [
      { key: "MOOD", role: "behaviour", points: series([3, 4, 5]) },
    ];
    const outcomes: NamedSeries[] = [
      {
        key: "SLEEP_DURATION",
        role: "outcome",
        points: series([400, 410, 420]),
      },
    ];
    const result = discoverCorrelations([...behaviours, ...outcomes], {
      locale: "en",
    });
    expect(result.discovered).toHaveLength(0);
    expect(result.pairsTested).toBe(0);
  });

  it("surfaces a strong lagged pair and tags n, r, p, q", () => {
    // 30 days: outcome[d+1] tracks behaviour[d] linearly → strong r.
    const n = 30;
    const behaviourVals = Array.from({ length: n }, (_, i) => i + (i % 3));
    // Outcome on day d+1 mirrors behaviour on day d (shift by one).
    const outcomeVals = [
      0,
      ...behaviourVals.slice(0, n - 1).map((v) => v * 2 + 5),
    ];
    const result = discoverCorrelations(
      [
        {
          key: "TIME_IN_DAYLIGHT",
          role: "behaviour",
          points: series(behaviourVals),
        },
        { key: "SLEEP_DURATION", role: "outcome", points: series(outcomeVals) },
      ],
      { fdrQ: 0.1, locale: "en" },
    );
    expect(result.pairsTested).toBe(1);
    expect(result.discovered).toHaveLength(1);
    const pair = result.discovered[0];
    expect(pair.behaviour).toBe("TIME_IN_DAYLIGHT");
    expect(pair.outcome).toBe("SLEEP_DURATION");
    expect(pair.n).toBeGreaterThanOrEqual(20);
    expect(pair.pValue).toBeLessThan(0.05);
    expect(pair.qValue).toBeLessThanOrEqual(0.1);
    expect(pair.interpretation).toMatch(/not a cause/);
    expect(pair.lagDays).toBe(1);
  });

  it("drops a pure-noise pair under FDR control", () => {
    // 30 days of independent-ish noise → no defensible correlation.
    const noiseA = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 10 + 50);
    const noiseB = Array.from(
      { length: 30 },
      (_, i) => Math.cos(i * 1.7) * 10 + 50,
    );
    const result = discoverCorrelations(
      [
        { key: "BLOOD_GLUCOSE", role: "behaviour", points: series(noiseA) },
        { key: "WEIGHT", role: "outcome", points: series(noiseB) },
      ],
      { locale: "en" },
    );
    // It is tested (n ≥ 20) but should not survive p < 0.05 + FDR.
    expect(result.pairsTested).toBe(1);
    expect(result.discovered).toHaveLength(0);
  });

  it("surfaces a RATED-factor channel and humanises its namespace prefix", () => {
    // A `FACTOR:work` behaviour whose next-day sleep tracks it linearly.
    const n = 30;
    const factorVals = Array.from({ length: n }, (_, i) => (i % 5) + 1);
    const sleepVals = [
      400,
      ...factorVals.slice(0, n - 1).map((v) => v * 30 + 300),
    ];
    const result = discoverCorrelations(
      [
        { key: "FACTOR:work", role: "behaviour", points: series(factorVals) },
        { key: "SLEEP_DURATION", role: "outcome", points: series(sleepVals) },
      ],
      { fdrQ: 0.1, locale: "en" },
    );
    expect(result.discovered).toHaveLength(1);
    const pair = result.discovered[0];
    expect(pair.behaviour).toBe("FACTOR:work");
    // The interpretation strips the namespace and reads "rated work", never
    // the raw key, and stays causation-banned.
    expect(pair.interpretation).toContain("rated work");
    expect(pair.interpretation).not.toContain("FACTOR:");
    expect(pair.interpretation).toMatch(/not a cause/);
  });
});

// ── F3 — MOOD as a discoverable OUTCOME channel ─────────────────────

import { DISCOVERY_OUTCOMES } from "../correlation-discovery";

describe("MOOD as outcome (F3)", () => {
  it("registers MOOD in the outcome matrix", () => {
    expect(DISCOVERY_OUTCOMES).toContain("MOOD");
  });

  it("surfaces a behaviour → next-day MOOD relation", () => {
    // 30 contiguous days; daylight on day D drives mood on day D+1.
    const n = 30;
    const daylight = Array.from({ length: n }, (_, i) => 60 + (i % 10) * 5);
    // mood[D+1] tracks daylight[D] with light noise → strong lagged r.
    const mood = Array.from({ length: n }, (_, i) => {
      const driver = i === 0 ? 60 : 60 + ((i - 1) % 10) * 5;
      return 1 + (driver - 60) / 45 + (i % 2 === 0 ? 0.02 : -0.02);
    });
    const result = discoverCorrelations(
      [
        {
          key: "TIME_IN_DAYLIGHT",
          role: "behaviour",
          points: series(daylight),
        },
        { key: "MOOD", role: "outcome", points: series(mood) },
      ],
      { locale: "en" },
    );
    const pair = result.discovered.find(
      (p) => p.behaviour === "TIME_IN_DAYLIGHT" && p.outcome === "MOOD",
    );
    expect(pair).toBeDefined();
    expect(pair!.r).toBeGreaterThan(0.5);
  });

  it("never tests the MOOD → MOOD self-pair", () => {
    const n = 30;
    const mood = Array.from({ length: n }, (_, i) => 3 + (i % 3));
    const result = discoverCorrelations(
      [
        { key: "MOOD", role: "behaviour", points: series(mood) },
        { key: "MOOD", role: "outcome", points: series(mood) },
      ],
      { locale: "en" },
    );
    expect(
      result.discovered.find(
        (p) => p.behaviour === "MOOD" && p.outcome === "MOOD",
      ),
    ).toBeUndefined();
    expect(result.pairsTested).toBe(0);
  });
});

// ── RECON1 — correlation quality gates (D2-1 / D2-2 / D2-6 / D4) ─────

import {
  shrinkEstimate,
  metricFamily,
  confidenceTier,
  EFFECT_SIZE_FLOOR,
  CONFIDENT_EFFECT_THRESHOLD,
} from "../correlation-discovery";

/** Contiguous daily series starting 2026-01-01, spanning any length. */
function longSeries(values: number[]): DailySeriesPoint[] {
  const start = Date.UTC(2026, 0, 1);
  return values.map((value, i) => {
    const d = new Date(start + i * 24 * 60 * 60 * 1000);
    return { day: d.toISOString().slice(0, 10), value };
  });
}

describe("metricFamily (D2-1)", () => {
  it("collapses both BP components to one family", () => {
    expect(metricFamily("BLOOD_PRESSURE_SYS")).toBe(
      metricFamily("BLOOD_PRESSURE_DIA"),
    );
  });

  it("treats a rated mood factor as the MOOD family", () => {
    expect(metricFamily("FACTOR:work")).toBe(metricFamily("MOOD"));
  });

  it("keeps unrelated channels in distinct families", () => {
    expect(metricFamily("SLEEP_DURATION")).not.toBe(metricFamily("WEIGHT"));
  });
});

describe("D2-1 — same-family lagged pairs are excluded from discovery", () => {
  it("never tests a FACTOR:* → MOOD same-family lag", () => {
    // A rated factor that perfectly tracks next-day mood — a self-lag
    // tautology that must NOT surface as a cross-domain driver.
    const n = 40;
    const factor = Array.from({ length: n }, (_, i) => 1 + (i % 5));
    const mood = [3, ...factor.slice(0, n - 1).map((v) => v)];
    const result = discoverCorrelations(
      [
        { key: "FACTOR:work", role: "behaviour", points: longSeries(factor) },
        { key: "MOOD", role: "outcome", points: longSeries(mood) },
      ],
      { locale: "en" },
    );
    expect(result.pairsTested).toBe(0);
    expect(result.discovered).toHaveLength(0);
  });
});

describe("shrinkEstimate (D4)", () => {
  it("pulls a thin-data r harder toward null than a deep one", () => {
    const r = 0.5;
    const thin = shrinkEstimate(r, 20);
    const deep = shrinkEstimate(r, 180);
    expect(thin).toBeLessThan(deep);
    expect(thin).toBeLessThan(r);
    expect(deep).toBeLessThan(r);
    // k=10: n=20 keeps 20/30 ≈ 0.667, n=180 keeps 180/190 ≈ 0.947.
    expect(thin).toBeCloseTo(0.5 * (20 / 30), 4);
    expect(deep).toBeCloseTo(0.5 * (180 / 190), 4);
  });

  it("is null-safe", () => {
    expect(shrinkEstimate(Number.NaN, 30)).toBe(0);
    expect(shrinkEstimate(0.4, 0)).toBe(0);
  });
});

describe("confidenceTier (D2-2 / D2-6)", () => {
  it("drops a below-floor effect to null", () => {
    expect(confidenceTier(EFFECT_SIZE_FLOOR - 0.01, 180)).toBeNull();
  });

  it("down-tiers a real-but-small effect to faint", () => {
    expect(
      confidenceTier((EFFECT_SIZE_FLOOR + CONFIDENT_EFFECT_THRESHOLD) / 2, 180),
    ).toBe("faint");
  });

  it("requires depth for a high tier; a thin strong pair is moderate", () => {
    expect(confidenceTier(0.5, 30)).toBe("moderate");
    expect(confidenceTier(0.5, 90)).toBe("high");
  });
});

describe("D2-2 — effect-size floor on discovered drivers", () => {
  it("drops a significant-but-trivial pair (large n, small r) from the ranking", () => {
    // 120 days. Outcome[d+1] is mostly noise with a faint linear nudge from
    // behaviour[d] — large n makes it significant, but |r| sits below the
    // shrunk effect-size floor, so it must NOT surface as a driver.
    const n = 120;
    const behaviour = Array.from(
      { length: n },
      (_, i) => Math.sin(i * 0.7) * 10 + 50,
    );
    const outcome = [
      0,
      ...behaviour
        .slice(0, n - 1)
        .map((v, i) => v * 0.12 + Math.cos(i * 1.3) * 40 + 100),
    ];
    const result = discoverCorrelations(
      [
        {
          key: "TIME_IN_DAYLIGHT",
          role: "behaviour",
          points: longSeries(behaviour),
        },
        { key: "SLEEP_DURATION", role: "outcome", points: longSeries(outcome) },
      ],
      { locale: "en" },
    );
    // Either it failed significance, or it was floored out — either way no
    // confident driver row reaches the Coach.
    const surfaced = result.discovered.find(
      (p) =>
        p.behaviour === "TIME_IN_DAYLIGHT" && p.outcome === "SLEEP_DURATION",
    );
    if (surfaced) {
      expect(Math.abs(surfaced.shrunkR)).toBeGreaterThanOrEqual(
        EFFECT_SIZE_FLOOR,
      );
      expect(surfaced.tier).not.toBeUndefined();
    }
  });

  it("a strong deep pair is narrated with confident phrasing (high tier)", () => {
    // Seeded noise with a real next-day coupling (r ≈ 0.9). A deterministic
    // periodic fixture would not do here: its autocorrelation is perfect, so
    // the effective sample size collapses and the pair is honestly thin.
    const { behaviour, outcome } = coupledPair(11, 90, 2);
    const result = discoverCorrelations(
      [
        {
          key: "TIME_IN_DAYLIGHT",
          role: "behaviour",
          points: longSeries(behaviour),
        },
        { key: "SLEEP_DURATION", role: "outcome", points: longSeries(outcome) },
      ],
      { locale: "en" },
    );
    const pair = result.discovered.find(
      (p) =>
        p.behaviour === "TIME_IN_DAYLIGHT" && p.outcome === "SLEEP_DURATION",
    );
    expect(pair).toBeDefined();
    expect(pair!.tier).toBe("high");
    expect(pair!.interpretation).toMatch(/tends to go with/);
    expect(pair!.interpretation).toMatch(/not a cause/);
  });

  it("a faint-tier pair is hedged, never confident", () => {
    // A seed whose sample effect lands mid-band (shrunk r ≈ 0.25).
    const FAINT_SEED = 2;
    // Construct a pair whose SHRUNK r lands in [floor, confident): a moderate
    // raw r on a sample deep enough to clear significance but whose shrunk
    // magnitude stays under the confident threshold.
    // Seeded noise with a weak next-day coupling (slope 0.3, r ≈ 0.3) over
    // 200 days: significant, but the shrunk effect stays under the confident
    // threshold.
    const { behaviour, outcome } = coupledPair(FAINT_SEED, 200, 0.3);
    const result = discoverCorrelations(
      [
        {
          key: "TIME_IN_DAYLIGHT",
          role: "behaviour",
          points: longSeries(behaviour),
        },
        { key: "SLEEP_DURATION", role: "outcome", points: longSeries(outcome) },
      ],
      { locale: "en" },
    );
    const pair = result.discovered.find(
      (p) =>
        p.behaviour === "TIME_IN_DAYLIGHT" && p.outcome === "SLEEP_DURATION",
    );
    // Deterministic for the fixed seed: shrunk r in [0.2, 0.3) → faint tier.
    expect(pair).toBeDefined();
    expect(pair!.tier).toBe("faint");
    expect(Math.abs(pair!.shrunkR)).toBeGreaterThanOrEqual(EFFECT_SIZE_FLOOR);
    expect(Math.abs(pair!.shrunkR)).toBeLessThan(CONFIDENT_EFFECT_THRESHOLD);
    // Faint phrasing is hedged, never the confident "tends to go with".
    expect(pair!.interpretation).toMatch(/faint hint/);
    expect(pair!.interpretation).not.toMatch(/tends to go with/);
    expect(pair!.interpretation).toMatch(/never a cause/);
  });

  // ── i18n regression guard (v1.30.10) ─────────────────────────────────
  //
  // The generated-insight narrative layer built its user-facing sentences by
  // TypeScript string interpolation and never routed through the i18n bundle,
  // so a German UI rendered an English sentence spliced into German text. This
  // pins the fix: with `locale: "de"` the interpretation is the German template
  // (localised metric label + correctly-negated "keine Ursache"), NOT English.
  it("narrates in the reader's locale — German, never the English string", () => {
    const { behaviour, outcome } = coupledPair(11, 90, 2);
    const seriesInput: NamedSeries[] = [
      {
        key: "TIME_IN_DAYLIGHT",
        role: "behaviour",
        points: longSeries(behaviour),
      },
      { key: "SLEEP_DURATION", role: "outcome", points: longSeries(outcome) },
    ];
    const find = (r: ReturnType<typeof discoverCorrelations>) =>
      r.discovered.find(
        (p) =>
          p.behaviour === "TIME_IN_DAYLIGHT" && p.outcome === "SLEEP_DURATION",
      );

    const de = find(discoverCorrelations(seriesInput, { locale: "de" }));
    const en = find(discoverCorrelations(seriesInput, { locale: "en" }));
    expect(de).toBeDefined();
    expect(en).toBeDefined();

    // German narration: localised metric labels + the German "high" template.
    expect(de!.interpretation).toContain("die Zeit im Tageslicht");
    expect(de!.interpretation).toContain("die Schlafdauer");
    // The load-bearing, correctly-negated "not a cause" survives in German.
    expect(de!.interpretation).toMatch(/keine Ursache/);
    // And it is NOT the English leak the maintainer saw.
    expect(de!.interpretation).not.toMatch(/tends to go with/);
    expect(de!.interpretation).not.toMatch(
      /a pattern worth watching, not a cause/,
    );
    expect(de!.interpretation).not.toEqual(en!.interpretation);

    // English default stays exactly the established wording.
    expect(en!.interpretation).toMatch(/tends to go with/);
    expect(en!.interpretation).toMatch(/not a cause/);
  });
});

// ── FDREXTEND — medication compliance + symptom severity channels ─────

import {
  DISCOVERY_BEHAVIOURS,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
} from "../correlation-discovery";

describe("compliance + symptom channels (FDREXTEND)", () => {
  it("registers compliance as a behaviour and symptom in both roles", () => {
    expect(DISCOVERY_BEHAVIOURS).toContain(MEDICATION_COMPLIANCE_CHANNEL_KEY);
    expect(DISCOVERY_BEHAVIOURS).toContain(SYMPTOM_SEVERITY_CHANNEL_KEY);
    expect(DISCOVERY_OUTCOMES).toContain(SYMPTOM_SEVERITY_CHANNEL_KEY);
  });

  it("each new channel is its own metricFamily (no shared collapse)", () => {
    expect(metricFamily(MEDICATION_COMPLIANCE_CHANNEL_KEY)).toBe(
      MEDICATION_COMPLIANCE_CHANNEL_KEY,
    );
    expect(metricFamily(SYMPTOM_SEVERITY_CHANNEL_KEY)).toBe(
      SYMPTOM_SEVERITY_CHANNEL_KEY,
    );
    // Neither shares a family with a vital / sleep / mood channel, so they can
    // pair cross-domain.
    expect(metricFamily(MEDICATION_COMPLIANCE_CHANNEL_KEY)).not.toBe(
      metricFamily(SYMPTOM_SEVERITY_CHANNEL_KEY),
    );
    expect(metricFamily(MEDICATION_COMPLIANCE_CHANNEL_KEY)).not.toBe(
      metricFamily("RESTING_HEART_RATE"),
    );
  });

  it("surfaces an adherence-dip → next-day symptom-flare link at a confident tier", () => {
    // 120 contiguous days. Lower adherence on day D drives a higher symptom
    // burden on day D+1 (the flagship cross-metric link). Adherence varies day to day (seeded); the symptom burden the day after
    // falls as adherence rises, with independent noise on top.
    const pair0 = coupledPair(23, 120, -2);
    const adherence = pair0.behaviour.map((v) => 70 + v * 10);
    const symptom = pair0.outcome.map((v) => (v - 40) / 7);
    const result = discoverCorrelations(
      [
        {
          key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
          role: "behaviour",
          points: longSeries(adherence),
        },
        {
          key: SYMPTOM_SEVERITY_CHANNEL_KEY,
          role: "outcome",
          points: longSeries(symptom),
        },
      ],
      { locale: "en" },
    );
    const pair = result.discovered.find(
      (p) =>
        p.behaviour === MEDICATION_COMPLIANCE_CHANNEL_KEY &&
        p.outcome === SYMPTOM_SEVERITY_CHANNEL_KEY,
    );
    expect(pair).toBeDefined();
    expect(pair!.n).toBeGreaterThanOrEqual(20);
    // Negative: higher adherence → lower next-day symptom burden.
    expect(pair!.r).toBeLessThan(0);
    expect(pair!.tier).toBe("high");
    expect(pair!.interpretation).toMatch(/medication compliance/);
    expect(pair!.interpretation).toMatch(/symptom severity/);
    expect(pair!.interpretation).toMatch(/not a cause/);
  });

  it("does NOT surface a link when the overlap is below the n ≥ 20 floor", () => {
    // A real adherence→symptom relationship but only ~10 paired days: sparse
    // logging must withhold, never fabricate a confident driver.
    const n = 12;
    const adherence = Array.from({ length: n }, (_, i) =>
      i % 2 === 0 ? 100 : 40,
    );
    const symptom = [
      0,
      ...adherence.slice(0, n - 1).map((a) => (100 - a) / 30),
    ];
    const result = discoverCorrelations(
      [
        {
          key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
          role: "behaviour",
          points: longSeries(adherence),
        },
        {
          key: SYMPTOM_SEVERITY_CHANNEL_KEY,
          role: "outcome",
          points: longSeries(symptom),
        },
      ],
      { locale: "en" },
    );
    // Below the floor the pair is never even tested.
    expect(result.pairsTested).toBe(0);
    expect(result.discovered).toHaveLength(0);
  });

  it("never tests the symptom → symptom self-lag", () => {
    const n = 40;
    const symptom = Array.from({ length: n }, (_, i) => (i % 4) / 2);
    const result = discoverCorrelations(
      [
        {
          key: SYMPTOM_SEVERITY_CHANNEL_KEY,
          role: "behaviour",
          points: longSeries(symptom),
        },
        {
          key: SYMPTOM_SEVERITY_CHANNEL_KEY,
          role: "outcome",
          points: longSeries(symptom),
        },
      ],
      { locale: "en" },
    );
    expect(
      result.discovered.find(
        (p) =>
          p.behaviour === SYMPTOM_SEVERITY_CHANNEL_KEY &&
          p.outcome === SYMPTOM_SEVERITY_CHANNEL_KEY,
      ),
    ).toBeUndefined();
    expect(result.pairsTested).toBe(0);
  });

  it("compliance can pair with a vital outcome (cross-domain)", () => {
    // Adherence dip today → resting HR drift up tomorrow. Confirms the channel
    // is free to pair with vitals, not just symptom.
    const n = 70;
    const adherence = Array.from({ length: n }, (_, i) =>
      i % 3 === 0 ? 100 : i % 3 === 1 ? 65 : 35,
    );
    const rhr = [
      55,
      ...adherence
        .slice(0, n - 1)
        .map((a, i) => 55 + (100 - a) / 6 + (i % 2 === 0 ? 0.1 : -0.1)),
    ];
    const result = discoverCorrelations(
      [
        {
          key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
          role: "behaviour",
          points: longSeries(adherence),
        },
        {
          key: "RESTING_HEART_RATE",
          role: "outcome",
          points: longSeries(rhr),
        },
      ],
      { locale: "en" },
    );
    const pair = result.discovered.find(
      (p) =>
        p.behaviour === MEDICATION_COMPLIANCE_CHANNEL_KEY &&
        p.outcome === "RESTING_HEART_RATE",
    );
    expect(pair).toBeDefined();
    expect(pair!.r).toBeLessThan(0); // higher adherence → lower next-day RHR
  });
});

// ─── v1.22 — new linkages + early detection + labs ────────────────────────

import {
  DISCOVERY_BEHAVIOURS as MATRIX_BEHAVIOURS,
  DISCOVERY_OUTCOMES as MATRIX_OUTCOMES,
  discoverEmergingCorrelations,
  discoverLabOutcomeCorrelations,
  filterSeriesToWindow,
  EARLY_WINDOW_DAYS,
  type LabDrawPoint,
} from "../correlation-discovery";

/** Contiguous daily series starting `startISO` (YYYY-MM-DD). */
function seriesFrom(startISO: string, values: number[]): DailySeriesPoint[] {
  const [y, m, d] = startISO.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d);
  return values.map((value, i) => {
    const dt = new Date(start + i * 24 * 60 * 60 * 1000);
    return { day: dt.toISOString().slice(0, 10), value };
  });
}

describe("v1.22 — new curated linkages", () => {
  it("adds sleep as a behaviour (was outcome-only)", () => {
    expect(MATRIX_BEHAVIOURS).toContain("SLEEP_DURATION");
  });

  it("adds blood pressure (both components) as outcomes", () => {
    expect(MATRIX_OUTCOMES).toContain("BLOOD_PRESSURE_SYS");
    expect(MATRIX_OUTCOMES).toContain("BLOOD_PRESSURE_DIA");
  });

  it("surfaces compliance→BP_SYS but skips the same-family BP→BP self-cross", () => {
    const n = 80;
    const adherence = Array.from({ length: n }, (_, i) =>
      i % 2 === 0 ? 100 : 50,
    );
    // Higher adherence today → lower next-day systolic.
    const sys = [
      130,
      ...adherence
        .slice(0, n - 1)
        .map((a, i) => 160 - a / 4 + (i % 2 ? 0.2 : -0.2)),
    ];
    const result = discoverCorrelations(
      [
        {
          key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
          role: "behaviour",
          points: longSeries(adherence),
        },
        // BP is both a behaviour and an outcome in the real matrix; the
        // same-family guard must keep BP_SYS(behaviour)→BP_SYS(outcome) out.
        {
          key: "BLOOD_PRESSURE_SYS",
          role: "behaviour",
          points: longSeries(sys),
        },
        { key: "BLOOD_PRESSURE_SYS", role: "outcome", points: longSeries(sys) },
      ],
      { locale: "en" },
    );
    expect(
      result.discovered.find(
        (p) =>
          p.behaviour === "BLOOD_PRESSURE_SYS" &&
          p.outcome === "BLOOD_PRESSURE_SYS",
      ),
    ).toBeUndefined();
    const link = result.discovered.find(
      (p) =>
        p.behaviour === MEDICATION_COMPLIANCE_CHANNEL_KEY &&
        p.outcome === "BLOOD_PRESSURE_SYS",
    );
    expect(link).toBeDefined();
    expect(link!.r).toBeLessThan(0);
  });
});

describe("discoverEmergingCorrelations (early detection)", () => {
  it("filterSeriesToWindow keeps only on/after the cutoff", () => {
    const s: NamedSeries[] = [
      {
        key: "MOOD",
        role: "behaviour",
        points: seriesFrom("2026-03-01", [1, 2, 3, 4, 5]),
      },
    ];
    const filtered = filterSeriesToWindow(s, "2026-03-03");
    expect(filtered[0].points.map((p) => p.day)).toEqual([
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
  });

  it("surfaces a fortnight-long signal the retrospective n≥20 floor cannot yet see", () => {
    // Only ~18 days of data: a clean behaviour→next-day-outcome coupling. The
    // retrospective scan needs ≥ 20 lagged pairs, so it sees NOTHING; the early
    // window (floor 10) catches it — exactly the early-detection mandate.
    const len = 18;
    const { behaviour: beh, outcome: out } = coupledPair(5, len, 3, {
      noiseSd: 0.5,
    });
    const series: NamedSeries[] = [
      { key: "MOOD", role: "behaviour", points: longSeries(beh) },
      {
        key: "HEART_RATE_VARIABILITY",
        role: "outcome",
        points: longSeries(out),
      },
    ];
    const retrospective = discoverCorrelations(series, { locale: "en" });
    expect(retrospective.discovered).toHaveLength(0); // n too low for the floor

    const cutoff = longSeries(beh)[0].day; // whole (short) window
    const { emerging } = discoverEmergingCorrelations(series, retrospective, {
      recentFromDayKey: cutoff,
      locale: "en",
      minPairs: 10,
    });
    const pair = emerging.find(
      (p) => p.behaviour === "MOOD" && p.outcome === "HEART_RATE_VARIABILITY",
    );
    expect(pair).toBeDefined();
    expect(pair!.window).toBe("recent");
    expect(pair!.provisional).toBe(true);
  });

  it("does not double-count a pair already established retrospectively", () => {
    // A strong relationship across the WHOLE 80-day window → retrospective finds
    // it; the emerging pass must NOT re-surface it.
    const n = 80;
    const beh = Array.from({ length: n }, (_, i) => (i % 2 ? 2 : 9));
    const out = beh.map((b, i) => 40 + b * 3 + (i % 2 ? 0.3 : -0.3));
    const series: NamedSeries[] = [
      { key: "MOOD", role: "behaviour", points: longSeries(beh) },
      {
        key: "HEART_RATE_VARIABILITY",
        role: "outcome",
        points: longSeries(out),
      },
    ];
    const retrospective = discoverCorrelations(series, { locale: "en" });
    expect(
      retrospective.discovered.some(
        (p) => p.behaviour === "MOOD" && p.outcome === "HEART_RATE_VARIABILITY",
      ),
    ).toBe(true);
    const cutoff = new Date(
      Date.UTC(2026, 0, 1) + (n - EARLY_WINDOW_DAYS) * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    const { emerging } = discoverEmergingCorrelations(series, retrospective, {
      recentFromDayKey: cutoff,
      locale: "en",
      minPairs: 10,
    });
    expect(
      emerging.find(
        (p) => p.behaviour === "MOOD" && p.outcome === "HEART_RATE_VARIABILITY",
      ),
    ).toBeUndefined();
  });

  it("returns nothing on pure noise (FDR + high bar hold in the short window)", () => {
    const n = 30;
    const beh = Array.from({ length: n }, (_, i) => (i * 7) % 11);
    const out = Array.from({ length: n }, (_, i) => (i * 3) % 5);
    const series: NamedSeries[] = [
      { key: "MOOD", role: "behaviour", points: longSeries(beh) },
      {
        key: "HEART_RATE_VARIABILITY",
        role: "outcome",
        points: longSeries(out),
      },
    ];
    const retrospective = discoverCorrelations(series, { locale: "en" });
    const cutoff = longSeries(beh)[Math.max(0, n - EARLY_WINDOW_DAYS)].day;
    const { emerging } = discoverEmergingCorrelations(series, retrospective, {
      recentFromDayKey: cutoff,
      locale: "en",
      minPairs: 10,
    });
    expect(emerging).toHaveLength(0);
  });
});

describe("discoverLabOutcomeCorrelations (labs ↔ outcomes)", () => {
  function weightSeries(): NamedSeries {
    // Daily weight that drifts up over ~6 months.
    const values = Array.from({ length: 180 }, (_, i) => 80 + i * 0.05);
    return {
      key: "WEIGHT",
      role: "outcome",
      points: seriesFrom("2026-01-01", values),
    };
  }

  it("surfaces a lab that tracks the contemporaneous outcome window-mean", () => {
    const weight = weightSeries();
    // 8 monthly-ish HbA1c-like draws that rise with weight.
    const draws: LabDrawPoint[] = [];
    for (let i = 0; i < 8; i++) {
      const dayIdx = 30 + i * 18; // spread draws across the window
      const day = weight.points[dayIdx].day;
      // Value tracks the period's weight mean (with tiny jitter).
      const v = 5.0 + dayIdx * 0.01 + (i % 2 ? 0.02 : -0.02);
      draws.push({ key: "LAB:HbA1c", day, value: v });
    }
    const result = discoverLabOutcomeCorrelations(draws, [weight], {
      locale: "en",
      minDraws: 5,
      minWindowPoints: 5,
    });
    const pair = result.discovered.find(
      (d) => d.lab === "LAB:HbA1c" && d.outcome === "WEIGHT",
    );
    expect(pair).toBeDefined();
    expect(pair!.n).toBeGreaterThanOrEqual(5);
    expect(pair!.r).toBeGreaterThan(0);
    expect(pair!.qValue).toBeLessThanOrEqual(result.fdrQ);
    expect(pair!.interpretation).toMatch(/never a cause/i);
  });

  it("degrades to absent when the marker has too few draws", () => {
    const weight = weightSeries();
    const draws: LabDrawPoint[] = [0, 1, 2].map((i) => ({
      key: "LAB:HbA1c",
      day: weight.points[30 + i * 18].day,
      value: 5 + i,
    }));
    const result = discoverLabOutcomeCorrelations(draws, [weight], {
      locale: "en",
      minDraws: 5,
    });
    expect(result.discovered).toHaveLength(0);
    expect(result.pairsTested).toBe(0);
  });

  it("ignores outcomes outside the curated lab-target set", () => {
    const hrv: NamedSeries = {
      key: "HEART_RATE_VARIABILITY",
      role: "outcome",
      points: seriesFrom(
        "2026-01-01",
        Array.from({ length: 180 }, (_, i) => 50 + i * 0.1),
      ),
    };
    const draws: LabDrawPoint[] = Array.from({ length: 8 }, (_, i) => ({
      key: "LAB:HbA1c",
      day: hrv.points[30 + i * 18].day,
      value: 5 + i,
    }));
    const result = discoverLabOutcomeCorrelations(draws, [hrv], {
      locale: "en",
      minDraws: 5,
    });
    // HRV is not a curated lab-outcome target → no pair tested.
    expect(result.pairsTested).toBe(0);
  });
});

describe("v1.42 — per-series lag and the averaged environment window", () => {
  it("pairs a lagDays-0 exposure with the same day and narrates it so", () => {
    // Exposure (already the D−1/D mean upstream) drives the outcome on the
    // SAME day; the default next-day join would see noise.
    const { behaviour, outcome } = coupledPair(31, 120, 2);
    const sameDayOutcome = outcome.slice(1);
    const exposure = behaviour.slice(0, -1);
    const result = discoverCorrelations(
      [
        {
          key: "ENV_TEMP_MIN",
          role: "behaviour",
          points: longSeries(exposure),
          lagDays: 0,
        },
        {
          key: "SLEEP_DURATION",
          role: "outcome",
          points: longSeries(sameDayOutcome),
        },
      ],
      { locale: "en" },
    );
    expect(result.pairsTested).toBe(1);
    const pair = result.discovered[0];
    expect(pair).toBeDefined();
    expect(pair.lagDays).toBe(0);
    expect(pair.nEff).toBeGreaterThan(0);
    expect(pair.nEff).toBeLessThanOrEqual(pair.n);
    expect(pair.interpretation).toMatch(/on the day and the day before/);
    expect(pair.interpretation).not.toMatch(/next-day/);
  });

  it("keeps the next-day lag and wording for every other channel", () => {
    const { behaviour, outcome } = coupledPair(11, 90, 2);
    const result = discoverCorrelations(
      [
        {
          key: "ACTIVITY_STEPS",
          role: "behaviour",
          points: longSeries(behaviour),
        },
        { key: "SLEEP_DURATION", role: "outcome", points: longSeries(outcome) },
      ],
      { locale: "en" },
    );
    expect(result.discovered[0].lagDays).toBe(1);
    expect(result.discovered[0].interpretation).toMatch(/next-day/);
  });

  it("counts each exposure × outcome once in the false-discovery family", () => {
    const { behaviour, outcome } = coupledPair(13, 90, 0);
    const result = discoverCorrelations(
      [
        {
          key: "ENV_PRESSURE_MEAN",
          role: "behaviour",
          points: longSeries(behaviour),
          lagDays: 0,
        },
        { key: "MOOD", role: "outcome", points: longSeries(outcome) },
        {
          key: "SLEEP_DURATION",
          role: "outcome",
          points: longSeries(outcome),
        },
      ],
      { locale: "en" },
    );
    expect(result.pairsTested).toBe(2);
  });

  it("carries a series' own lag into the emerging pass", () => {
    const { behaviour, outcome } = coupledPair(17, 40, 3, { noiseSd: 0.5 });
    const series: NamedSeries[] = [
      {
        key: "ENV_TEMP_MEAN",
        role: "behaviour",
        points: longSeries(behaviour.slice(0, -1)),
        lagDays: 0,
      },
      {
        key: "HEART_RATE_VARIABILITY",
        role: "outcome",
        points: longSeries(outcome.slice(1)),
      },
    ];
    const empty = { discovered: [], pairsTested: 0, fdrQ: 0.1, minPairs: 20 };
    const { emerging } = discoverEmergingCorrelations(series, empty, {
      recentFromDayKey: longSeries(behaviour)[0].day,
      locale: "en",
      minPairs: 10,
    });
    expect(emerging[0]?.lagDays).toBe(0);
  });
});
