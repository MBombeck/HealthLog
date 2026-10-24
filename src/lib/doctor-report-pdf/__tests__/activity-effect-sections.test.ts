/**
 * The v1.44 report blocks in the rendered PDF: sleep, both heart-rate
 * variability statistics under their own labels, steps, the per-sport workout
 * block and the medication effect, plus the per-sport fold behind the workout
 * block. Text is read back out of the real PDF bytes.
 */
import { describe, expect, it } from "vitest";

import { readPdfText } from "@/lib/documents/pdfjs";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { summariseReportWorkouts } from "@/lib/doctor-report/workouts";
import type { EfficacySegmented } from "@/lib/medications/efficacy/segmented-effect";

const NOW = new Date("2026-05-03T12:00:00.000Z");

function textOf(bytes: Uint8Array): Promise<string> {
  return readPdfText(bytes);
}

function series(values: number[]) {
  return values.map((value, i) => ({
    value,
    measuredAt: new Date(
      Date.parse("2026-03-01T06:00:00.000Z") + i * 86_400_000,
    ).toISOString(),
  }));
}

function stat(values: number[]) {
  return {
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    count: values.length,
    latest: values[values.length - 1],
  };
}

const EFFECT: EfficacySegmented = {
  present: true,
  level: 0.95,
  window: { from: "2025-12-02", to: "2026-04-10", endReason: "dose_change" },
  days: {
    before: 84,
    after: 61,
    excludedLowAdherence: 5,
    excludedNotTaking: 0,
  },
  adherence: { status: "tracked", floorPct: 80, lookbackDays: 14 },
  levelChange: {
    estimate: -7.34,
    ciLow: -8.52,
    ciHigh: -6.15,
    standardError: 0.6,
    includesZero: false,
  },
  slopeChangePerWeek: {
    estimate: -0.26,
    ciLow: -0.58,
    ciHigh: 0.07,
    standardError: 0.16,
    includesZero: true,
  },
  preSlopePerWeek: {
    estimate: 0.1,
    ciLow: -0.1,
    ciHigh: 0.3,
    standardError: 0.1,
    includesZero: true,
  },
  fit: {
    n: 145,
    df: 141,
    rSquared: 0.55,
    residualAutocorrelation: 0.31,
    hacLag: 7,
    autocorrelationCaveat: false,
  },
  confounders: [
    { medicationName: "Other drug", event: "started", date: "2026-02-14" },
  ],
};

function data(overrides: Partial<DoctorReportData> = {}): DoctorReportData {
  const sleep = [400, 430, 455, 470, 410];
  const sdnn = [42.5, 45.25, 40.125, 47];
  const rmssd = [31, 35.5, 29, 33];
  const steps = [8000, 9500, 7200, 10100];
  return {
    period: {
      days: 90,
      since: "2026-02-02T00:00:00.000Z",
      start: "2026-02-02T00:00:00.000Z",
      end: "2026-05-03T12:00:00.000Z",
    },
    patient: {
      username: null,
      dateOfBirth: null,
      gender: null,
      heightCm: null,
    },
    practiceName: null,
    measurements: {
      SLEEP_DURATION: series(sleep),
      HEART_RATE_VARIABILITY: series(sdnn),
      HRV_RMSSD: series(rmssd),
      ACTIVITY_STEPS: series(steps),
    },
    stats: {
      SLEEP_DURATION: stat(sleep),
      HEART_RATE_VARIABILITY: stat(sdnn),
      HRV_RMSSD: stat(rmssd),
      ACTIVITY_STEPS: stat(steps),
    },
    glucoseStats: {},
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], { now: NOW }),
    glucoseUnit: "mg/dL",
    bmi: null,
    compliance: {},
    medications: [],
    mood: null,
    workouts: {
      sessions: 9,
      totalDurationSec: 9 * 3600,
      sessionsPerWeek: 0.7,
      minutesPerWeek: 42,
      sportCount: 2,
      bySport: [
        {
          sportType: "running",
          sessions: 6,
          durationSec: 6 * 3600,
          distanceM: 54_300,
          distanceSessions: 6,
          energyKcal: 3900,
          avgHeartRate: 148.5,
        },
        {
          sportType: "yoga",
          sessions: 3,
          durationSec: 3 * 3600,
          distanceM: null,
          distanceSessions: 0,
          energyKcal: null,
          avgHeartRate: null,
        },
      ],
    },
    medicationEffects: [
      {
        medicationName: "Example ACE inhibitor",
        startsOn: "2026-03-02",
        targets: [{ type: "BLOOD_PRESSURE_SYS", effect: EFFECT }],
      },
    ],
    ...overrides,
  } as DoctorReportData;
}

function render(d: DoctorReportData) {
  return renderDoctorReportPdfBytes(d, {
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    t: getServerTranslator("en").t,
    locale: "en",
    now: NOW,
  });
}

