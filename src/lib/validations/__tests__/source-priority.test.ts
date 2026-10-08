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
import { measurementSourceEnum } from "../measurement";

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
      weight: ["GARMIN", "WITHINGS"],
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

  // The cap is the number of sources: every source may be ranked once (a
  // ladder that ranks all sixteen is valid), and one entry more is refused.
  it("accepts a ladder that ranks every source, and rejects one entry more", () => {
    const every = [...measurementSourceEnum.options];
    expect(every.length).toBeGreaterThan(8);
    expect(sourcePrioritySchema.safeParse({ weight: every }).success).toBe(
      true,
    );
    expect(
      sourcePrioritySchema.safeParse({ weight: [...every, "MANUAL"] }).success,
    ).toBe(false);
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

  it("places WITHINGS first for point measurements (the maintainer directive)", () => {
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

  it("places APPLE_HEALTH first for cumulative metrics", () => {
    // HealthKit aggregates ScanWatch + iPhone sensors into a single
    // canonical stream and has higher resolution than Withings' nightly
    // summary for the cumulative activity metrics.
    for (const key of [
      "steps",
      "activeEnergy",
      "walkingRunningDistance",
      "flightsClimbed",
    ] as const) {
      expect(DEFAULT_SOURCE_PRIORITY[key][0]).toBe("APPLE_HEALTH");
    }
  });

  it("places WHOOP first for the recovery-input ladders (v1.11)", () => {
    // v1.11.0 — a worn-all-night WHOOP strap has higher-resolution
    // overnight sampling than the iPhone-relayed HealthKit summary or the
    // Withings nightly summary for sleep / HRV / RHR / respiratory rate;
    // it leads those ladders ahead of APPLE_HEALTH.
    for (const key of [
      "sleep",
      "hrv",
      "restingHeartRate",
      "respiratoryRate",
    ] as const) {
      expect(DEFAULT_SOURCE_PRIORITY[key][0]).toBe("WHOOP");
    }
  });

  it("ranks device-native recovery above the COMPUTED proxy (v1.11/v1.17)", () => {
    // v1.11.0 — native-vs-derived: a device-native Recovery outranks
    // HealthLog's COMPUTED proxy when both exist, with the proxy as the
    // fallback for users without a wearable. v1.17.0 — Oura readiness and
    // Polar nightly recovery slot between WHOOP and the proxy.
    expect(DEFAULT_SOURCE_PRIORITY.recovery).toEqual([
      "WHOOP",
      "OURA",
      "POLAR",
      "COMPUTED",
    ]);
    // The COMPUTED proxy stays the last resort regardless of how many
    // native wearables precede it.
    expect(DEFAULT_SOURCE_PRIORITY.recovery.at(-1)).toBe("COMPUTED");
  });

  it("slots Polar + Oura below the established wearables (v1.17)", () => {
    // v1.17.0 — Polar / Oura are worn wearables in the same overnight class
    // as WHOOP/Fitbit; they rank below the established straps but above the
    // iPhone-relayed HealthKit summary and the Withings nightly summary on
    // the recovery-input ladders.
    for (const key of ["sleep", "hrv", "restingHeartRate"] as const) {
      const ladder = DEFAULT_SOURCE_PRIORITY[key];
      expect(ladder).toContain("OURA");
      expect(ladder).toContain("POLAR");
      expect(ladder.indexOf("OURA")).toBeLessThan(
        ladder.indexOf("APPLE_HEALTH"),
      );
      expect(ladder.indexOf("POLAR")).toBeLessThan(
        ladder.indexOf("APPLE_HEALTH"),
      );
      expect(ladder.indexOf("WHOOP")).toBeLessThan(ladder.indexOf("OURA"));
    }
  });

  it("appends Oura + Polar to the activity ladders below Apple Health (v1.17)", () => {
    // v1.17.0 — Oura + Polar write ACTIVITY_STEPS + ACTIVE_ENERGY_BURNED;
    // they belong on the activity ladders as legitimate sources, ranked
    // below the phone-aggregated APPLE_HEALTH but above a MANUAL entry, so
    // an Oura/Polar-only day is not dropped when another source coexists.
    for (const key of [
      "steps",
      "activeEnergy",
      "walkingRunningDistance",
    ] as const) {
      const ladder = DEFAULT_SOURCE_PRIORITY[key];
      expect(ladder).toContain("OURA");
      expect(ladder).toContain("POLAR");
      // Below the phone-aggregated all-day Apple Health stream.
      expect(ladder.indexOf("APPLE_HEALTH")).toBeLessThan(
        ladder.indexOf("OURA"),
      );
      expect(ladder.indexOf("APPLE_HEALTH")).toBeLessThan(
        ladder.indexOf("POLAR"),
      );
      // Above a hand-typed MANUAL entry — a real device beats nothing.
      expect(ladder.indexOf("OURA")).toBeLessThan(ladder.indexOf("MANUAL"));
      expect(ladder.indexOf("POLAR")).toBeLessThan(ladder.indexOf("MANUAL"));
      // No existing source loses its rank: Apple Health still leads.
      expect(ladder[0]).toBe("APPLE_HEALTH");
    }
  });

  it("ranks the pulse wearables above a MANUAL reading (v1.17)", () => {
    // v1.17.0 — a copy-paste slip had Polar / Oura ranked BELOW a hand-typed
    // MANUAL pulse. Continuous optical-HR wearables must sit above MANUAL,
    // matching the device-source order on the rhr / hrv ladders.
    const ladder = DEFAULT_SOURCE_PRIORITY.pulse;
    for (const device of ["FITBIT", "OURA", "POLAR"] as const) {
      expect(ladder.indexOf(device)).toBeLessThan(ladder.indexOf("MANUAL"));
    }
    // Device-source order matches the rhr / hrv ladders (FITBIT > OURA > POLAR).
    expect(ladder.indexOf("FITBIT")).toBeLessThan(ladder.indexOf("OURA"));
    expect(ladder.indexOf("OURA")).toBeLessThan(ladder.indexOf("POLAR"));
    // Withings stays the primary point-measurement source.
    expect(ladder[0]).toBe("WITHINGS");
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
    // v1.16.11 — the stored order leads; default-ladder sources the
    // stored array lacks append after it (reconciliation).
    expect(out.weight.slice(0, 2)).toEqual(["MANUAL", "WITHINGS"]);
    expect(out.metricPriority.weight.slice(0, 2)).toEqual([
      "MANUAL",
      "WITHINGS",
    ]);
    for (const source of DEFAULT_SOURCE_PRIORITY.weight) {
      expect(out.weight).toContain(source);
    }
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
    expect(out.metricPriority.weight.slice(0, 2)).toEqual([
      "MANUAL",
      "APPLE_HEALTH",
    ]);
    expect(out.metricPriority.steps[0]).toBe("WITHINGS");
    for (const source of DEFAULT_SOURCE_PRIORITY.steps) {
      expect(out.metricPriority.steps).toContain(source);
    }
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
    expect(out.weight.slice(0, 2)).toEqual(["MANUAL", "WITHINGS"]);
    expect(out.metricPriority.weight.slice(0, 2)).toEqual([
      "MANUAL",
      "WITHINGS",
    ]);
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
    expect(out.weight.slice(0, 2)).toEqual(["MANUAL", "APPLE_HEALTH"]);
    for (const source of DEFAULT_SOURCE_PRIORITY.weight) {
      expect(out.weight).toContain(source);
    }
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
    expect(getSourceLadder(resolved, "weight")[0]).toBe("MANUAL");
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
    expect(getDeviceTypeLadder(resolved, "WEIGHT")).toEqual(["scale", "watch"]);
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

describe("parseSourcePriority — stored-ladder reconciliation (v1.16.11)", () => {
  // A ladder saved before a source existed used to hide that source
  // forever: the stored array replaced the default wholesale, the
  // settings UI offers reorder but not add, and the picker ranked the
  // invisible source last. The resolver now appends default-ladder
  // sources missing from the stored ladder AFTER the user's explicit
  // order — visible, reorderable, same effective rank as before.
  it("appends sources the default ladder gained after the user saved", () => {
    // A pre-v1.11 sleep ladder: no WHOOP, no FITBIT.
    const resolved = parseSourcePriority({
      metricPriority: {
        sleep: ["APPLE_HEALTH", "MANUAL", "WITHINGS", "IMPORT"],
      },
    });
    expect(resolved.metricPriority.sleep.slice(0, 4)).toEqual([
      "APPLE_HEALTH",
      "MANUAL",
      "WITHINGS",
      "IMPORT",
    ]);
    // Appended in default-ladder order, after the stored entries.
    expect(resolved.metricPriority.sleep).toContain("WHOOP");
    expect(resolved.metricPriority.sleep).toContain("FITBIT");
    expect(resolved.metricPriority.sleep.indexOf("WHOOP")).toBeGreaterThan(3);
    expect(resolved.metricPriority.sleep.indexOf("WHOOP")).toBeLessThan(
      resolved.metricPriority.sleep.indexOf("FITBIT"),
    );
  });

  it("leaves a complete stored ladder byte-identical", () => {
    const full = [...DEFAULT_SOURCE_PRIORITY.sleep].reverse();
    const resolved = parseSourcePriority({
      metricPriority: { sleep: full },
    });
    expect(resolved.metricPriority.sleep).toEqual(full);
  });

  it("keeps stored entries the default ladder does not know", () => {
    const resolved = parseSourcePriority({
      metricPriority: { sleep: ["MANUAL", "WHOOP"] },
    });
    expect(resolved.metricPriority.sleep[0]).toBe("MANUAL");
    expect(resolved.metricPriority.sleep[1]).toBe("WHOOP");
    expect(resolved.metricPriority.sleep).toContain("APPLE_HEALTH");
    expect(resolved.metricPriority.sleep).toContain("WITHINGS");
  });
});

describe("parseSourcePriority — duplicate tolerance (v1.16.11)", () => {
  it("collapses duplicates so a resolved ladder can never overflow the schema cap", () => {
    const resolved = parseSourcePriority({
      metricPriority: {
        weight: ["MANUAL", "MANUAL", "WITHINGS", "MANUAL", "WITHINGS"],
      },
    });
    const ladder = resolved.metricPriority.weight;
    expect(new Set(ladder).size).toBe(ladder.length);
    expect(ladder.slice(0, 2)).toEqual(["MANUAL", "WITHINGS"]);
    expect(ladder.length).toBeLessThanOrEqual(8);
  });
});
