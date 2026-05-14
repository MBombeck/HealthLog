/**
 * v1.4.25 W17b/c — cross-source priority verification when both
 * Withings (activity + sleep v2 ingest) AND Apple Health (iOS
 * passthrough, v1.5) populate the same metric for the same day.
 *
 * The Marc-directive default priority (W8c — see
 * `src/lib/validations/source-priority.ts`) picks APPLE_HEALTH first
 * for every cumulative metric (steps, active energy, walking-running
 * distance, flights climbed) because HealthKit aggregates iPhone +
 * watch + scale into a single canonical stream. Withings rows stay in
 * the DB as a complete shadow set — the picker just drops them from
 * the aggregation, not the persistence.
 *
 * Sleep stages add a per-row dimension via Migration 0055 — a single
 * night can carry 4–6 rows from Withings (per stage) AND 4–6 rows
 * from Apple Health (per stage). The picker must resolve per stage,
 * keeping the winning-source rows for every stage so the analytics
 * aggregator's per-stage sum doesn't double-count.
 */
import { describe, expect, it } from "vitest";

import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";

function isoDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("cross-source priority — Withings Activity + Apple Health", () => {
  it("picks APPLE_HEALTH over WITHINGS for cumulative steps (default priority)", () => {
    // Both sources reported steps for the same day. Naïve summing
    // would triple-count (8 500 + 5 000 + 2 000 = 15 500); the picker
    // keeps only the APPLE_HEALTH rows for the daily aggregation.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T23:59:59Z"),
        source: "WITHINGS" as const,
        type: "ACTIVITY_STEPS" as const,
        value: 5000,
      },
      {
        measuredAt: new Date("2026-05-12T23:59:59Z"),
        source: "WITHINGS" as const,
        type: "ACTIVITY_STEPS" as const,
        value: 2000,
      },
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        type: "ACTIVITY_STEPS" as const,
        value: 8500,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "steps", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("APPLE_HEALTH");
    expect(out.canonicalRows[0].value).toBe(8500);
    expect(out.pickedByDay.get("2026-05-12")).toBe("APPLE_HEALTH");
  });

  it("picks APPLE_HEALTH over WITHINGS for active energy + distance + flights", () => {
    // The same default applies to every cumulative metric. One
    // assertion per metric class — guards against a future schema
    // tweak that diverges one of them from the canonical ladder.
    for (const metricKey of [
      "activeEnergy",
      "walkingRunningDistance",
      "flightsClimbed",
    ] as const) {
      const rows = [
        {
          measuredAt: new Date("2026-05-12T23:59:59Z"),
          source: "WITHINGS" as const,
          type: "ACTIVE_ENERGY_BURNED" as const,
          value: 320,
        },
        {
          measuredAt: new Date("2026-05-12T08:00:00Z"),
          source: "APPLE_HEALTH" as const,
          type: "ACTIVE_ENERGY_BURNED" as const,
          value: 410,
        },
      ];
      const out = pickCanonicalSourceRows(rows, metricKey, null, isoDayKey);
      expect(out.canonicalRows).toHaveLength(1);
      expect(out.canonicalRows[0].source).toBe("APPLE_HEALTH");
    }
  });

  it("falls back to WITHINGS when Apple Health has no rows that day", () => {
    // The iOS passthrough hasn't synced yet (or the user disabled
    // HealthKit on that day) — Withings must light up the daily
    // total rather than the chart going dark.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T23:59:59Z"),
        source: "WITHINGS" as const,
        type: "ACTIVITY_STEPS" as const,
        value: 4200,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "steps", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("WITHINGS");
    expect(out.pickedByDay.get("2026-05-12")).toBe("WITHINGS");
  });

  it("respects a user override that promotes WITHINGS above APPLE_HEALTH", () => {
    // Marc could prefer his ScanWatch for steps even after iOS lands.
    // The W5e flat-shape override (back-compat) is exercised here.
    const rows = [
      {
        measuredAt: new Date("2026-05-12T23:59:59Z"),
        source: "WITHINGS" as const,
        type: "ACTIVITY_STEPS" as const,
        value: 5000,
      },
      {
        measuredAt: new Date("2026-05-12T09:00:00Z"),
        source: "APPLE_HEALTH" as const,
        type: "ACTIVITY_STEPS" as const,
        value: 8500,
      },
    ];
    const userPriority = {
      steps: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
    };
    const out = pickCanonicalSourceRows(
      rows,
      "steps",
      userPriority,
      isoDayKey,
    );
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("WITHINGS");
    expect(out.canonicalRows[0].value).toBe(5000);
  });
});

