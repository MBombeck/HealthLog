import { describe, it, expect } from "vitest";

import { METRIC_BOUNDS } from "@/lib/analytics/effective-range";
import { resolveTargetUnitAdapter } from "../target-unit-display";
import { toCanonicalMgdl } from "@/lib/glucose";

/**
 * v1.32.27 — the target/threshold unit adapter.
 *
 * The dangerous failure mode this subsystem exists to avoid is a HALF
 * wire: display converted, edit seed or save left canonical, so the
 * user's typed number silently changes meaning between save and reopen.
 * These assertions pin the whole loop — seed, guardrail, save, reopen —
 * for the weight class (a pure scale) and for temperature (the affine
 * one, where an offset leaking into a delta is the classic bug).
 */

const KG_PER_LB = 0.45359237;

describe("resolveTargetUnitAdapter — metric account (identity)", () => {
  it("leaves a weight threshold bit-for-bit untouched", () => {
    const units = resolveTargetUnitAdapter("WEIGHT", "kg", "metric", "mg/dL");
    expect(units.rescales).toBe(false);
    expect(units.unit).toBe("kg");
    // Not "close to" — exactly the same double, in both directions.
    for (const value of [30, 68.04, 72.5, 300, 88.123456789]) {
      expect(units.toDisplay(value)).toBe(value);
      expect(units.toCanonical(value)).toBe(value);
      expect(units.toDisplayDelta(value)).toBe(value);
    }
    expect(units.bounds(METRIC_BOUNDS.WEIGHT)).toEqual({ min: 1, max: 300 });
    expect(units.step).toBe(0.1);
  });

  it("leaves an untransformed metric alone under either preference", () => {
    for (const preference of ["metric", "imperial"] as const) {
      const units = resolveTargetUnitAdapter(
        "BLOOD_PRESSURE_SYS",
        "mmHg",
        preference,
        "mg/dL",
      );
      expect(units.rescales).toBe(false);
      expect(units.unit).toBe("mmHg");
      expect(units.toDisplay(118)).toBe(118);
      expect(units.toCanonical(118)).toBe(118);
      expect(units.bounds(METRIC_BOUNDS.BLOOD_PRESSURE_SYS)).toEqual({
        min: 80,
        max: 220,
      });
    }
  });

  it("is inert for the keys the edit sheet passes on its non-metric paths", () => {
    // A derived card (BMI, mood, medication compliance) has no editable
    // threshold and the sheet resolves the adapter with an empty key.
    for (const key of ["", "BMI"]) {
      const units = resolveTargetUnitAdapter(
        key,
        "mmol/L",
        "imperial",
        "mg/dL",
      );
      expect(units.rescales).toBe(false);
      expect(units.unit).toBe("mmol/L");
      expect(units.toDisplay(5.5)).toBe(5.5);
      expect(units.toCanonical(5.5)).toBe(5.5);
    }
  });

  it("keeps the whole-hundred step for a step-count target", () => {
    for (const preference of ["metric", "imperial"] as const) {
      expect(
        resolveTargetUnitAdapter("ACTIVITY_STEPS", "steps", preference, "mg/dL")
          .step,
      ).toBe(100);
    }
  });
});

