/**
 * Shared rows for the calendar-feed tests: a regular record with a year of
 * 28-day cycles, mocked through the same Prisma calls the loader makes.
 */
import { addDays } from "@/lib/cycle/day-math";

export function regularCycles(first: string, count = 13, length = 28) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const startDate = addDays(first, i * length);
    out.push({
      id: `cycle-${i}`,
      userId: "subject",
      startDate,
      endDate: i < count - 1 ? addDays(startDate, length) : null,
      periodEndDate: i % 2 === 0 ? addDays(startDate, 4) : null,
      ovulationDate: null,
      ovulationConfirmed: false,
      deletedAt: null,
    });
  }
  return out;
}

export function profileRow(goal = "GENERAL_HEALTH", overrides = {}) {
  return {
    id: "profile",
    userId: "subject",
    goal,
    cycleTrackingEnabled: true,
    typicalCycleLength: null,
    typicalPeriodLength: null,
    lutealPhaseLength: null,
    secondarySymptom: "MUCUS",
    predictionEnabled: true,
    rawChartMode: false,
    discreetNotifications: false,
    sensitiveCategoryEncryption: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export const FEED = {
  id: "feed-1",
  horizonCycles: 3,
  historyCycles: 0,
  includeFertile: false,
  titleMode: "DISCREET" as const,
  forecastStyle: "BAND" as const,
};

export const SUBJECT = {
  id: "subject",
  timezone: "Europe/Berlin",
  locale: "en",
};
