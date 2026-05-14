import { describe, expect, it } from "vitest";

import { pickCanonicalSourceRows } from "../source-priority";

/**
 * v1.4.25 W5e — cross-source canonical-row picker tests.
 *
 * Coverage focuses on the cumulative-metric use case where two
 * sources record the same day's value and one must win.
 */
function isoDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("pickCanonicalSourceRows — cumulative-metric picker", () => {
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
