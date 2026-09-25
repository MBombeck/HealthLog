/**
 * v1.15.0 — calendar composition over the deterministic engine.
 */
import { describe, it, expect } from "vitest";

import {
  buildCalendar,
  type CalendarDayDTO,
  type CalendarDayLogRow,
} from "../engine-adapter";
import type { CycleProfile, MenstrualCycle } from "@/generated/prisma/client";

function profile(overrides: Partial<CycleProfile> = {}): CycleProfile {
  return {
    id: "p1",
    userId: "u1",
    goal: "GENERAL_HEALTH",
    cycleTrackingEnabled: true,
    typicalCycleLength: null,
    typicalPeriodLength: null,
    lutealPhaseLength: null,
    predictionEnabled: true,
    rawChartMode: false,
    discreetNotifications: false,
    sensitiveCategoryEncryption: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CycleProfile;
}

function cycle(
  startDate: string,
  overrides: Partial<MenstrualCycle> = {},
): MenstrualCycle {
  return {
    id: `c-${startDate}`,
    userId: "u1",
    startDate,
    endDate: null,
    periodEndDate: null,
    lengthDays: null,
    ovulationDate: null,
    ovulationConfirmed: false,
    isPredicted: false,
    tz: null,
    syncVersion: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MenstrualCycle;
}

describe("buildCalendar", () => {
  // Three ~28-day cycles → a real prediction.
  const cycles = [
    cycle("2026-01-01", {
      endDate: "2026-01-28",
      lengthDays: 28,
      periodEndDate: "2026-01-05",
    }),
    cycle("2026-01-29", {
      endDate: "2026-02-25",
      lengthDays: 28,
      periodEndDate: "2026-02-02",
    }),
    cycle("2026-02-26", { periodEndDate: "2026-03-02" }),
  ];

  it("labels logged-flow days and emits a forecast for ≥2 cycles", () => {
    const dayLogs: CalendarDayLogRow[] = [
      {
        date: "2026-02-26",
        flow: "MEDIUM",
        basalBodyTempC: null,
        temperatureExcluded: false,
        ovulationTest: null,
        cervicalMucus: null,
        cervixPosition: null,
        cervixFirmness: null,
        cervixOpening: null,
        intermenstrualBleeding: false,
        sexualActivity: false,
        pregnancyTest: null,
        progesteroneTest: null,
        contraceptive: null,
        hasSymptoms: true,
        hasNote: false,
      },
    ];
    const { prediction, days } = buildCalendar(
      profile(),
      cycles,
      dayLogs,
      [],
      "2026-02-20",
      "2026-04-15",
      "2026-03-10",
      false,
    );
    expect(prediction).not.toBeNull();
    expect(prediction!.cyclesObserved).toBeGreaterThanOrEqual(2);

    const logged = days.find((d) => d.date === "2026-02-26")!;
    expect(logged.isPeriodLogged).toBe(true);
    expect(logged.flow).toBe("MEDIUM");
    expect(logged.hasSymptoms).toBe(true);

    // The forecast next-period start falls inside a predicted-period day.
    const predStart = prediction!.nextPeriodStart;
    const predDay = days.find((d) => d.date === predStart);
    expect(predDay?.isPredictedPeriod).toBe(true);
  });

  it("suppresses the fertile window at the grid when the goal disallows it", () => {
    const { days } = buildCalendar(
      profile({ goal: "GENERAL_HEALTH" }),
      cycles,
      [],
      [],
      "2026-02-20",
      "2026-04-15",
      "2026-03-10",
      false,
    );
    expect(days.every((d) => !d.isFertileWindow)).toBe(true);
    expect(days.every((d) => !d.isPredictedOvulation)).toBe(true);
  });

  it("surfaces the fertile window for the conception goal once past cold start", () => {
    // Four starts → three completed cycles → not still-learning.
    const fourCycles = [
      cycle("2026-01-01", {
        endDate: "2026-01-29",
        periodEndDate: "2026-01-05",
      }),
      cycle("2026-01-29", {
        endDate: "2026-02-26",
        periodEndDate: "2026-02-02",
      }),
      cycle("2026-02-26", {
        endDate: "2026-03-26",
        periodEndDate: "2026-03-02",
      }),
      cycle("2026-03-26", { periodEndDate: "2026-03-30" }),
    ];
    const { days } = buildCalendar(
      profile({ goal: "TRYING_TO_CONCEIVE" }),
      fourCycles,
      [],
      [],
      "2026-03-20",
      "2026-05-15",
      "2026-04-10",
      true,
    );
    expect(days.some((d) => d.isFertileWindow)).toBe(true);
  });

  it("emits no prediction in raw-chart mode", () => {
    const { prediction } = buildCalendar(
      profile({ rawChartMode: true }),
      cycles,
      [],
      [],
      "2026-02-20",
      "2026-04-15",
      "2026-03-10",
      false,
    );
    expect(prediction).toBeNull();
  });

  describe("still-learning gate (cold start)", () => {
    // One logged period — zero completed cycles → priors-only forecast.
    const oneCycle = [cycle("2026-02-26", { periodEndDate: "2026-03-02" })];

    it("flags stillLearning and asserts no fertile/ovulation grid for ≤1 cycle (TTC)", () => {
      const { prediction, stillLearning, days } = buildCalendar(
        profile({ goal: "TRYING_TO_CONCEIVE" }),
        oneCycle,
        [],
        [],
        "2026-02-20",
        "2026-04-15",
        "2026-03-10",
        true, // goal allows fertile — only the learning gate must suppress it
      );
      expect(prediction).not.toBeNull();
      expect(prediction!.cyclesObserved).toBeLessThan(3);
      expect(prediction!.stillLearning).toBe(true);
      expect(stillLearning).toBe(true);

      // No confident fertile shading or ovulation dot from a population guess.
      expect(days.every((d) => !d.isFertileWindow)).toBe(true);
      expect(days.every((d) => !d.isPredictedOvulation)).toBe(true);
      // No asserted phase band either (population-28 frame is not yet earned).
      expect(days.every((d) => d.phase === null)).toBe(true);
      // The predicted next-period bar still shows (the panel shows it too).
      expect(days.some((d) => d.isPredictedPeriod)).toBe(true);
    });

    it("emits normal fertile/ovulation/phase output once ≥3 cycles are observed", () => {
      // Four ~28-day starts → three COMPLETED cycle lengths → cyclesObserved=3.
      const fourCycles = [
        cycle("2026-01-01", {
          endDate: "2026-01-29",
          periodEndDate: "2026-01-05",
        }),
        cycle("2026-01-29", {
          endDate: "2026-02-26",
          periodEndDate: "2026-02-02",
        }),
        cycle("2026-02-26", {
          endDate: "2026-03-26",
          periodEndDate: "2026-03-02",
        }),
        cycle("2026-03-26", { periodEndDate: "2026-03-30" }),
      ];
      const { prediction, stillLearning, days } = buildCalendar(
        profile({ goal: "TRYING_TO_CONCEIVE" }),
        fourCycles,
        [],
        [],
        "2026-03-20",
        "2026-05-15",
        "2026-04-10",
        true,
      );
      expect(prediction!.cyclesObserved).toBeGreaterThanOrEqual(3);
      expect(prediction!.stillLearning).toBe(false);
      expect(stillLearning).toBe(false);
      expect(days.some((d) => d.isFertileWindow)).toBe(true);
      expect(days.some((d) => d.isPredictedOvulation)).toBe(true);
      expect(days.some((d) => d.phase !== null)).toBe(true);
    });
  });

  describe("the position of each date in its own cycle (#1004)", () => {
    // The log sheet used to label every date with TODAY's cycle day, so a
    // January date opened in September read "Day 2", and it offered the
    // one-tap period end only when today was a bleeding day. Both answers now
    // come per date, from the cycle that date actually belongs to.
    const history = [
      cycle("2026-01-01", { endDate: "2026-01-28", lengthDays: 28 }),
      cycle("2026-01-29", { endDate: "2026-02-25", lengthDays: 28 }),
      cycle("2026-02-26"),
    ];

    function dayOf(days: CalendarDayDTO[], date: string): CalendarDayDTO {
      const d = days.find((x) => x.date === date);
      if (!d) throw new Error(`no grid day for ${date}`);
      return d;
    }

    it("counts a historical date from the start of the cycle it sits in", () => {
      const { days } = buildCalendar(
        profile(),
        history,
        [],
        [],
        "2025-12-20",
        "2026-03-20",
        "2026-03-10",
        false,
      );
      expect(dayOf(days, "2026-01-26").cycleDay).toBe(26);
      expect(dayOf(days, "2026-01-29").cycleDay).toBe(1);
      expect(dayOf(days, "2026-02-27").cycleDay).toBe(2);
      // Today, in the open cycle: the same count the verdict reports.
      expect(dayOf(days, "2026-03-10").cycleDay).toBe(13);
    });

    it("claims no cycle day before the first logged start or after today", () => {
      const { days } = buildCalendar(
        profile(),
        history,
        [],
        [],
        "2025-12-20",
        "2026-03-20",
        "2026-03-10",
        false,
      );
      expect(dayOf(days, "2025-12-31").cycleDay).toBeNull();
      expect(dayOf(days, "2026-03-11").cycleDay).toBeNull();
    });

    it("offers a period end only inside the first days of a logged cycle", () => {
      const { days } = buildCalendar(
        profile(),
        history,
        [],
        [],
        "2025-12-20",
        "2026-03-20",
        "2026-03-10",
        false,
      );
      expect(dayOf(days, "2026-01-01").periodEndable).toBe(true);
      expect(dayOf(days, "2026-01-05").periodEndable).toBe(true);
      expect(dayOf(days, "2026-02-01").periodEndable).toBe(true);
      expect(dayOf(days, "2026-01-26").periodEndable).toBe(false);
      expect(dayOf(days, "2025-12-31").periodEndable).toBe(false);
      expect(dayOf(days, "2026-03-11").periodEndable).toBe(false);
    });

    it("answers the same whichever order the starts were entered in", () => {
      // A September start entered first, then January: January's own days
      // count from January, never from September or from today.
      const { days } = buildCalendar(
        profile(),
        [cycle("2026-09-17"), cycle("2026-01-26")],
        [],
        [],
        "2026-01-01",
        "2026-02-28",
        "2026-09-24",
        false,
      );
      expect(dayOf(days, "2026-01-26").cycleDay).toBe(1);
      expect(dayOf(days, "2026-01-28").cycleDay).toBe(3);
      expect(dayOf(days, "2026-01-28").periodEndable).toBe(true);
      expect(dayOf(days, "2026-01-25").cycleDay).toBeNull();
    });

    it("stops counting an open cycle where the verdict stops", () => {
      // One start in January and nothing since: by August the count is no
      // longer an observed cycle day, the same ceiling the ring applies.
      const { days } = buildCalendar(
        profile(),
        [cycle("2026-01-01")],
        [],
        [],
        "2026-01-01",
        "2026-09-24",
        "2026-09-24",
        false,
      );
      expect(dayOf(days, "2026-01-05").cycleDay).toBe(5);
      expect(dayOf(days, "2026-08-01").cycleDay).toBeNull();
    });
  });
});
