import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEVICE_TYPE_PRIORITY,
  DEFAULT_SOURCE_PRIORITY,
  SOURCE_PRIORITY_METRIC_KEYS,
  deviceTypeEnum,
  getDeviceTypeLadder,
  getSourceLadder,
  normalizeDeviceType,
  parseSourcePriority,
  sourcePrioritySchema,
} from "../source-priority";

/**
 * v1.4.25 W5e — per-user, per-metric-class source-priority foundation.
 * v1.4.25 W8c — two-axis extension: `metricPriority` + `deviceTypePriority`.
 */
describe("sourcePrioritySchema", () => {
  it("accepts an empty object (every key is optional)", () => {
    const result = sourcePrioritySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a partial flat shape (one metric class only) — W5e compat", () => {
    const result = sourcePrioritySchema.safeParse({
      weight: ["WITHINGS", "MANUAL"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weight).toEqual(["WITHINGS", "MANUAL"]);
    }
  });

  it("accepts the W8c nested `metricPriority` shape", () => {
    const result = sourcePrioritySchema.safeParse({
      metricPriority: {
        weight: ["MANUAL", "WITHINGS"],
        steps: ["WITHINGS", "APPLE_HEALTH"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metricPriority?.weight).toEqual([
        "MANUAL",
        "WITHINGS",
      ]);
      expect(result.data.metricPriority?.steps).toEqual([
        "WITHINGS",
        "APPLE_HEALTH",
      ]);
    }
  });

  it("accepts the W8c `deviceTypePriority` global default", () => {
    const result = sourcePrioritySchema.safeParse({
      deviceTypePriority: {
        default: ["watch", "phone", "ring"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deviceTypePriority?.default).toEqual([
        "watch",
        "phone",
        "ring",
      ]);
    }
  });

  it("accepts the W8c `deviceTypePriority` per-metric override", () => {
    const result = sourcePrioritySchema.safeParse({
      deviceTypePriority: {
        default: ["watch", "ring", "phone"],
        ACTIVITY_STEPS: ["phone", "watch"],
        WEIGHT: ["scale"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // The catchall path stores per-metric overrides under their
      // MeasurementType-enum key.
      expect(result.data.deviceTypePriority?.ACTIVITY_STEPS).toEqual([
        "phone",
        "watch",
      ]);
      expect(result.data.deviceTypePriority?.WEIGHT).toEqual(["scale"]);
    }
  });

  it("accepts both axes in the same payload", () => {
    const result = sourcePrioritySchema.safeParse({
      metricPriority: {
        weight: ["MANUAL", "WITHINGS"],
      },
      deviceTypePriority: {
        default: ["watch", "ring"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown source string", () => {
    const result = sourcePrioritySchema.safeParse({
      weight: ["FITBIT", "WITHINGS"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown device-type string", () => {
    const result = sourcePrioritySchema.safeParse({
      deviceTypePriority: {
        default: ["fitbit-tracker"],
      },
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

describe("deviceTypeEnum", () => {
  it("accepts every documented device-type slot", () => {
    for (const value of [
      "watch",
      "band",
      "ring",
      "phone",
      "scale",
      "other",
      "unknown",
    ] as const) {
      expect(deviceTypeEnum.safeParse(value).success).toBe(true);
    }
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
});

describe("DEFAULT_DEVICE_TYPE_PRIORITY", () => {
  it("is non-empty and contains every enum slot", () => {
    // The picker treats an unknown device-type as `"unknown"` — to
    // stay safe the constant must include the `unknown` slot or
    // legacy/NULL-tagged rows would never resolve a rank.
    expect(DEFAULT_DEVICE_TYPE_PRIORITY.length).toBe(7);
    expect(DEFAULT_DEVICE_TYPE_PRIORITY).toContain("unknown");
  });

  it("places `watch` first (open-wearables-compatible default)", () => {
    expect(DEFAULT_DEVICE_TYPE_PRIORITY[0]).toBe("watch");
  });
});

describe("parseSourcePriority", () => {
  it("returns defaults for null input", () => {
    const out = parseSourcePriority(null);
    expect(out).toMatchObject(DEFAULT_SOURCE_PRIORITY);
    expect(out.metricPriority).toEqual(DEFAULT_SOURCE_PRIORITY);
    expect(out.deviceTypePriority).toEqual({});
  });

  it("returns defaults for undefined input", () => {
    const out = parseSourcePriority(undefined);
    expect(out).toMatchObject(DEFAULT_SOURCE_PRIORITY);
  });

  it("returns defaults for malformed input (forward-compat fallback)", () => {
    expect(parseSourcePriority({ weight: "WITHINGS" })).toMatchObject(
      DEFAULT_SOURCE_PRIORITY,
    );
    expect(parseSourcePriority("not an object")).toMatchObject(
      DEFAULT_SOURCE_PRIORITY,
    );
  });

  it("merges a flat partial shape onto defaults (W5e compat)", () => {
    const partial = {
      weight: ["MANUAL", "WITHINGS"] as const,
    };
    const out = parseSourcePriority(partial);
    expect(out.weight).toEqual(["MANUAL", "WITHINGS"]);
    expect(out.metricPriority.weight).toEqual(["MANUAL", "WITHINGS"]);
    // Other keys keep their defaults.
    expect(out.steps).toEqual(DEFAULT_SOURCE_PRIORITY.steps);
    expect(out.bloodPressure).toEqual(DEFAULT_SOURCE_PRIORITY.bloodPressure);
  });

  it("merges a W8c nested `metricPriority` onto defaults", () => {
    const partial = {
      metricPriority: {
        weight: ["MANUAL", "APPLE_HEALTH"] as const,
        steps: ["WITHINGS"] as const,
      },
    };
    const out = parseSourcePriority(partial);
    expect(out.metricPriority.weight).toEqual(["MANUAL", "APPLE_HEALTH"]);
    expect(out.metricPriority.steps).toEqual(["WITHINGS"]);
    // Unchanged metrics keep the constant default.
    expect(out.metricPriority.bloodPressure).toEqual(
      DEFAULT_SOURCE_PRIORITY.bloodPressure,
    );
  });

  it("prefers W8c nested over W5e flat when both shapes are present", () => {
    // A user who edits the new UI ships the nested shape; if a
    // legacy/admin tool also stashed the flat shape, the nested wins.
    const out = parseSourcePriority({
      weight: ["WITHINGS"],
      metricPriority: {
        weight: ["MANUAL", "WITHINGS"],
      },
    });
    expect(out.weight).toEqual(["MANUAL", "WITHINGS"]);
    expect(out.metricPriority.weight).toEqual(["MANUAL", "WITHINGS"]);
  });

  it("surfaces `deviceTypePriority` round-trip unchanged", () => {
    const out = parseSourcePriority({
      deviceTypePriority: {
        default: ["watch", "ring"],
        WEIGHT: ["scale"],
      },
    });
    expect(out.deviceTypePriority.default).toEqual(["watch", "ring"]);
    expect(out.deviceTypePriority.WEIGHT).toEqual(["scale"]);
  });

  it("preserves a fully-specified flat shape (W5e back-compat path)", () => {
    const input = {
      ...DEFAULT_SOURCE_PRIORITY,
      weight: ["MANUAL", "APPLE_HEALTH"] as const,
    };
    const out = parseSourcePriority(input);
    expect(out.weight).toEqual(["MANUAL", "APPLE_HEALTH"]);
  });
});

describe("normalizeDeviceType", () => {
  it("returns the canonical value for every enum slot", () => {
    for (const value of [
      "watch",
      "band",
      "ring",
      "phone",
      "scale",
      "other",
      "unknown",
    ] as const) {
      expect(normalizeDeviceType(value)).toBe(value);
    }
  });

  it("returns `unknown` for null / undefined / unknown strings", () => {
    expect(normalizeDeviceType(null)).toBe("unknown");
    expect(normalizeDeviceType(undefined)).toBe("unknown");
    expect(normalizeDeviceType("fitbit")).toBe("unknown");
    expect(normalizeDeviceType(42)).toBe("unknown");
  });
});

describe("getSourceLadder + getDeviceTypeLadder helpers", () => {
  it("getSourceLadder reads the resolved metric ladder", () => {
    const resolved = parseSourcePriority({
      metricPriority: { weight: ["MANUAL"] },
    });
    expect(getSourceLadder(resolved, "weight")).toEqual(["MANUAL"]);
    expect(getSourceLadder(resolved, "bloodPressure")).toEqual(
      DEFAULT_SOURCE_PRIORITY.bloodPressure,
    );
  });

  it("getDeviceTypeLadder prefers a per-metric override", () => {
    const resolved = parseSourcePriority({
      deviceTypePriority: {
        default: ["phone", "watch"],
        WEIGHT: ["scale", "watch"],
      },
    });
    expect(getDeviceTypeLadder(resolved, "WEIGHT")).toEqual([
      "scale",
      "watch",
    ]);
  });

  it("getDeviceTypeLadder falls back to the user default ladder", () => {
    const resolved = parseSourcePriority({
      deviceTypePriority: {
        default: ["phone", "watch"],
      },
    });
    expect(getDeviceTypeLadder(resolved, "ACTIVITY_STEPS")).toEqual([
      "phone",
      "watch",
    ]);
  });

  it("getDeviceTypeLadder falls back to the constant default ladder when nothing is set", () => {
    const resolved = parseSourcePriority(null);
    expect(getDeviceTypeLadder(resolved, "ACTIVITY_STEPS")).toEqual(
      DEFAULT_DEVICE_TYPE_PRIORITY,
    );
  });
});
