import { describe, it, expect } from "vitest";

import {
  adherenceRatePercent,
  buildLedgerCompliance,
  collapseMeasurementsToCanonical,
  normaliseDays,
  normaliseDateRange,
  resolveMaxMedicationAdministrations,
  sanitisePracticeName,
  type CanonicalCollapseRow,
  type DoctorReportComplianceMedication,
  type DoctorReportComplianceIntake,
} from "../doctor-report-data";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { userDayKey } from "@/lib/tz/resolver";
import {
  buildComplianceMedicationContext,
  tallyComplianceFromLedger,
} from "@/lib/analytics/compliance";
import {
  reconstructSleepNights,
  summarizeSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

describe("resolveMaxMedicationAdministrations", () => {
  it("defaults to 5000 when unset or non-numeric", () => {
    expect(resolveMaxMedicationAdministrations(undefined)).toBe(5000);
    expect(resolveMaxMedicationAdministrations("")).toBe(5000);
    expect(resolveMaxMedicationAdministrations("abc")).toBe(5000);
    expect(resolveMaxMedicationAdministrations("1000.5")).toBe(5000);
  });

  it("accepts a valid integer within [1, 50000]", () => {
    expect(resolveMaxMedicationAdministrations("1")).toBe(1);
    expect(resolveMaxMedicationAdministrations("1000")).toBe(1000);
    expect(resolveMaxMedicationAdministrations("50000")).toBe(50000);
  });

  it("falls back to 5000 for out-of-range values", () => {
    expect(resolveMaxMedicationAdministrations("0")).toBe(5000);
    expect(resolveMaxMedicationAdministrations("-1")).toBe(5000);
    expect(resolveMaxMedicationAdministrations("50001")).toBe(5000);
  });
});

describe("adherenceRatePercent", () => {
  it("rounds to an integer percent capped at 100, matching the app card", () => {
    // 87.3 → 87 (the divergence the export previously printed as 87.3).
    expect(adherenceRatePercent(157, 180)).toBe(87);
    // Exact half rounds up like the app's Math.round.
    expect(adherenceRatePercent(1, 2)).toBe(50);
    expect(adherenceRatePercent(5, 6)).toBe(83);
    // Full adherence is a clean 100.
    expect(adherenceRatePercent(10, 10)).toBe(100);
  });

  it("never exceeds 100 even when taken outruns the denominator", () => {
    expect(adherenceRatePercent(12, 10)).toBe(100);
  });

  it("returns null when there is no expected dose", () => {
    expect(adherenceRatePercent(0, 0)).toBeNull();
    expect(adherenceRatePercent(3, 0)).toBeNull();
    expect(adherenceRatePercent(1, -1)).toBeNull();
  });
});

describe("normaliseDays", () => {
  it("returns the value when it's a valid integer in [1, 365]", () => {
    expect(normaliseDays(1)).toBe(1);
    expect(normaliseDays(90)).toBe(90);
    expect(normaliseDays(365)).toBe(365);
  });

  it("falls back to 90 for invalid input", () => {
    expect(normaliseDays(undefined)).toBe(90);
    expect(normaliseDays(0)).toBe(90);
    expect(normaliseDays(-1)).toBe(90);
    expect(normaliseDays(366)).toBe(90);
    expect(normaliseDays(7.5)).toBe(90);
    expect(normaliseDays("90")).toBe(90);
    expect(normaliseDays(null)).toBe(90);
  });

  it("respects a custom fallback", () => {
    expect(normaliseDays(undefined, 30)).toBe(30);
  });
});

describe("normaliseDateRange", () => {
  const NOW = new Date("2026-05-09T12:00:00.000Z");

  it("uses the explicit range when both dates are valid and span <= 730 days", () => {
    const range = normaliseDateRange(
      {
        startDate: "2026-02-01T00:00:00.000Z",
        endDate: "2026-05-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    // 89-day span rounded up to the inclusive day-count.
    expect(range.days).toBe(89);
  });

  it("falls back to last-90-days when range is missing", () => {
    const range = normaliseDateRange({}, NOW);
    expect(range.days).toBe(90);
    expect(range.end.toISOString()).toBe(NOW.toISOString());
    const expectedStart = new Date(NOW);
    expectedStart.setDate(expectedStart.getDate() - 90);
    expect(range.start.toISOString()).toBe(expectedStart.toISOString());
  });

  it("falls back when endDate is before startDate", () => {
    const range = normaliseDateRange(
      {
        startDate: "2026-05-01T00:00:00.000Z",
        endDate: "2026-02-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.days).toBe(90);
  });

  it("falls back when range exceeds 730 days", () => {
    const range = normaliseDateRange(
      {
        startDate: "2023-01-01T00:00:00.000Z",
        endDate: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.days).toBe(90);
  });

  it("accepts the maximum 730-day window", () => {
    const range = normaliseDateRange(
      {
        startDate: "2024-05-09T00:00:00.000Z",
        endDate: "2026-05-09T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.days).toBeGreaterThan(700);
    expect(range.days).toBeLessThanOrEqual(730);
  });

  it("falls back when startDate is unparseable", () => {
    const range = normaliseDateRange(
      { startDate: "not-a-date", endDate: "2026-05-01T00:00:00.000Z" },
      NOW,
    );
    expect(range.days).toBe(90);
  });

  it("uses the legacy days fallback when only days is provided", () => {
    const range = normaliseDateRange({ days: 30 }, NOW);
    expect(range.days).toBe(30);
    expect(range.end.toISOString()).toBe(NOW.toISOString());
  });

  it("equal start+end produces a 1-day window (not zero)", () => {
    const range = normaliseDateRange(
      {
        startDate: "2026-05-09T00:00:00.000Z",
        endDate: "2026-05-09T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.days).toBe(1);
  });

  it("ignores non-object input", () => {
    const range = normaliseDateRange("not-an-object", NOW);
    expect(range.days).toBe(90);
  });
});

describe("sanitisePracticeName", () => {
  it("returns null for non-string input", () => {
    expect(sanitisePracticeName(undefined)).toBe(null);
    expect(sanitisePracticeName(null)).toBe(null);
    expect(sanitisePracticeName(42)).toBe(null);
    expect(sanitisePracticeName({})).toBe(null);
  });

  it("returns null for whitespace-only or empty strings", () => {
    expect(sanitisePracticeName("")).toBe(null);
    expect(sanitisePracticeName("   ")).toBe(null);
    expect(sanitisePracticeName("\t\n  ")).toBe(null);
  });

  it("trims and collapses whitespace", () => {
    expect(sanitisePracticeName("  Dr.   Smith  ")).toBe("Dr. Smith");
    expect(sanitisePracticeName("Praxis\tDr.\nMüller")).toBe(
      "Praxis Dr. Müller",
    );
  });

  it("strips ASCII control characters", () => {
    expect(sanitisePracticeName("Dr.\u0007Smith")).toBe("Dr. Smith");
    expect(sanitisePracticeName("\u0000Dr. Smith\u007f")).toBe("Dr. Smith");
  });

  it("caps at 120 characters", () => {
    const long = "X".repeat(200);
    const out = sanitisePracticeName(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(120);
  });

  it("preserves a normal practice name unchanged", () => {
    expect(sanitisePracticeName("Hausarztpraxis Dr. Müller")).toBe(
      "Hausarztpraxis Dr. Müller",
    );
  });
});

describe("doctor-report SLEEP_DURATION parity (07-M1)", () => {
  // The doctor report used to aggregate SLEEP_DURATION over RAW per-stage
  // rows (a 240-min CORE block, a 90-min DEEP block, …), so its min/avg/max
  // read per-STAGE minutes — a different number than every other sleep surface,
  // which shows the per-NIGHT reconstructed total via `summarizeSleepNights`.
  // The report now routes through `reconstructSleepNights` (the same engine).
  // This pins that parity and the divergence from the old raw aggregate.
  function stageRow(
    iso: string,
    stage: string,
    minutes: number,
  ): SleepStageRow {
    return {
      measuredAt: new Date(iso),
      sleepStage: stage as SleepStageRow["sleepStage"],
      value: minutes,
    };
  }

  it("collapses raw per-stage rows to one per-night asleep total, matching the canonical surface", () => {
    const tz = "UTC";
    // One night, five per-stage rows. Asleep = CORE+DEEP+REM = 240+90+80 = 410.
    const rows: SleepStageRow[] = [
      stageRow("2026-06-04T00:00:00.000Z", "IN_BED", 480),
      stageRow("2026-06-04T00:30:00.000Z", "CORE", 240),
      stageRow("2026-06-04T02:00:00.000Z", "DEEP", 90),
      stageRow("2026-06-04T04:00:00.000Z", "REM", 80),
      stageRow("2026-06-04T05:00:00.000Z", "AWAKE", 20),
    ];

    // The doctor-report path: reconstruct nights, drop zero-asleep, take the
    // per-night asleep total as the SLEEP_DURATION value (mirrors the builder).
    const nights = reconstructSleepNights(rows, tz, null).filter(
      (n) => n.asleepMinutes > 0,
    );
    const reportValues = nights.map((n) => n.asleepMinutes);

    // Canonical surface (dashboard slim slice + iOS feed) over the same rows.
    const { summary } = summarizeSleepNights(rows, tz, null);

    // One night → one value, and it is the per-night asleep total, not a
    // per-stage figure.
    expect(reportValues).toEqual([410]);
    expect(summary.count).toBe(1);
    expect(summary.mean).toBe(410);
    expect(summary.max).toBe(410);

    // The OLD raw-row aggregate blended every stage row: max would be the
    // 480-min IN_BED block, min the 20-min AWAKE block — neither is a night.
    const rawValues = rows.map((r) => r.value);
    expect(Math.max(...rawValues)).toBe(480);
    expect(Math.min(...rawValues)).toBe(20);
    // Parity assertion: the report no longer reports those per-stage extremes.
    expect(Math.max(...reportValues)).not.toBe(Math.max(...rawValues));
  });
});

describe("buildLedgerCompliance — doctor-report adherence via the dose ledger", () => {
  const TZ = "Europe/Berlin";
  const NOW = new Date("2026-05-20T12:00:00.000Z");
  const START = new Date("2026-05-10T00:00:00.000Z");
  const END = NOW;

  function dailySchedule() {
    return {
      id: "sched-1",
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["08:00"],
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
      scheduleType: null,
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
    };
  }

  /**
   * v1.17 — the raw-row tally double-counted cross-source duplicate
   * rows (a REMINDER + an API row for the same slot both counted as taken)
   * and counted every row toward the denominator. The ledger dedups onto
   * one slot. This pins that the doctor report now matches the detail page:
   * the ledger result, not the inflated raw count.
   */
  it("keeps two medications that share a name apart", () => {
    // An ended course and a new one, or two strengths, often carry the same
    // name. Keyed by name, the second overwrote the first in the report.
    const base: DoctorReportComplianceMedication = {
      id: "med-a",
      name: "Metformin",
      asNeeded: false,
      trackIntake: true,
      startsOn: null,
      endsOn: null,
      endedAt: null,
      oneShot: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      schedules: [dailySchedule()],
      scheduleRevisions: [],
    };
    const other = { ...base, id: "med-b" };
    const slot = new Date("2026-05-12T08:00:00.000Z");
    const out = buildLedgerCompliance(
      [base, other],
      [
        {
          medicationId: "med-a",
          scheduledFor: slot,
          takenAt: slot,
          skipped: false,
        },
      ],
      TZ,
      START,
      END,
      NOW,
    );
    expect(Object.keys(out).sort()).toEqual(["med-a", "med-b"]);
    expect(out["med-a"].name).toBe("Metformin");
    expect(out["med-b"].name).toBe("Metformin");
    expect(out["med-a"].taken).toBe(1);
    expect(out["med-b"].taken).toBe(0);
  });

  it("dedups cross-source duplicate intake rows onto one slot", () => {
    const med: DoctorReportComplianceMedication = {
      id: "med-1",
      name: "Ramipril",
      asNeeded: false,
      trackIntake: true,
      startsOn: null,
      endsOn: null,
      endedAt: null,
      oneShot: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      schedules: [dailySchedule()],
      scheduleRevisions: [],
    };
    // Day 1: TWO taken rows for the same 08:00 slot (REMINDER + API).
    const slot1 = new Date("2026-05-12T08:00:00.000Z");
    // Day 2: one missed slot (auto-missed).
    const slot2 = new Date("2026-05-13T08:00:00.000Z");
    const intakeEvents: DoctorReportComplianceIntake[] = [
      {
        medicationId: "med-1",
        scheduledFor: slot1,
        takenAt: slot1,
        skipped: false,
      },
      {
        medicationId: "med-1",
        scheduledFor: slot1,
        takenAt: new Date(slot1.getTime() + 60_000),
        skipped: false,
      },
      {
        medicationId: "med-1",
        scheduledFor: slot2,
        takenAt: null,
        skipped: false,
        autoMissed: true,
      },
    ];

    const out = buildLedgerCompliance([med], intakeEvents, TZ, START, END, NOW);

    // The ledger authority over the same window.
    const ctx = buildComplianceMedicationContext(med, slot1, TZ);
    const authority = tallyComplianceFromLedger(
      intakeEvents,
      med.schedules,
      ctx,
      START,
      END,
      NOW,
    );

    expect(out["med-1"]).toBeDefined();
    // total = taken + missed (ledger denominator), so taken/total === rate —
    // the exact number the detail page shows.
    expect(out["med-1"].total).toBe(authority.denominator);
    expect(out["med-1"].taken).toBe(authority.taken);
    expect(out["med-1"].missed).toBe(authority.missed);

    // The OLD raw-row tally: taken = takenAt!=null per row, denominator =
    // every row. The duplicate slot inflates `taken` to 2 and the
    // denominator to 3 (66.7 %). The ledger dedups the slot → taken = 1, so
    // the doctor report no longer double-counts the cross-source duplicate.
    let rawTaken = 0;
    let rawTotal = 0;
    for (const e of intakeEvents) {
      rawTotal += 1;
      if (e.takenAt) rawTaken += 1;
    }
    expect(rawTaken).toBe(2); // the old code's inflated taken count
    expect(rawTotal).toBe(3); // the old code's raw-row denominator
    expect(out["med-1"].taken).toBe(1); // the ledger's deduped take
    expect(out["med-1"].taken).not.toBe(rawTaken);
  });

  it("excludes PRN / as-needed medications entirely", () => {
    const prn: DoctorReportComplianceMedication = {
      id: "med-prn",
      name: "Ibuprofen",
      asNeeded: true,
      trackIntake: true,
      startsOn: null,
      endsOn: null,
      endedAt: null,
      oneShot: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      schedules: [dailySchedule()],
      scheduleRevisions: [],
    };
    const out = buildLedgerCompliance(
      [prn],
      [
        {
          medicationId: "med-prn",
          scheduledFor: new Date("2026-05-12T08:00:00.000Z"),
          takenAt: new Date("2026-05-12T08:00:00.000Z"),
          skipped: false,
        },
      ],
      TZ,
      START,
      END,
      NOW,
    );
    expect(out.Ibuprofen).toBeUndefined();
  });

  it("excludes a medication with intake tracking off, schedule and all (#1033)", () => {
    const recordOnly: DoctorReportComplianceMedication = {
      id: "med-record",
      name: "Atorvastatin",
      asNeeded: false,
      trackIntake: false,
      startsOn: null,
      endsOn: null,
      endedAt: null,
      oneShot: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      // The schedule stays on record; it must not produce a rate.
      schedules: [dailySchedule()],
      scheduleRevisions: [],
    };
    const out = buildLedgerCompliance([recordOnly], [], TZ, START, END, NOW);
    expect(out.Atorvastatin).toBeUndefined();
  });
});

describe("collapseMeasurementsToCanonical (doctor-report ↔ dashboard parity)", () => {
  const TZ = "Europe/Berlin";

  function r(
    type: string,
    value: number,
    iso: string,
    source: string,
  ): CanonicalCollapseRow {
    return {
      type,
      value,
      measuredAt: new Date(iso),
      source: source as never,
      deviceType: null,
    };
  }

  function statsOf(rows: { value: number }[]) {
    const values = rows.map((x) => x.value);
    return {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    };
  }

  it("collapses a multi-source day to the canonical source so the PDF stat matches the dashboard", () => {
    // One Berlin day, RESTING_HEART_RATE from two overlapping sources. The
    // dashboard collapses to the ladder-canonical source (WHOOP ≻ APPLE_HEALTH
    // for `restingHeartRate`); the doctor report must do the same, not blend.
    const rows = [
      r("RESTING_HEART_RATE", 48, "2026-06-01T06:00:00Z", "WHOOP"),
      r("RESTING_HEART_RATE", 60, "2026-06-01T06:05:00Z", "APPLE_HEALTH"),
    ];

    const collapsed = collapseMeasurementsToCanonical(rows, TZ, null).filter(
      (m) => m.type === "RESTING_HEART_RATE",
    );

    // Dashboard reference: the SAME picker the analytics/insights aggregator
    // uses, with the same ladder + day key.
    const dashboard = pickCanonicalSourceRows(
      rows.map((m) => ({ ...m, type: m.type as never })),
      "restingHeartRate",
      null,
      (d) => userDayKey(d, TZ),
    ).canonicalRows;

    // Canonical-source collapse keeps only the WHOOP reading (48), never blends.
    expect(collapsed.map((m) => m.value)).toEqual([48]);
    // Parity: doctor-report stat == dashboard collapse stat.
    expect(statsOf(collapsed)).toEqual(statsOf(dashboard));
    // And it differs from the naive all-source blend (avg 54) that the PDF
    // produced before the fix.
    expect(statsOf(rows).avg).toBe(54);
    expect(statsOf(collapsed).avg).toBe(48);
  });

  it("passes through a type with no source ladder unchanged", () => {
    const rows = [
      r("BLOOD_PRESSURE_SYS", 120, "2026-06-01T08:00:00Z", "MANUAL"),
      r("BLOOD_PRESSURE_SYS", 130, "2026-06-02T08:00:00Z", "MANUAL"),
    ];
    const collapsed = collapseMeasurementsToCanonical(rows, TZ, null);
    expect(collapsed.map((m) => m.value).sort()).toEqual([120, 130]);
  });

  it("leaves SLEEP_DURATION rows untouched for the night reconstruction downstream", () => {
    const rows = [
      r("SLEEP_DURATION", 40, "2026-06-01T01:00:00Z", "WHOOP"),
      r("SLEEP_DURATION", 30, "2026-06-01T02:00:00Z", "APPLE_HEALTH"),
    ];
    const collapsed = collapseMeasurementsToCanonical(rows, TZ, null);
    // Both per-stage rows survive — sleep is collapsed per-night downstream.
    expect(collapsed).toHaveLength(2);
  });
});
