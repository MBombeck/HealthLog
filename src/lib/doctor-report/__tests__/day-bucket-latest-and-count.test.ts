/**
 * A type served from day buckets (pulse or glucose on a long window, or a
 * dense stream on any window) is drawn one point per day, and each point is
 * that day's mean stamped at the day's start. Two readers used to treat those
 * points as readings: the report's summary line counted them as measurements,
 * and the FHIR export stamped the last day's mean as the latest observation.
 * Both now read the stats, which describe the readings themselves.
 */
import { describe, expect, it } from "vitest";

import type { DoctorReportData } from "@/lib/doctor-report-data";
import { buildClinicalSummaryLines } from "@/lib/doctor-report-pdf/clinical-summary";
import { latestReading } from "@/lib/fhir/resources/common";
import type { DenseMeasurementBucket } from "../dense-buckets";
import { summariseDenseBuckets } from "../measurement-series";

function bucket(
  day: string,
  count: number,
  sum: number,
  latestAt: string,
  latestValue: number,
): DenseMeasurementBucket {
  return {
    bucketStart: new Date(`${day}T00:00:00.000Z`),
    type: "PULSE",
    source: "GOOGLE_HEALTH",
    deviceType: null,
    glucoseContext: null,
    count,
    sumValue: sum,
    minValue: 50,
    maxValue: 120,
    latestAt: new Date(latestAt),
    latestValue,
    clinicalCount: count,
    clinicalSum: sum,
    clinicalSumSquares: null,
    clinicalFirstAt: null,
    clinicalLastAt: null,
    clinicalTirCount: 0,
    clinicalTbr1Count: 0,
    clinicalTbr2Count: 0,
    clinicalTar1Count: 0,
    clinicalTar2Count: 0,
    clinicalLowRiskSum: null,
    clinicalHighRiskSum: null,
    hourMeanSum: null,
    hourCount: null,
  };
}

/** Two days of one reading a minute; the newest reading is 61 bpm at 23:59. */
const summary = summariseDenseBuckets(
  [
    bucket("2026-09-01", 1440, 1440 * 70, "2026-09-01T23:59:00.000Z", 66),
    bucket("2026-09-02", 1440, 1440 * 75, "2026-09-02T23:59:00.000Z", 61),
  ],
  "UTC",
  null,
  120,
);

function reportData(): DoctorReportData {
  return {
    measurements: summary.byType,
    stats: summary.stats,
  } as unknown as DoctorReportData;
}

describe("a pulse series served from day buckets", () => {
  it("is drawn as day means", () => {
    expect(summary.byType.PULSE).toEqual([
      { value: 70, measuredAt: "2026-09-01T00:00:00.000Z" },
      { value: 75, measuredAt: "2026-09-02T00:00:00.000Z" },
    ]);
  });

  it("reports its newest actual reading to FHIR, not the last day's mean", () => {
    expect(latestReading(reportData(), "PULSE")).toEqual({
      value: 61,
      measuredAt: "2026-09-02T23:59:00.000Z",
    });
  });

  it("counts its readings in the summary line, not its points", () => {
    const counts: unknown[] = [];
    const lines = buildClinicalSummaryLines(
      {
        ...reportData(),
        period: { days: 120 },
        compliance: {},
      } as unknown as DoctorReportData,
      (key, vars) => {
        if (key === "doctorReport.summaryReadings") counts.push(vars?.count);
        return key;
      },
      (n) => String(n),
    );
    expect(lines).toContain("doctorReport.summaryReadings");
    expect(counts).toEqual([2880]);
  });
});

describe("a raw series", () => {
  it("still reports its last point as the latest reading", () => {
    const data = {
      measurements: {
        WEIGHT: [
          { value: 80, measuredAt: "2026-09-01T07:00:00.000Z" },
          { value: 79.5, measuredAt: "2026-09-02T07:00:00.000Z" },
        ],
      },
      stats: {
        WEIGHT: { avg: 79.75, min: 79.5, max: 80, count: 2, latest: 79.5 },
      },
    } as unknown as DoctorReportData;
    expect(latestReading(data, "WEIGHT")).toEqual({
      value: 79.5,
      measuredAt: "2026-09-02T07:00:00.000Z",
    });
  });
});