describe("doctor report v1.44 sections", () => {
  it("labels SDNN and RMSSD as separate rows and keeps recorded precision", async () => {
    const text = await textOf(render(data()));
    expect(text).toContain("HRV (SDNN)");
    expect(text).toContain("HRV (RMSSD)");
    // #1228: the row keeps the digits the readings carry, up to three
    // significant ones (40.125 ms reads 40.1, never 40).
    expect(text).toContain("40.1");
    expect(text).not.toMatch(/\b40 ms/);
    expect(text).toContain("Sleep");
    expect(text).toContain("Steps");
  });

  it("charts the wearable series at half width in the report's units", async () => {
    const text = await textOf(render(data()));
    // The sleep chart's max label is in hours (470 min = 7.8 h), never minutes.
    expect(text).toContain("7.8 h");
    expect(text).not.toContain("470.0 h");
  });

  it("prints the workout block per sport with weekly figures", async () => {
    const text = await textOf(render(data()));
    expect(text).toContain("Workouts");
    expect(text).toContain("9 sessions, 9.0 h in total");
    expect(text).toContain("0.7 sessions and 42 minutes per week");
    expect(text).toContain("Running");
    expect(text).toContain("54.3 km");
    expect(text).toContain("149 bpm");
    expect(text).toContain("Yoga");
  });

  it("prints the medication effect with intervals, exclusions and confounders", async () => {
    // Notes wrap at the page edge; read them as one run of words.
    const text = (await textOf(render(data()))).replace(/\s+/g, " ");
    expect(text).toContain("Change around each medication start");
    expect(text).toContain("Example ACE inhibitor");
    expect(text).toContain("-7.3 mmHg");
    expect(text).toContain("(-8.5 to -6.2)");
    expect(text).toContain("-0.3 mmHg/week");
    expect(text).toContain("84 / 61");
    expect(text).toContain("5 days after the start left out");
    // The fitted window (Dec to Apr) reaches outside the Feb to May report
    // period; the report says which days the figures rest on.
    expect(text).toMatch(
      /analysed \S+ to \S+, which can reach beyond the report period/,
    );
    expect(text).toContain("Other drug started on");
    expect(text).toContain("not a proven effect");
    expect(text).not.toContain("carry-over");
  });

  it("notes strong day-to-day carry-over in the effect notes", async () => {
    const text = (
      await textOf(
        render(
          data({
            medicationEffects: [
              {
                medicationName: "Example ACE inhibitor",
                startsOn: "2026-03-02",
                targets: [
                  {
                    type: "BLOOD_PRESSURE_SYS",
                    effect: {
                      ...EFFECT,
                      fit: { ...EFFECT.fit!, autocorrelationCaveat: true },
                    },
                  },
                ],
              },
            ],
          }),
        ),
      )
    ).replace(/\s+/g, " ");
    expect(text).toContain("strong day-to-day carry-over");
  });

  it("names the missing floor instead of printing numbers", async () => {
    const text = await textOf(
      render(
        data({
          medicationEffects: [
            {
              medicationName: "Example ACE inhibitor",
              startsOn: null,
              targets: [
                {
                  type: "BLOOD_PRESSURE_SYS",
                  effect: {
                    ...EFFECT,
                    present: false,
                    reason: "no_start",
                    levelChange: null,
                    slopeChangePerWeek: null,
                    preSlopePerWeek: null,
                    fit: null,
                  },
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(text).toContain("No start date recorded");
    expect(text).not.toContain("-7.3 mmHg");
  });

  it("omits both blocks when the aggregator handed none over", async () => {
    const text = await textOf(
      render(data({ workouts: null, medicationEffects: null })),
    );
    expect(text).not.toContain("Workouts");
    expect(text).not.toContain("Change around each medication start");
  });
});

describe("summariseReportWorkouts", () => {
  it("sums per sport, longest total first, and averages over the window's weeks", () => {
    const w = summariseReportWorkouts(
      [
        {
          sportType: "running",
          durationSec: 1800,
          totalDistanceM: 5000,
          totalEnergyKcal: 300,
          avgHeartRate: 150,
        },
        {
          sportType: "running",
          durationSec: 2400,
          totalDistanceM: null,
          totalEnergyKcal: 400,
          avgHeartRate: 140,
        },
        {
          sportType: "cycling",
          durationSec: 7200,
          totalDistanceM: 40_000,
          totalEnergyKcal: null,
          avgHeartRate: null,
        },
      ],
      14,
    )!;
    expect(w.sessions).toBe(3);
    expect(w.totalDurationSec).toBe(11_400);
    expect(w.sessionsPerWeek).toBe(1.5);
    expect(w.minutesPerWeek).toBe(95);
    expect(w.bySport.map((s) => s.sportType)).toEqual(["cycling", "running"]);
    const running = w.bySport[1];
    expect(running).toEqual({
      sportType: "running",
      sessions: 2,
      durationSec: 4200,
      distanceM: 5000,
      distanceSessions: 1,
      energyKcal: 700,
      avgHeartRate: 145,
    });
    expect(w.bySport[0].avgHeartRate).toBeNull();
  });

  it("returns null without sessions", () => {
    expect(summariseReportWorkouts([], 30)).toBeNull();
  });
});
