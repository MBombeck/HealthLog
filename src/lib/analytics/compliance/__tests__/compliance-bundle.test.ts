/**
 * v1.15.20 — single-pass compliance bundle parity.
 *
 * `buildMedicationComplianceBundle` replaces the per-medication compliance
 * route's five-plus expansion passes (calculateCompliance × 4, the window
 * ladder probes, the heatmap mint) with ONE band expansion + ONE cadence
 * timeline. These tests pin the bundle's blocks against the historical
 * per-window composition so the refactor cannot drift the public payload:
 * every block must be deep-equal to what `calculateCompliance` /
 * `buildComplianceDisplay` produce for the same fixture.
 */
import { describe, it, expect } from "vitest";

import {
  buildComplianceMedicationContext,
  buildComplianceLedgerRows,
  buildMedicationComplianceBundle,
  buildComplianceDisplay,
  calculateCompliance,
  dailyComplianceRatesFromLedger,
  lastNonSkippedTakenAt,
  tallyComplianceFromLedger,
  tallyLedgerRows,
  type ComplianceSchedule,
} from "@/lib/analytics/compliance";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

const TZ = "UTC";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic anchor — keeps every window fully in the fixture's hands. */
const NOW = new Date("2026-06-01T12:00:00Z");

function dailySchedule(): ComplianceSchedule {
  return {
    windowStart: "08:00",
    windowEnd: "09:00",
    timesOfDay: ["08:00"],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };
}

function weeklyMondaySchedule(): ComplianceSchedule {
  return {
    windowStart: "08:00",
    windowEnd: "09:00",
    timesOfDay: ["08:00"],
    daysOfWeek: null,
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };
}

function rollingSchedule(intervalDays: number): ComplianceSchedule {
  return {
    windowStart: "10:00",
    windowEnd: "11:00",
    timesOfDay: ["10:00"],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: intervalDays,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };
}

