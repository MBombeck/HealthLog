import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOURCE_PRIORITY,
  SOURCE_PRIORITY_METRIC_KEYS,
  parseSourcePriority,
  sourcePrioritySchema,
} from "../source-priority";

/**
 * v1.4.25 W5e — per-user, per-metric-class source-priority foundation.
 */
describe("sourcePrioritySchema", () => {
  it("accepts an empty object (every key is optional)", () => {
    const result = sourcePrioritySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a partial shape (one metric class only)", () => {
    const result = sourcePrioritySchema.safeParse({
      weight: ["WITHINGS", "MANUAL"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weight).toEqual(["WITHINGS", "MANUAL"]);
    }
  });

  it("accepts the full shape and round-trips it", () => {
    const input = {
      steps: ["APPLE_HEALTH", "WITHINGS", "MANUAL"] as const,
      weight: ["WITHINGS", "APPLE_HEALTH", "MANUAL"] as const,
      sleep: ["APPLE_HEALTH", "WITHINGS"] as const,
    };
    const result = sourcePrioritySchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps).toEqual(input.steps);
      expect(result.data.weight).toEqual(input.weight);
      expect(result.data.sleep).toEqual(input.sleep);
    }
  });

  it("rejects an unknown source string", () => {
    const result = sourcePrioritySchema.safeParse({
      weight: ["FITBIT", "WITHINGS"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 8 sources in a single metric class", () => {
    const result = sourcePrioritySchema.safeParse({
      weight: [
        "WITHINGS",
        "APPLE_HEALTH",
        "MANUAL",
        "IMPORT",
        "WITHINGS",
        "APPLE_HEALTH",
        "MANUAL",
        "IMPORT",
        "WITHINGS",
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-array value for a metric class", () => {
    const result = sourcePrioritySchema.safeParse({
      weight: "WITHINGS",
    });
    expect(result.success).toBe(false);
  });
});

describe("DEFAULT_SOURCE_PRIORITY", () => {
  it("covers every metric key declared in SOURCE_PRIORITY_METRIC_KEYS", () => {
    // A new metric class added to the constant list without a default
    // would silently read as `undefined` at the call site and crash
    // the aggregator — this guard makes that mismatch a test failure.
    for (const key of SOURCE_PRIORITY_METRIC_KEYS) {
      expect(
        DEFAULT_SOURCE_PRIORITY[key],
        `missing default for ${key}`,
      ).toBeInstanceOf(Array);
      expect(DEFAULT_SOURCE_PRIORITY[key].length).toBeGreaterThan(0);
    }
  });

  it("places WITHINGS first for point measurements (Marc directive)", () => {
    // Withings devices are the primary sensor for point readings; the
    // canonical row should come from the scale / cuff / ScanWatch /
    // Thermo rather than HealthKit's second-hand mirror.
    for (const key of [
      "weight",
      "bloodPressure",
      "pulse",
      "bodyFat",
      "bodyTemperature",
      "spo2",
      "vo2Max",
    ] as const) {
      expect(DEFAULT_SOURCE_PRIORITY[key][0]).toBe("WITHINGS");
    }
  });

  it("places APPLE_HEALTH first for cumulative metrics + HRV/sleep/RHR", () => {
    // HealthKit aggregates ScanWatch + iPhone sensors into a single
    // canonical stream and has higher resolution than Withings' nightly
    // summary for sleep stages / HRV / RHR.
    for (const key of [
      "steps",
      "activeEnergy",
      "walkingRunningDistance",
      "flightsClimbed",
      "sleep",
      "hrv",
      "restingHeartRate",
    ] as const) {
      expect(DEFAULT_SOURCE_PRIORITY[key][0]).toBe("APPLE_HEALTH");
    }
  });

  it("validates against the Zod schema (no drift between defaults and validator)", () => {
    expect(() =>
      sourcePrioritySchema.parse(DEFAULT_SOURCE_PRIORITY),
    ).not.toThrow();
  });
});

describe("parseSourcePriority", () => {
  it("returns defaults for null input", () => {
    expect(parseSourcePriority(null)).toEqual(DEFAULT_SOURCE_PRIORITY);
  });

  it("returns defaults for undefined input", () => {
    expect(parseSourcePriority(undefined)).toEqual(DEFAULT_SOURCE_PRIORITY);
  });

  it("returns defaults for malformed input (forward-compat fallback)", () => {
    expect(parseSourcePriority({ weight: "WITHINGS" })).toEqual(
      DEFAULT_SOURCE_PRIORITY,
    );
    expect(parseSourcePriority("not an object")).toEqual(
      DEFAULT_SOURCE_PRIORITY,
    );
  });

  it("merges a partial shape onto defaults (missing keys keep defaults)", () => {
    const partial = {
      weight: ["MANUAL", "WITHINGS"] as const,
    };
    const out = parseSourcePriority(partial);
    expect(out.weight).toEqual(["MANUAL", "WITHINGS"]);
    // Other keys keep their defaults.
    expect(out.steps).toEqual(DEFAULT_SOURCE_PRIORITY.steps);
    expect(out.bloodPressure).toEqual(DEFAULT_SOURCE_PRIORITY.bloodPressure);
  });

  it("preserves a fully-specified shape", () => {
    const input = {
      ...DEFAULT_SOURCE_PRIORITY,
      weight: ["MANUAL", "APPLE_HEALTH"] as const,
    };
    const out = parseSourcePriority(input);
    expect(out.weight).toEqual(["MANUAL", "APPLE_HEALTH"]);
  });
});