describe("resolveTargetUnitAdapter — imperial weight class", () => {
  const units = resolveTargetUnitAdapter("WEIGHT", "kg", "imperial", "mg/dL");

  it("announces pounds and a one-decimal step", () => {
    expect(units.rescales).toBe(true);
    expect(units.unit).toBe("lb");
    expect(units.step).toBe(0.1);
  });

  it("seeds a stored kilogram threshold into pounds", () => {
    // 68.04 kg is what 150 lb persists as; it must read back as 150.
    expect(units.toDisplay(68.04)).toBe(150);
    expect(units.toDisplay(80)).toBe(176.4);
  });

  it("saves a typed pound value back as canonical kilograms", () => {
    expect(units.toCanonical(150)).toBe(68.04);
    // 80 kg renders as 176.4 lb; typing 176.4 back lands on 80.01 kg,
    // one hundredth off — the unavoidable cost of a one-decimal pound
    // field. What must NOT drift is the number the user typed, which
    // the round-trip sweep below pins.
    expect(units.toCanonical(176.4)).toBe(80.01);
  });

  it("round-trips every typed value it can render (save → reopen)", () => {
    // The property that matters: type a number, save, reopen, see the
    // same number. Swept across the whole editable window at the
    // input's own step granularity.
    for (let typed = 70; typed <= 660; typed += 0.1) {
      const shown = Math.round(typed * 10) / 10;
      const canonical = units.toCanonical(shown);
      expect(units.toDisplay(canonical)).toBe(shown);
    }
  });

  it("rounds guardrails inward so a value typed at the limit still saves", () => {
    const bounds = units.bounds(METRIC_BOUNDS.WEIGHT);
    // The 1 kg floor is 2.2046 lb: the floor rounds up to 2.3, never down,
    // so a value typed at the limit converts back inside the window.
    expect(bounds.min).toBe(2.3);
    expect(bounds.max).toBe(661.3);
    expect(units.toCanonical(bounds.min)).toBeGreaterThanOrEqual(
      METRIC_BOUNDS.WEIGHT.min,
    );
    expect(units.toCanonical(bounds.max)).toBeLessThanOrEqual(
      METRIC_BOUNDS.WEIGHT.max,
    );
  });

  it("accepts an imperial-valid value a kilogram bound would have rejected", () => {
    const bounds = units.bounds(METRIC_BOUNDS.WEIGHT);
    // 150 lb sails past the raw canonical 30–300 check as a NUMBER only
    // because the window is now expressed in pounds. Against the
    // unconverted kilogram window a 400 lb target would have been read
    // as "400 > 300, rejected" while it is a legitimate 181.44 kg.
    for (const typed of [150, 400, 660]) {
      expect(typed).toBeGreaterThanOrEqual(bounds.min);
      expect(typed).toBeLessThanOrEqual(bounds.max);
      const canonical = units.toCanonical(typed);
      expect(canonical).toBeGreaterThanOrEqual(METRIC_BOUNDS.WEIGHT.min);
      expect(canonical).toBeLessThanOrEqual(METRIC_BOUNDS.WEIGHT.max);
    }
  });

  it("still rejects a genuinely out-of-range value", () => {
    const bounds = units.bounds(METRIC_BOUNDS.WEIGHT);
    for (const typed of [0.5, 2.2, 661.4, 900]) {
      expect(typed < bounds.min || typed > bounds.max).toBe(true);
    }
  });

  it("carries the same treatment across the whole weight class", () => {
    for (const metric of ["TOTAL_BODY_WATER", "BONE_MASS"] as const) {
      const adapter = resolveTargetUnitAdapter(
        metric,
        "kg",
        "imperial",
        "mg/dL",
      );
      expect(adapter.unit).toBe("lb");
      const bounds = adapter.bounds(METRIC_BOUNDS[metric]);
      expect(adapter.toCanonical(bounds.min)).toBeGreaterThanOrEqual(
        METRIC_BOUNDS[metric].min,
      );
      expect(adapter.toCanonical(bounds.max)).toBeLessThanOrEqual(
        METRIC_BOUNDS[metric].max,
      );
    }
  });

  it("matches the exact pound definition, not an approximation", () => {
    expect(units.toCanonical(100)).toBe(
      Math.round(100 * KG_PER_LB * 100) / 100,
    );
  });
});

