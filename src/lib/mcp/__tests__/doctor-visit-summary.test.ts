/**
 * The doctor-visit summariser, and what it says when there is nothing to say.
 *
 * The MCP surfaces cannot ask a human, so they replay the owner's saved report
 * selection. An account that never saved one resolves to the empty selection
 * and the aggregator returns an empty payload — which has to read as "nothing
 * was recorded for this", not as a record whose every section happens to be
 * missing. The `{ present: false, reason }` sentinel is the same one the other
 * MCP reads use.
 *
 * Mutation checks:
 *   - make `present` unconditionally `true` again → "reports absence for an
 *     empty scope" goes red.
 *   - drop `data.bmi !== null` from the `hasContent` test → "counts a lone BMI
 *     figure as content" goes red.
 */
import { describe, it, expect } from "vitest";

import { summariseForVisit } from "../doctor-visit-summary";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DoctorReportData } from "@/lib/doctor-report-data";

function payload(overrides: Partial<DoctorReportData> = {}): DoctorReportData {
  return {
    period: {
      days: 90,
      since: "2026-01-01",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-04-01T00:00:00.000Z",
    },
    patient: {
      name: null,
      dateOfBirth: null,
      gender: null,
      heightCm: null,
    },
    practiceName: null,
    measurements: {},
    stats: {},
    glucoseStats: {},
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], {
      now: new Date("2026-04-01T00:00:00.000Z"),
    }),
    glucoseUnit: "mg/dL",
    bmi: null,
    compliance: {},
    medications: [],
    wellnessScores: null,
    ...overrides,
  } as DoctorReportData;
}

describe("summariseForVisit", () => {
  it("reports absence for an empty scope, with the period it looked at", () => {
    const summary = summariseForVisit(payload());
    expect(summary.present).toBe(false);
    expect(summary.reason).toBe("empty_report_selection");
    expect(summary.period).toEqual({
      days: 90,
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-04-01T00:00:00.000Z",
    });
    // Nothing is zero-filled in its place.
    expect(summary).not.toHaveProperty("vitals");
    expect(summary).not.toHaveProperty("medications");
  });

  it("reports presence as soon as one metric survives the gate", () => {
    const summary = summariseForVisit(
      payload({
        stats: { WEIGHT: { avg: 80, min: 78, max: 82, count: 4, latest: 79 } },
      }),
    );
    expect(summary.present).toBe(true);
    expect(summary.vitals).toHaveLength(1);
  });

  it("counts a lone BMI figure as content", () => {
    // The BMI figure can be the only thing chosen — the weight series stays
    // withheld — and a summary carrying it is not an empty one.
    const summary = summariseForVisit(payload({ bmi: 24.5 }));
    expect(summary.present).toBe(true);
    expect(summary.bmi).toBe(24.5);
  });
});