/** A slot instant `daysAgo` before NOW at the given "HH:mm" (UTC fixture). */
function slotAt(daysAgo: number, hhmm: string): Date {
  const day = new Date(NOW.getTime() - daysAgo * DAY_MS);
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

interface FixtureEvent {
  takenAt: Date | null;
  skipped: boolean;
  scheduledFor: Date;
  autoMissed?: boolean;
}

function dailyFixtureEvents(): FixtureEvent[] {
  return [
    // Taken on time across several days.
    {
      takenAt: slotAt(1, "08:05"),
      skipped: false,
      scheduledFor: slotAt(1, "08:00"),
    },
    {
      takenAt: slotAt(2, "08:10"),
      skipped: false,
      scheduledFor: slotAt(2, "08:00"),
    },
    {
      takenAt: slotAt(4, "07:55"),
      skipped: false,
      scheduledFor: slotAt(4, "08:00"),
    },
    // A deliberate skip (excluded from the denominator).
    { takenAt: null, skipped: true, scheduledFor: slotAt(3, "08:00") },
    // A taken-late dose (inside the late tail).
    {
      takenAt: slotAt(5, "10:30"),
      skipped: false,
      scheduledFor: slotAt(5, "08:00"),
    },
    // Day 6 has no event → the unfilled slot reads missed.
    // An auto-missed forgotten dose.
    {
      takenAt: null,
      skipped: false,
      scheduledFor: slotAt(8, "08:00"),
      autoMissed: true,
    },
  ];
}

describe("buildMedicationComplianceBundle — parity with the per-window composition", () => {
  it("daily medication: every block equals the legacy multi-pass output", () => {
    const createdAt = new Date(NOW.getTime() - 40 * DAY_MS);
    const schedules = [dailySchedule()];
    const events = dailyFixtureEvents();
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      lastNonSkippedTakenAt(events),
      TZ,
    );

    const bundle = buildMedicationComplianceBundle(events, schedules, ctx, NOW);

    expect(bundle.compliance7).toEqual(
      calculateCompliance(events, schedules, 7, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.compliance30).toEqual(
      calculateCompliance(events, schedules, 30, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.complianceDisplay).toEqual(
      buildComplianceDisplay(events, schedules, ctx, { now: NOW }),
    );

    // The ledger mints over the whole 365-day period (#1028); the slots
    // before the creation hold no recorded dose, so none of them survive:
    // one band per daily slot over the 40-day life → 40 or 41 slot rows
    // (the boundary day depends on the creation instant vs slot time).
    expect(bundle.ledgerFrom).toEqual(new Date(NOW.getTime() - 365 * DAY_MS));
    expect(
      bundle.ledgerRows.some((r) => r.at.getTime() < createdAt.getTime()),
    ).toBe(false);
    const slotRows = bundle.ledgerRows.filter((r) => r.kind === "slot");
    expect(slotRows.length).toBeGreaterThanOrEqual(39);
    expect(slotRows.length).toBeLessThanOrEqual(41);
  });

  it("rolling 35-day medication: display windows + rates match the legacy path", () => {
    const createdAt = new Date(NOW.getTime() - 400 * DAY_MS);
    const schedules = [rollingSchedule(35)];
    const events: FixtureEvent[] = [
      {
        takenAt: new Date(NOW.getTime() - 25 * DAY_MS),
        skipped: false,
        scheduledFor: new Date(NOW.getTime() - 25 * DAY_MS),
      },
      {
        takenAt: new Date(NOW.getTime() - 60 * DAY_MS),
        skipped: false,
        scheduledFor: new Date(NOW.getTime() - 60 * DAY_MS),
      },
    ];
    const ctx = buildComplianceMedicationContext(
      {
        startsOn: new Date(NOW.getTime() - 380 * DAY_MS),
        endsOn: null,
        oneShot: false,
        createdAt,
      },
      lastNonSkippedTakenAt(events),
      TZ,
    );

    const bundle = buildMedicationComplianceBundle(events, schedules, ctx, NOW);

    expect(bundle.compliance7).toEqual(
      calculateCompliance(events, schedules, 7, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.compliance30).toEqual(
      calculateCompliance(events, schedules, 30, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.complianceDisplay).toEqual(
      buildComplianceDisplay(events, schedules, ctx, { now: NOW }),
    );
    // A 35-day cadence cannot clear the stability floor on [7, 30].
    expect(bundle.complianceDisplay.shortDays).toBeGreaterThan(7);
    expect(bundle.complianceDisplay.longDays).toBeGreaterThan(30);
  });

  it("empty schedule list: zeros short-circuit matches calculateCompliance", () => {
    const createdAt = new Date(NOW.getTime() - 10 * DAY_MS);
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      null,
      TZ,
    );

    const bundle = buildMedicationComplianceBundle([], [], ctx, NOW);

    expect(bundle.compliance7).toEqual(
      calculateCompliance([], [], 7, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.complianceDisplay).toEqual(
      buildComplianceDisplay([], [], ctx, { now: NOW }),
    );
    expect(bundle.ledgerRows).toEqual([]);
  });
});

describe("dailyComplianceRatesFromLedger — cadence-aware per-day series", () => {
  it("weekly Monday-only med: per-day series agrees with compliance30 and never marks non-due days", () => {
    // NOW (2026-06-01) is a Monday; build five trailing Mondays and take
    // every one on time. A weekly-cadence med expects a dose ONLY on Mondays.
    const createdAt = new Date(NOW.getTime() - 60 * DAY_MS);
    const schedules = [weeklyMondaySchedule()];
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      null,
      TZ,
    );

    const events: FixtureEvent[] = [];
    for (let week = 0; week < 5; week++) {
      const daysAgo = week * 7; // every Monday back from NOW
      events.push({
        takenAt: slotAt(daysAgo, "08:05"),
        skipped: false,
        scheduledFor: slotAt(daysAgo, "08:00"),
      });
    }
    ctx.lastIntakeAt = lastNonSkippedTakenAt(events);

    const bundle = buildMedicationComplianceBundle(events, schedules, ctx, NOW);

    // Took every expected Monday → 100% over 30 days.
    expect(bundle.compliance30.rate).toBe(100);

    // The per-day series carves the same 30-day window out of the shared
    // ledger and must agree with compliance30 — no off-cadence weekday is
    // counted as a miss.
    const from = new Date(NOW.getTime() - 30 * DAY_MS);
    const windowRows = bundle.ledgerRows.filter(
      (r) =>
        r.at.getTime() >= from.getTime() && r.at.getTime() <= NOW.getTime(),
    );
    const series = dailyComplianceRatesFromLedger(windowRows, TZ);

    // Only the Mondays in the window produce a point — Tuesday…Sunday emit
    // nothing, so a 7×-denser daily denominator can never drag the rate down.
    // NOW is itself a Monday, so the 30-day window holds five Mondays.
    expect(series.length).toBe(5);
    for (const day of series) {
      expect(day.rate).toBe(100);
      expect(day.missed).toBe(0);
    }

    // The series' mean rate equals the canonical compliance30 rate: the two
    // are computed from the SAME ledger and cannot contradict each other.
    const meanRate = series.reduce((sum, d) => sum + d.rate, 0) / series.length;
    expect(Math.round(meanRate)).toBe(bundle.compliance30.rate);
  });

  it("weekly med with one missed Monday: the missed day reads 0%, due days only", () => {
    const createdAt = new Date(NOW.getTime() - 60 * DAY_MS);
    const schedules = [weeklyMondaySchedule()];
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      null,
      TZ,
    );

    // Four Mondays in the 30-day window; skip the take on the 2-weeks-ago one.
    const events: FixtureEvent[] = [];
    for (let week = 0; week < 5; week++) {
      const daysAgo = week * 7;
      if (week === 2) continue; // forgotten dose → an expected slot reads missed
      events.push({
        takenAt: slotAt(daysAgo, "08:05"),
        skipped: false,
        scheduledFor: slotAt(daysAgo, "08:00"),
      });
    }
    ctx.lastIntakeAt = lastNonSkippedTakenAt(events);

    const bundle = buildMedicationComplianceBundle(events, schedules, ctx, NOW);

    const from = new Date(NOW.getTime() - 30 * DAY_MS);
    const windowRows = bundle.ledgerRows.filter(
      (r) =>
        r.at.getTime() >= from.getTime() && r.at.getTime() <= NOW.getTime(),
    );
    const series = dailyComplianceRatesFromLedger(windowRows, TZ);

    // Still one point per due Monday — never a point on a non-due weekday.
    // Five Mondays in the window; the skipped take leaves one as a miss.
    expect(series.length).toBe(5);
    const zeroDays = series.filter((d) => d.rate === 0);
    expect(zeroDays.length).toBe(1);
    expect(zeroDays[0].missed).toBe(1);

    // Aggregate taken / (taken + missed) across due days equals compliance30.
    const taken = series.reduce((sum, d) => sum + d.taken, 0);
    const missed = series.reduce((sum, d) => sum + d.missed, 0);
    const aggregateRate = Math.round((taken / (taken + missed)) * 100);
    expect(aggregateRate).toBe(bundle.compliance30.rate);
  });

  it("buckets a non-Berlin user's two same-local-day doses into ONE day", () => {
    // America/Los_Angeles user, twice-daily 08:00 + 20:00 LOCAL on the same
    // local calendar day (2026-06-15). The 20:00 PDT dose is 03:00 UTC the
    // NEXT day — and 05:00 the next Berlin day — so a fixed-Berlin day key
    // splits one local day's two doses across two buckets.
    const takenOnTime = (h: number, m: number): DoseHistoryRow => {
      const at = zonedWallClockToUtc(
        { year: 2026, month: 6, day: 15, hour: h, minute: m },
        "America/Los_Angeles",
      );
      return {
        kind: "slot",
        at,
        timeOfDay: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        status: "taken_on_time",
        intake: null,
      };
    };
    const rows: DoseHistoryRow[] = [takenOnTime(8, 0), takenOnTime(20, 0)];

    // Bucketed in the user's own zone: one local day, two taken.
    const laSeries = dailyComplianceRatesFromLedger(
      rows,
      "America/Los_Angeles",
    );
    expect(laSeries.length).toBe(1);
    expect(laSeries[0].taken).toBe(2);
    expect(laSeries[0].rate).toBe(100);

    // Sanity: the fixed-Berlin key (the pre-fix behaviour) would split these
    // same two doses across two calendar buckets — the defect the fix closes.
    const berlinSeries = dailyComplianceRatesFromLedger(rows, "Europe/Berlin");
    expect(berlinSeries.length).toBe(2);
  });
});

describe("tallyLedgerRows — windowed tallies over one shared ledger", () => {
  it("the unwindowed tally equals tallyComplianceFromLedger byte-for-byte", () => {
    const createdAt = new Date(NOW.getTime() - 40 * DAY_MS);
    const schedules = [dailySchedule()];
    const events = dailyFixtureEvents();
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      lastNonSkippedTakenAt(events),
      TZ,
    );
    const from = new Date(NOW.getTime() - 30 * DAY_MS);

    const rows = buildComplianceLedgerRows(
      events,
      schedules,
      ctx,
      from,
      NOW,
      NOW,
    );
    expect(tallyLedgerRows(rows)).toEqual(
      tallyComplianceFromLedger(events, schedules, ctx, from, NOW, NOW),
    );
  });

  it("a sub-window tally counts only rows inside the window", () => {
    const createdAt = new Date(NOW.getTime() - 40 * DAY_MS);
    const schedules = [dailySchedule()];
    const events = dailyFixtureEvents();
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      lastNonSkippedTakenAt(events),
      TZ,
    );

    const rows = buildComplianceLedgerRows(
      events,
      schedules,
      ctx,
      createdAt,
      NOW,
      NOW,
    );
    const wide = tallyLedgerRows(rows);
    // 3.5 days reaches back past the day −3 08:00 slot (NOW is 12:00Z, so a
    // plain 3-day bound would cut that morning slot off).
    const narrow = tallyLedgerRows(rows, {
      from: new Date(NOW.getTime() - 3.5 * DAY_MS),
      to: NOW,
    });

    // Days −1 and −2 are taken on time; day −3 is a skip. Everything
    // older falls outside the window.
    expect(narrow.takenOnTime).toBe(2);
    expect(narrow.skipped).toBe(1);
    expect(narrow.denominator).toBeLessThan(wide.denominator);
  });
});
