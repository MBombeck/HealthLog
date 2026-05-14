import { describe, expect, it } from "vitest";

import { pickCanonicalSourceRows } from "../source-priority";

/**
 * v1.4.25 W5e — cross-source canonical-row picker tests.
 * v1.4.25 W8c — two-axis picker (source + device-type) tests.
 *
 * Coverage focuses on the cumulative-metric use case where two
 * sources record the same day's value and one must win.
 */
function isoDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("pickCanonicalSourceRows — single-axis cumulative-metric picker", () => {
  it("returns empty for empty input", () => {
    const out = pickCanonicalSourceRows([], "steps", null, isoDayKey);
    expect(out.canonicalRows).toEqual([]);
    expect(out.pickedByDay.size).toBe(0);
  });

  it("passes everything through when only one source contributed", () => {
    // v1.4.25 reality: only WITHINGS rows exist; the picker is a
    // pass-through and the daily total matches the pre-W5e behaviour.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T08:00:00Z"),
        source: "WITHINGS" as const,
        value: 4000,
      },
      {
        measuredAt: new Date("2026-05-12T20:00:00Z"),
        source: "WITHINGS" as const,
        value: 2000,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "steps", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(2);
    expect(out.pickedByDay.get("2026-05-12")).toBe("WITHINGS");
  });

  it("picks APPLE_HEALTH over WITHINGS for cumulative steps (default priority)", () => {
    // The Marc-directive default for cumulative metrics puts iOS first
    // because HealthKit aggregates ScanWatch + iPhone sensors.
    const rows = [
      // Same day, both sources reported — naïvely summing would
      // double-count (8500 instead of 5500 or 5000).
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "WITHINGS" as const,
        value: 3000,
      },
      {
        measuredAt: new Date("2026-05-12T18:00:00Z"),
        source: "WITHINGS" as const,
        value: 2000,
      },
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        value: 5500,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "steps", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("APPLE_HEALTH");
    expect(out.canonicalRows[0].value).toBe(5500);
    expect(out.pickedByDay.get("2026-05-12")).toBe("APPLE_HEALTH");
  });

  it("respects a user override (MANUAL > WITHINGS > APPLE_HEALTH for weight)", () => {
    const rows = [
      {
        measuredAt: new Date("2026-05-12T07:00:00Z"),
        source: "WITHINGS" as const,
        value: 82.4,
      },
      {
        measuredAt: new Date("2026-05-12T07:30:00Z"),
        source: "APPLE_HEALTH" as const,
        value: 82.3,
      },
      {
        measuredAt: new Date("2026-05-12T08:00:00Z"),
        source: "MANUAL" as const,
        value: 82.0,
      },
    ];
    // W5e flat shape still accepted (back-compat).
    const userPriority = {
      weight: ["MANUAL", "WITHINGS", "APPLE_HEALTH"],
    };
    const out = pickCanonicalSourceRows(
      rows,
      "weight",
      userPriority,
      isoDayKey,
    );
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("MANUAL");
    expect(out.canonicalRows[0].value).toBe(82.0);
  });

  it("picks per-day independently — different sources on different days", () => {
    const rows = [
      // 2026-05-12 — only Withings reported.
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "WITHINGS" as const,
        value: 5500,
      },
      // 2026-05-13 — both reported.
      {
        measuredAt: new Date("2026-05-13T09:00:00Z"),
        source: "WITHINGS" as const,
        value: 3000,
      },
      {
        measuredAt: new Date("2026-05-13T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        value: 4800,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "steps", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(2);
    // Day 1 keeps WITHINGS (only source present).
    expect(out.pickedByDay.get("2026-05-12")).toBe("WITHINGS");
    // Day 2 picks APPLE_HEALTH per default priority.
    expect(out.pickedByDay.get("2026-05-13")).toBe("APPLE_HEALTH");
  });

  it("keeps every row when no priority-listed source is present (forward-compat fallback)", () => {
    // IMPORT isn't in the default priority list — without the
    // fallback, every IMPORT row would silently drop from the
    // aggregation and the daily total would read zero.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "IMPORT" as const,
        value: 6000,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "steps", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("IMPORT");
  });

  it("handles a malformed priority Json blob by falling back to defaults", () => {
    const rows = [
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "WITHINGS" as const,
        value: 3000,
      },
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        value: 5500,
      },
    ];
    // Garbage payload — `parseSourcePriority` returns defaults.
    const out = pickCanonicalSourceRows(rows, "steps", "not-json", isoDayKey);
    expect(out.canonicalRows[0].source).toBe("APPLE_HEALTH");
  });
});