describe("resolveTargetUnitAdapter — temperature (the affine one)", () => {
  const units = resolveTargetUnitAdapter(
    "BODY_TEMPERATURE",
    "celsius",
    "imperial",
    "mg/dL",
  );

  it("shifts absolute readings but never a difference", () => {
    expect(units.unit).toBe("°F");
    expect(units.toDisplay(37)).toBe(98.6);
    expect(units.toDisplay(38)).toBe(100.4);
    // A one-degree-Celsius spread is a 1.8-degree-Fahrenheit spread. If
    // the delta ever picked up the +32 absolute shift it would read
    // 33.8 — the exact bug `applyDisplayTransformDelta` exists to stop.
    expect(units.toDisplayDelta(1)).toBe(1.8);
    expect(units.toDisplayDelta(1)).not.toBe(33.8);
  });

  it("keeps a rendered difference offset-free by construction", () => {
    // The range bar computes its "x above target" sentence from two
    // already-converted absolutes. That subtraction must agree with the
    // factor-only delta conversion, or the two would disagree by 32.
    for (const [a, b] of [
      [38, 37],
      [37.4, 36.6],
      [41, 35],
    ]) {
      const difference = units.toDisplay(a) - units.toDisplay(b);
      expect(difference).toBeCloseTo(units.toDisplayDelta(a - b), 6);
    }
  });

  it("round-trips a typed Fahrenheit target back to itself", () => {
    for (let typed = 95; typed <= 106; typed += 0.1) {
      const shown = Math.round(typed * 10) / 10;
      expect(units.toDisplay(units.toCanonical(shown))).toBe(shown);
    }
  });

  it("is the exact identity for a metric account", () => {
    const metricUnits = resolveTargetUnitAdapter(
      "BODY_TEMPERATURE",
      "celsius",
      "metric",
      "mg/dL",
    );
    expect(metricUnits.rescales).toBe(false);
    expect(metricUnits.toDisplay(37)).toBe(37);
    expect(metricUnits.toCanonical(37)).toBe(37);
    expect(metricUnits.toDisplayDelta(1)).toBe(1);
  });

  it("rounds an affine guardrail inward on both ends", () => {
    const bounds = units.bounds({ min: 30, max: 45 });
    // 30 °C = 86 °F and 45 °C = 113 °F exactly; inward rounding must not
    // drift a clean bound off its own value.
    expect(bounds).toEqual({ min: 86, max: 113 });
    expect(units.toCanonical(bounds.min)).toBeGreaterThanOrEqual(30);
    expect(units.toCanonical(bounds.max)).toBeLessThanOrEqual(45);
  });
});

describe("resolveTargetUnitAdapter — glucose thresholds follow the glucose unit", () => {
  const contexts = [
    "BLOOD_GLUCOSE_FASTING",
    "BLOOD_GLUCOSE_POSTPRANDIAL",
    "BLOOD_GLUCOSE_RANDOM",
    "BLOOD_GLUCOSE_BEDTIME",
  ] as const;

  it("reads mmol/L for an mmol/L reader, whatever the metric/imperial branch", () => {
    for (const metric of contexts) {
      for (const preference of ["metric", "imperial"] as const) {
        const units = resolveTargetUnitAdapter(
          metric,
          "mg/dL",
          preference,
          "mmol/L",
        );
        expect(units.unit).toBe("mmol/L");
        expect(units.rescales).toBe(true);
        expect(units.step).toBe(0.1);
        // The 70–99 mg/dL fasting default reads 3.9–5.5.
        expect(units.toDisplay(70)).toBe(3.9);
        expect(units.toDisplay(99)).toBe(5.5);
      }
    }
  });

  it("round-trips a typed mmol/L value to whole mg/dL and back", () => {
    const units = resolveTargetUnitAdapter(
      "BLOOD_GLUCOSE_FASTING",
      "mg/dL",
      "metric",
      "mmol/L",
    );
    expect(units.toCanonical(5.5)).toBe(99);
    expect(units.toDisplay(units.toCanonical(5.5))).toBe(5.5);
    expect(units.toCanonical(3.9)).toBe(toCanonicalMgdl(3.9, "mmol/L"));
  });

  it("rounds the canonical 40–400 mg/dL guardrail inward", () => {
    const units = resolveTargetUnitAdapter(
      "BLOOD_GLUCOSE_FASTING",
      "mg/dL",
      "metric",
      "mmol/L",
    );
    const bounds = units.bounds(METRIC_BOUNDS.BLOOD_GLUCOSE_FASTING);
    expect(bounds).toEqual({ min: 2.3, max: 22.1 });
    expect(units.toCanonical(bounds.min)).toBeGreaterThanOrEqual(
      METRIC_BOUNDS.BLOOD_GLUCOSE_FASTING.min,
    );
    expect(units.toCanonical(bounds.max)).toBeLessThanOrEqual(
      METRIC_BOUNDS.BLOOD_GLUCOSE_FASTING.max,
    );
  });

  it("stays the exact identity for an mg/dL reader", () => {
    const units = resolveTargetUnitAdapter(
      "BLOOD_GLUCOSE_FASTING",
      "mg/dL",
      "imperial",
      "mg/dL",
    );
    expect(units.unit).toBe("mg/dL");
    expect(units.rescales).toBe(false);
    expect(units.toDisplay(99)).toBe(99);
    expect(units.toCanonical(99)).toBe(99);
  });
});
