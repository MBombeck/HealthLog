import { describe, expect, it } from "vitest";

import type { DoctorReportData } from "@/lib/doctor-report-data";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import { cycleObservationsFromReportData } from "@/lib/fhir/resources";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";
import { LMP_LOINC } from "@/lib/fhir/loinc-map";

function baseData(overrides?: Partial<DoctorReportData>): DoctorReportData {
  return {
    period: {
      days: 90,
      since: "2026-02-02T00:00:00.000Z",
      start: "2026-02-02T00:00:00.000Z",
      end: "2026-05-03T12:00:00.000Z",
    },
    patient: {
      name: "sample-user",
      dateOfBirth: "1990-06-15T00:00:00.000Z",
      gender: "FEMALE",
      heightCm: 168,
    },
    practiceName: null,
    measurements: {},
    stats: {},
    glucoseStats: {},
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], {
      now: new Date("2026-05-03T12:00:00.000Z"),
    }),
    glucoseUnit: "mg/dL",
    bmi: null,
    compliance: {},
    medications: [],
    mood: null,
    glp1: null,
    ...overrides,
  };
}

const CYCLE_SUMMARY: NonNullable<DoctorReportData["cycle"]> = {
  lastPeriodStart: "2026-04-20",
  recentCycles: [
    { startDate: "2026-04-20", lengthDays: null, periodLengthDays: 5 },
    { startDate: "2026-03-23", lengthDays: 28, periodLengthDays: 5 },
    { startDate: "2026-02-24", lengthDays: 27, periodLengthDays: 4 },
  ],
  observedCycleCount: 3,
  averageCycleLengthDays: 27.5,
  cycleLengthVariabilityDays: 0.5,
  averagePeriodLengthDays: 5,
  currentPhase: "LUTEAL",
};

describe("fhir/cycle observations", () => {
  it("emits nothing when no cycle summary is present", () => {
    expect(cycleObservationsFromReportData(baseData())).toEqual([]);
  });

  it("emits LMP, cycle length, period length, and phase", () => {
    const obs = cycleObservationsFromReportData(
      baseData({ cycle: CYCLE_SUMMARY }),
    );
    const codes = obs.flatMap((o) =>
      (o.code.coding ?? []).map((c) => c.code).filter(Boolean),
    );
    // LMP is the only coded one. The averages are text-only: 64700-8 and
    // 64698-4, used before, are PhenX questionnaire items, not these values.
    expect(codes).toEqual([LMP_LOINC]);
    const cycleLength = obs.find(
      (o) => o.code.text === "Average menstrual cycle length",
    );
    const periodLength = obs.find(
      (o) => o.code.text === "Average period length",
    );
    expect(cycleLength?.code.coding).toBeUndefined();
    expect(periodLength?.code.coding).toBeUndefined();

    const lmp = obs.find((o) =>
      (o.code.coding ?? []).some((c) => c.code === LMP_LOINC),
    );
    expect(lmp?.valueDateTime).toBe("2026-04-20");

    const phase = obs.find(
      (o) => o.code.text === "Current menstrual cycle phase",
    );
    expect(phase?.valueString).toBe("Luteal phase");

    // Cycle observations carry their own id sequence, never `obs-N`.
    expect(obs.every((o) => o.id.startsWith("obs-cycle-"))).toBe(true);
  });

  it("adds a 'Menstrual cycle' Composition section to the document bundle", () => {
    const bundle = buildFhirDocumentBundle(baseData({ cycle: CYCLE_SUMMARY }), {
      insuranceNumber: null,
    });
    const composition = bundle.entry?.find(
      (e) => e.resource.resourceType === "Composition",
    )?.resource as { section?: Array<{ title: string }> } | undefined;
    const titles = composition?.section?.map((s) => s.title) ?? [];
    expect(titles).toContain("Menstrual cycle");
  });

  it("omits the cycle section entirely when the summary is null", () => {
    const bundle = buildFhirDocumentBundle(baseData({ cycle: null }), {
      insuranceNumber: null,
    });
    const composition = bundle.entry?.find(
      (e) => e.resource.resourceType === "Composition",
    )?.resource as { section?: Array<{ title: string }> } | undefined;
    const titles = composition?.section?.map((s) => s.title) ?? [];
    expect(titles).not.toContain("Menstrual cycle");
  });
});