describe("cross-source priority — Withings Sleep v2 + Apple Health (per-stage)", () => {
  it("picks APPLE_HEALTH over WITHINGS for sleep when both sources reported the same night", () => {
    // Marc's ScanWatch and iPhone both wrote per-stage rows for the
    // same night. Sleep default (APPLE_HEALTH > WITHINGS) keeps only
    // the iOS rows in the aggregation.
    const measuredAt = new Date("2026-05-12T22:00:00Z");
    const rows = [
      // Withings ScanWatch — three stages.
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "CORE" as const,
        value: 240,
      },
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "DEEP" as const,
        value: 90,
      },
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "REM" as const,
        value: 80,
      },
      // Apple Health — same three stages.
      {
        measuredAt,
        source: "APPLE_HEALTH" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "CORE" as const,
        value: 250,
      },
      {
        measuredAt,
        source: "APPLE_HEALTH" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "DEEP" as const,
        value: 95,
      },
      {
        measuredAt,
        source: "APPLE_HEALTH" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "REM" as const,
        value: 82,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "sleep", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(3);
    expect(out.canonicalRows.every((r) => r.source === "APPLE_HEALTH")).toBe(
      true,
    );
    const stages = out.canonicalRows.map((r) => r.sleepStage).sort();
    expect(stages).toEqual(["CORE", "DEEP", "REM"]);
  });

  it("keeps Withings sleep rows on stages Apple Health didn't capture", () => {
    // Per-day source pick: today the picker keeps APPLE_HEALTH for
    // the whole night because Apple Health has at least one row.
    // Withings stages that Apple Health didn't capture are dropped
    // from the aggregation (NOT from the DB) — matches the picker's
    // documented "source axis dropped rows stay persisted as an audit
    // trail" contract.
    const measuredAt = new Date("2026-05-12T22:00:00Z");
    const rows = [
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "AWAKE" as const,
        value: 12,
      },
      {
        measuredAt,
        source: "APPLE_HEALTH" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "CORE" as const,
        value: 250,
      },
      {
        measuredAt,
        source: "APPLE_HEALTH" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "DEEP" as const,
        value: 95,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "sleep", null, isoDayKey);
    // Apple Health is picked for the day → only its rows survive.
    expect(out.canonicalRows).toHaveLength(2);
    expect(out.canonicalRows.every((r) => r.source === "APPLE_HEALTH")).toBe(
      true,
    );
    expect(out.pickedByDay.get("2026-05-12")).toBe("APPLE_HEALTH");
  });

  it("uses Withings-only sleep rows when iOS hasn't reported (today's v1.4.25 reality)", () => {
    // The current state of the world: v1.4.25 has no iOS
    // passthrough, so the picker falls through to WITHINGS for every
    // user. Per-stage rows from Migration 0055 must pass through
    // intact so the analytics aggregator sees the full breakdown.
    const measuredAt = new Date("2026-05-12T22:00:00Z");
    const rows = [
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "CORE" as const,
        value: 240,
      },
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "DEEP" as const,
        value: 90,
      },
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "REM" as const,
        value: 80,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "sleep", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(3);
    expect(out.canonicalRows.every((r) => r.source === "WITHINGS")).toBe(true);
  });

  it("activity rows leave sleepStage NULL; sleep rows carry non-null sleepStage — no collision in the picker", () => {
    // Confirms the picker treats activity + sleep as independent
    // metric buckets. A day with steps + sleep rows from both
    // sources resolves each axis independently.
    const measuredAt = new Date("2026-05-12T22:00:00Z");
    const allRows = [
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "ACTIVITY_STEPS" as const,
        sleepStage: null,
        value: 7000,
      },
      {
        measuredAt,
        source: "APPLE_HEALTH" as const,
        type: "ACTIVITY_STEPS" as const,
        sleepStage: null,
        value: 8000,
      },
      {
        measuredAt,
        source: "WITHINGS" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "DEEP" as const,
        value: 90,
      },
      {
        measuredAt,
        source: "APPLE_HEALTH" as const,
        type: "SLEEP_DURATION" as const,
        sleepStage: "DEEP" as const,
        value: 95,
      },
    ];

    const stepsOut = pickCanonicalSourceRows(
      allRows.filter((r) => r.type === "ACTIVITY_STEPS"),
      "steps",
      null,
      isoDayKey,
    );
    expect(stepsOut.canonicalRows).toHaveLength(1);
    expect(stepsOut.canonicalRows[0].value).toBe(8000);

    const sleepOut = pickCanonicalSourceRows(
      allRows.filter((r) => r.type === "SLEEP_DURATION"),
      "sleep",
      null,
      isoDayKey,
    );
    expect(sleepOut.canonicalRows).toHaveLength(1);
    expect(sleepOut.canonicalRows[0].value).toBe(95);
    expect(sleepOut.canonicalRows[0].sleepStage).toBe("DEEP");
  });
});