describe("pickCanonicalSourceRows — v1.4.25 W8c two-axis device-type picker", () => {
  it("is a no-op when every row has the same source and no device-type", () => {
    // The pre-W8c reality: rows arrive without `deviceType` set, so
    // the second axis can't differentiate anything — every row in the
    // bucket passes through. Locks in the back-compat invariant.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T08:00:00Z"),
        source: "WITHINGS" as const,
        value: 4000,
      },
      {
        measuredAt: new Date("2026-05-12T20:00:00Z"),
        source: "WITHINGS" as const,
        value: 2000,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "steps", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(2);
  });

  it("keeps only `watch` rows when same source contributed watch + phone (default device ladder)", () => {
    // Apple Watch + iPhone both stream steps via HealthKit. Summing
    // both triple-counts. Default ladder is watch > ring > band >
    // phone > scale > other > unknown, so watch wins.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "watch",
        type: "ACTIVITY_STEPS" as const,
        value: 1500,
      },
      {
        measuredAt: new Date("2026-05-12T10:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "watch",
        type: "ACTIVITY_STEPS" as const,
        value: 2400,
      },
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "phone",
        type: "ACTIVITY_STEPS" as const,
        value: 4100,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "steps", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(2);
    expect(out.canonicalRows.every((r) => r.deviceType === "watch")).toBe(true);
    expect(out.pickedByDay.get("2026-05-12")).toBe("APPLE_HEALTH");
  });

  it("respects a user-level deviceTypePriority default ladder", () => {
    // User explicitly demoted watch in favour of phone — maybe their
    // ScanWatch is currently broken and they trust iPhone.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "watch",
        type: "ACTIVITY_STEPS" as const,
        value: 1500,
      },
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "phone",
        type: "ACTIVITY_STEPS" as const,
        value: 4100,
      },
    ];
    const userPriority = {
      deviceTypePriority: {
        default: ["phone", "watch"],
      },
    };
    const out = pickCanonicalSourceRows(
      rows,
      "steps",
      userPriority,
      isoDayKey,
    );
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].deviceType).toBe("phone");
    expect(out.canonicalRows[0].value).toBe(4100);
  });

  it("respects a per-MeasurementType deviceTypePriority override", () => {
    // For ACTIVITY_STEPS the user prefers phone (gym headphones);
    // every other metric stays default. Verify the override fires.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "watch",
        type: "ACTIVITY_STEPS" as const,
        value: 1500,
      },
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "phone",
        type: "ACTIVITY_STEPS" as const,
        value: 4100,
      },
    ];
    const userPriority = {
      deviceTypePriority: {
        default: ["watch", "phone"],
        // Override: phone wins for steps specifically.
        ACTIVITY_STEPS: ["phone", "watch"],
      },
    };
    const out = pickCanonicalSourceRows(
      rows,
      "steps",
      userPriority,
      isoDayKey,
    );
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].deviceType).toBe("phone");
  });

  it("keeps unknown/legacy NULL rows when no ranked device-type coexists", () => {
    // A pre-v1.4.25 Withings row has `deviceType: null` →
    // normalizeDeviceType maps it to "unknown". With no other ranked
    // device-type in the bucket, the picker must keep the row so
    // legacy data continues to drive analytics.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T07:00:00Z"),
        source: "WITHINGS" as const,
        deviceType: null,
        type: "WEIGHT" as const,
        value: 82.4,
      },
      {
        measuredAt: new Date("2026-05-12T19:00:00Z"),
        source: "WITHINGS" as const,
        deviceType: null,
        type: "WEIGHT" as const,
        value: 82.5,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "weight", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(2);
  });

  it("prefers a known device-type over `unknown` legacy rows", () => {
    // Mixed bucket — a new `scale`-tagged row coexists with two
    // legacy NULL rows. The picker must drop the legacy rows in
    // favour of the well-tagged one.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T07:00:00Z"),
        source: "WITHINGS" as const,
        deviceType: null,
        type: "WEIGHT" as const,
        value: 82.4,
      },
      {
        measuredAt: new Date("2026-05-12T19:00:00Z"),
        source: "WITHINGS" as const,
        deviceType: "scale",
        type: "WEIGHT" as const,
        value: 82.5,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "weight", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].deviceType).toBe("scale");
  });

  it("falls through (keeps every row) when the user ladder doesn't list any present device-type", () => {
    // User typed `["ring"]` as their custom ladder; bucket has only
    // `["watch","phone"]`. The picker can't pick anything from the
    // ladder, so it preserves data rather than silently dropping it.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "watch",
        type: "ACTIVITY_STEPS" as const,
        value: 1500,
      },
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "phone",
        type: "ACTIVITY_STEPS" as const,
        value: 4100,
      },
    ];
    const userPriority = {
      deviceTypePriority: {
        default: ["ring"],
      },
    };
    const out = pickCanonicalSourceRows(
      rows,
      "steps",
      userPriority,
      isoDayKey,
    );
    expect(out.canonicalRows).toHaveLength(2);
  });

  it("resolves the device-type ladder per row when the bucket carries mixed MeasurementTypes", () => {
    // v1.4.25 W10 reconcile (Sr-H2) — when a caller batches more than
    // one MeasurementType through a single picker call (Coach evidence
    // rollup, doctor-PDF section, correlations engine), each row-type
    // must resolve against its OWN ladder. The pre-W10 picker pinned
    // the ladder to `pickedRows[0].type` for the whole bucket, so a
    // bucket with WEIGHT-prefers-scale + ACTIVITY_STEPS-prefers-watch
    // rows would test the ACTIVITY_STEPS rows against the WEIGHT
    // ladder. Verify each type's winner survives independently.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T07:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "scale",
        type: "WEIGHT" as const,
        value: 82.4,
      },
      {
        measuredAt: new Date("2026-05-12T07:05:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "watch",
        type: "WEIGHT" as const,
        value: 82.5,
      },
      {
        measuredAt: new Date("2026-05-12T07:30:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "watch",
        type: "ACTIVITY_STEPS" as const,
        value: 1500,
      },
      {
        measuredAt: new Date("2026-05-12T07:35:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "phone",
        type: "ACTIVITY_STEPS" as const,
        value: 4100,
      },
    ];
    const userPriority = {
      deviceTypePriority: {
        // Per-type override: scale wins for WEIGHT (not watch — that's
        // the bucket's first row, which the pre-W10 picker would have
        // used to resolve the ladder for every row).
        WEIGHT: ["scale", "watch"],
        // ACTIVITY_STEPS keeps watch on top so its winner stays watch
        // and the bucket survives the per-row ladder walk with both
        // types' canonical rows preserved.
        ACTIVITY_STEPS: ["watch", "phone"],
      },
    };
    const out = pickCanonicalSourceRows(
      rows,
      "steps",
      userPriority,
      isoDayKey,
    );
    // Expect: WEIGHT's scale row + ACTIVITY_STEPS' watch row. Both
    // types' losers (WEIGHT's watch row, ACTIVITY_STEPS' phone row)
    // are dropped against their OWN ladder, not the bucket's first
    // row's ladder.
    expect(out.canonicalRows).toHaveLength(2);
    const byType = new Map(
      out.canonicalRows.map((r) => [r.type, r.deviceType]),
    );
    expect(byType.get("WEIGHT")).toBe("scale");
    expect(byType.get("ACTIVITY_STEPS")).toBe("watch");
  });

  it("falls through per row-type when a custom ladder doesn't enumerate that type's present device-types", () => {
    // Mixed-type bucket where ONE row-type's user ladder doesn't
    // include any present device-type. Per-type fall-through: keep
    // every row of that type, drop the other type's losers normally.
    const rows = [
      // WEIGHT — user's ladder says `ring` wins, but only `scale`
      // present → fall through, keep both WEIGHT rows.
      {
        measuredAt: new Date("2026-05-12T07:00:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "scale",
        type: "WEIGHT" as const,
        value: 82.4,
      },
      {
        measuredAt: new Date("2026-05-12T07:05:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "scale",
        type: "WEIGHT" as const,
        value: 82.5,
      },
      // ACTIVITY_STEPS — normal default ladder, watch wins over phone.
      {
        measuredAt: new Date("2026-05-12T07:30:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "watch",
        type: "ACTIVITY_STEPS" as const,
        value: 1500,
      },
      {
        measuredAt: new Date("2026-05-12T07:35:00Z"),
        source: "APPLE_HEALTH" as const,
        deviceType: "phone",
        type: "ACTIVITY_STEPS" as const,
        value: 4100,
      },
    ];
    const userPriority = {
      deviceTypePriority: {
        WEIGHT: ["ring"],
      },
    };
    const out = pickCanonicalSourceRows(
      rows,
      "steps",
      userPriority,
      isoDayKey,
    );
    // 2 WEIGHT rows kept (per-type fall-through) + 1 ACTIVITY_STEPS
    // watch row (phone dropped against default ladder).
    expect(out.canonicalRows).toHaveLength(3);
    const weightRows = out.canonicalRows.filter((r) => r.type === "WEIGHT");
    const stepRows = out.canonicalRows.filter(
      (r) => r.type === "ACTIVITY_STEPS",
    );
    expect(weightRows).toHaveLength(2);
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0].deviceType).toBe("watch");
  });

  it("two-axis lookup order: per-metric override > metricPriority > flat default", () => {
    // Full-stack test: nested W8c metricPriority pins WITHINGS first
    // for weight even though the constant default ladder has WITHINGS
    // first anyway — verify the W8c shape is consulted. Mixed-source
    // bucket; the picker must reach the nested key.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T07:00:00Z"),
        source: "WITHINGS" as const,
        deviceType: "scale",
        type: "WEIGHT" as const,
        value: 82.4,
      },
      {
        measuredAt: new Date("2026-05-12T07:30:00Z"),
        source: "MANUAL" as const,
        deviceType: null,
        type: "WEIGHT" as const,
        value: 82.0,
      },
    ];
    const userPriority = {
      // Flat shape says MANUAL wins.
      weight: ["MANUAL", "WITHINGS"],
      // Nested W8c shape says WITHINGS wins — should beat the flat shape.
      metricPriority: { weight: ["WITHINGS", "MANUAL"] },
    };
    const out = pickCanonicalSourceRows(
      rows,
      "weight",
      userPriority,
      isoDayKey,
    );
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("WITHINGS");
  });
});
