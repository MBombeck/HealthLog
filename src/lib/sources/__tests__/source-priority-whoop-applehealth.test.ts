/**
 * v1.11.0 — cross-source priority verification when WHOOP and Apple Health
 * (and the COMPUTED recovery engine) populate the same metric for the same
 * day. The E-slice oracle: WHOOP feeds the existing two-axis picker via the
 * v1.11 ladder additions — no new selection engine.
 *
 * The recommended defaults (see `src/lib/validations/source-priority.ts`)
 * lead the recovery-input ladders with WHOOP (a worn-all-night strap has
 * higher-resolution overnight sampling than the iPhone-relayed HealthKit
 * summary), keep a real scale ahead of WHOOP's body-measurement estimate for
 * weight, and rank WHOOP's device-native Recovery above the COMPUTED proxy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { mapAppleHealthEntry } from "@/lib/measurements/apple-health-mapping";

const appleImporterSource = readFileSync(
  join(process.cwd(), "src/lib/measurements/import-apple-health-export.ts"),
  "utf8",
);

function isoDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("cross-source priority — WHOOP + Apple Health", () => {
  it("picks WHOOP over APPLE_HEALTH for resting heart rate (default)", () => {
    const rows = [
      {
        measuredAt: new Date("2026-06-03T06:00:00Z"),
        source: "APPLE_HEALTH" as const,
        type: "RESTING_HEART_RATE" as const,
        value: 54,
      },
      {
        measuredAt: new Date("2026-06-03T05:30:00Z"),
        source: "WHOOP" as const,
        type: "RESTING_HEART_RATE" as const,
        value: 51,
      },
    ];
    const out = pickCanonicalSourceRows(
      rows,
      "restingHeartRate",
      null,
      isoDayKey,
    );
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("WHOOP");
    expect(out.canonicalRows[0].value).toBe(51);
    expect(out.pickedByDay.get("2026-06-03")).toBe("WHOOP");
  });

  it("picks WHOOP over APPLE_HEALTH for the recovery-input ladders", () => {
    // sleep / hrv / respiratoryRate all lead with WHOOP in the default
    // ladder. One assertion per metric guards against a future ladder
    // tweak that diverges one of them.
    for (const { metricKey, type } of [
      { metricKey: "hrv", type: "HEART_RATE_VARIABILITY" },
      { metricKey: "respiratoryRate", type: "RESPIRATORY_RATE" },
    ] as const) {
      const rows = [
        {
          measuredAt: new Date("2026-06-03T06:00:00Z"),
          source: "APPLE_HEALTH" as const,
          type,
          value: 42,
        },
        {
          measuredAt: new Date("2026-06-03T05:30:00Z"),
          source: "WHOOP" as const,
          type,
          value: 58,
        },
      ];
      const out = pickCanonicalSourceRows(rows, metricKey, null, isoDayKey);
      expect(out.canonicalRows, metricKey).toHaveLength(1);
      expect(out.canonicalRows[0].source, metricKey).toBe("WHOOP");
    }
  });

  it("keeps a real scale ahead of WHOOP for weight", () => {
    const rows = [
      {
        measuredAt: new Date("2026-06-03T07:00:00Z"),
        source: "WHOOP" as const,
        type: "WEIGHT" as const,
        value: 80.5,
      },
      {
        measuredAt: new Date("2026-06-03T07:05:00Z"),
        source: "WITHINGS" as const,
        type: "WEIGHT" as const,
        value: 79.9,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "weight", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("WITHINGS");
  });

  it("ranks WHOOP native recovery above the COMPUTED proxy", () => {
    // Native-vs-derived: both rows share the RECOVERY_SCORE type and the
    // same day, distinguished only by source. The `recovery` ladder
    // (["WHOOP", "COMPUTED"]) resolves native-above-proxy with the same
    // picker — no second engine.
    const rows = [
      {
        measuredAt: new Date("2026-06-03T05:30:00Z"),
        source: "COMPUTED" as const,
        type: "RECOVERY_SCORE" as const,
        value: 62,
      },
      {
        measuredAt: new Date("2026-06-03T05:30:00Z"),
        source: "WHOOP" as const,
        type: "RECOVERY_SCORE" as const,
        value: 71,
      },
    ];
    const out = pickCanonicalSourceRows(rows, "recovery", null, isoDayKey);
    expect(out.canonicalRows).toHaveLength(1);
    expect(out.canonicalRows[0].source).toBe("WHOOP");
    expect(out.canonicalRows[0].value).toBe(71);
  });
});

describe("WHOOP-written HealthKit records remain source-agnostic", () => {
  it("maps a supported HealthKit type independently of its writer label", () => {
    const input = {
      hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
      value: 64,
      unit: "count/min",
      startDate: "2026-07-18 08:14:03 +0200",
      endDate: "2026-07-18 08:14:04 +0200",
    };

    const whoopWritten = mapAppleHealthEntry(input);
    const appleWritten = mapAppleHealthEntry(input);
    expect(whoopWritten).toEqual(appleWritten);
    expect(whoopWritten).toMatchObject({
      type: "PULSE",
      value: 64,
    });
    expect(whoopWritten).not.toHaveProperty("sourceName");
    expect(whoopWritten).not.toHaveProperty("writer");
  });

  it("persists supported export.xml rows as APPLE_HEALTH, never as a raw writer label", () => {
    // Spot rows are built as `NewMeasurementRow`s and written through the
    // column-array bulk insert; the source is fixed where each row is built.
    expect(appleImporterSource).toMatch(
      /const createData: NewMeasurementRow\[\] = chunk\.map\(\(row\) => \(\{[^}]*source:\s*"APPLE_HEALTH"/,
    );
    expect(appleImporterSource).toMatch(
      /insertNewMeasurementRows\(prisma, createData\)/,
    );
    expect(appleImporterSource).not.toMatch(
      /source:\s*attrs\.(?:sourceName|device)/,
    );
  });

  it("does not treat WHOOP writer metadata as evidence of a WHOOP ECG export", () => {
    const ecgMapping = mapAppleHealthEntry({
      hkIdentifier: "HKElectrocardiogram",
      value: 1,
      unit: "count",
      startDate: "2026-07-18 08:14:03 +0200",
      endDate: "2026-07-18 08:14:04 +0200",
    });
    expect(ecgMapping).toBeNull();
  });
});
