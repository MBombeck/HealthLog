import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    cycleProfile: { findUnique: vi.fn() },
    menstrualCycle: { findMany: vi.fn() },
    cycleDayLog: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

// The crosstab reads per-source day aggregates; the fake groups the mocked
// `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readSourceDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadSourceDayAggregates,
}));

import { buildCycleSnapshotBlock } from "../cycle-snapshot";
import { prisma } from "@/lib/db";

const prismaMock = prisma as unknown as {
  cycleProfile: { findUnique: ReturnType<typeof vi.fn> };
  menstrualCycle: { findMany: ReturnType<typeof vi.fn> };
  cycleDayLog: { findMany: ReturnType<typeof vi.fn> };
  measurement: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

const NOW = new Date("2026-03-22T12:00:00.000Z");

function profile(overrides: Record<string, unknown> = {}) {
  return {
    goal: "GENERAL_HEALTH",
    predictionEnabled: true,
    rawChartMode: false,
    lutealPhaseLength: 14,
    typicalCycleLength: 28,
    typicalPeriodLength: 5,
    ...overrides,
  };
}

/** Three completed 28-day cycles ending just before NOW. */
function cycles() {
  return [
    {
      startDate: "2026-01-05",
      endDate: "2026-02-02",
      periodEndDate: "2026-01-09",
      ovulationDate: null,
      ovulationConfirmed: false,
    },
    {
      startDate: "2026-02-02",
      endDate: "2026-03-02",
      periodEndDate: "2026-02-06",
      ovulationDate: null,
      ovulationConfirmed: false,
    },
    {
      startDate: "2026-03-02",
      endDate: null,
      periodEndDate: "2026-03-06",
      ovulationDate: null,
      ovulationConfirmed: false,
    },
  ];
}

/**
 * RHR rows: luteal days clearly higher than follicular days. Both windows land
 * within `[cycle start (2026-03-02), today (2026-03-22)]` so the phase-day map
 * (which only runs up to `today`) labels every one.
 */
function rhrMeasurements() {
  const out: Array<Record<string, unknown>> = [];
  const day = (i: number, v: number) =>
    out.push({
      type: "RESTING_HEART_RATE",
      value: v + (i % 3) * 0.5,
      measuredAt: new Date(
        `2026-03-${String(i).padStart(2, "0")}T12:00:00.000Z`,
      ),
      source: "APPLE_HEALTH",
      deviceType: null,
    });
  // Follicular window ~ cycle days 6..12 (2026-03-07..03-13).
  for (let i = 7; i <= 13; i++) day(i, 57);
  // Luteal window ~ cycle days 16..21 (2026-03-17..03-22).
  for (let i = 17; i <= 22; i++) day(i, 63);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.cycleDayLog.findMany.mockResolvedValue([]);
  prismaMock.user.findUnique.mockResolvedValue({ sourcePriorityJson: null });
  // The wrist-temperature read + the outcome-metric read share the same mock;
  // default to empty, override per-test for the metric read.
  prismaMock.measurement.findMany.mockResolvedValue([]);
});

describe("buildCycleSnapshotBlock", () => {
  it("returns null when the account has no cycle profile", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(null);
    expect(await buildCycleSnapshotBlock("u1", "FEMALE", NOW)).toBeNull();
  });

  it("returns null when the account has no observed cycles", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(profile());
    prismaMock.menstrualCycle.findMany.mockResolvedValue([]);
    expect(await buildCycleSnapshotBlock("u1", "FEMALE", NOW)).toBeNull();
  });

  it("reports the current phase, day-of-cycle and next predicted event", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(profile());
    prismaMock.menstrualCycle.findMany.mockResolvedValue(cycles());
    const block = await buildCycleSnapshotBlock("u1", "FEMALE", NOW);
    expect(block).not.toBeNull();
    // 2026-03-22 is day 21 of a cycle that started 2026-03-02 → luteal.
    expect(block!.phase).toBe("LUTEAL");
    expect(block!.dayOfCycle).toBe(21);
    expect(block!.cyclesObserved).toBe(3);
    expect(block!.nextEvent).not.toBeNull();
    expect(block!.nextEvent!.nextPeriodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(block!.nextEvent!.method).toBeTruthy();
  });

  it("suppresses the fertile window unless the goal surfaces it", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(
      profile({ goal: "GENERAL_HEALTH" }),
    );
    prismaMock.menstrualCycle.findMany.mockResolvedValue(cycles());
    const block = await buildCycleSnapshotBlock("u1", "FEMALE", NOW);
    expect(block!.nextEvent!.fertileWindowStart).toBeUndefined();

    prismaMock.cycleProfile.findUnique.mockResolvedValue(
      profile({ goal: "TRYING_TO_CONCEIVE" }),
    );
    const ttc = await buildCycleSnapshotBlock("u1", "FEMALE", NOW);
    // The conception goal may surface the window (present when the engine
    // computes one) — the key invariant is the GENERAL_HEALTH path never does.
    expect(
      ttc!.nextEvent!.fertileWindowStart === undefined ||
        typeof ttc!.nextEvent!.fertileWindowStart === "string",
    ).toBe(true);
  });

  it("derives 'today' from the threaded user timezone, not wall-clock", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(profile());
    prismaMock.menstrualCycle.findMany.mockResolvedValue(cycles());

    // NOW is 2026-03-22T12:00Z. In Berlin (UTC+1) the local day is the
    // 22nd → day-of-cycle 21 (cycle started 2026-03-02). In Kiritimati
    // (UTC+14) the local day has already rolled to the 23rd → day 22.
    const berlin = await buildCycleSnapshotBlock(
      "u1",
      "FEMALE",
      NOW,
      "Europe/Berlin",
    );
    prismaMock.cycleProfile.findUnique.mockResolvedValue(profile());
    prismaMock.menstrualCycle.findMany.mockResolvedValue(cycles());
    const kiritimati = await buildCycleSnapshotBlock(
      "u1",
      "FEMALE",
      NOW,
      "Pacific/Kiritimati",
    );

    expect(berlin!.dayOfCycle).toBe(21);
    expect(kiritimati!.dayOfCycle).toBe(22);
  });

  it("includes the headline phase insight when a contrast clears FDR", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(profile());
    prismaMock.menstrualCycle.findMany.mockResolvedValue(cycles());
    // First measurement read = WRIST_TEMPERATURE (empty), second = outcomes.
    prismaMock.measurement.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rhrMeasurements());
    const block = await buildCycleSnapshotBlock("u1", "FEMALE", NOW);
    expect(block!.phaseInsight).not.toBeNull();
    expect(block!.phaseInsight!.metric).toBe("resting heart rate");
    expect(block!.phaseInsight!.delta).toBeGreaterThan(0);
    expect(block!.phaseInsight!.interpretation).toMatch(
      /descriptive pattern, not a cause/,
    );
  });

  it("carries the projected later periods as ranges (#1350)", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(profile());
    // Thirteen regular cycles: past the cold start, so the projection reaches
    // beyond the next period.
    const many = Array.from({ length: 13 }, (_, i) => {
      const start = new Date(Date.UTC(2025, 3, 7 + i * 28));
      return {
        startDate: start.toISOString().slice(0, 10),
        endDate: null,
        periodEndDate: new Date(start.getTime() + 4 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        ovulationDate: null,
        ovulationConfirmed: false,
      };
    });
    prismaMock.menstrualCycle.findMany.mockResolvedValue(many);
    const block = await buildCycleSnapshotBlock("u1", "FEMALE", NOW);
    expect(block!.upcoming.length).toBeGreaterThan(1);
    expect(block!.upcoming[0].start).toBe(block!.nextEvent!.nextPeriodStart);
    expect(block!.upcoming[0].earliestStart).toBe(
      block!.nextEvent!.nextPeriodStartLow,
    );
    for (const u of block!.upcoming) {
      expect(Object.keys(u).sort()).toEqual([
        "earliestStart",
        "latestStart",
        "start",
      ]);
    }
  });

  it("carries no upcoming periods when prediction is off", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(
      profile({ predictionEnabled: false }),
    );
    prismaMock.menstrualCycle.findMany.mockResolvedValue(cycles());
    const block = await buildCycleSnapshotBlock("u1", "FEMALE", NOW);
    expect(block!.upcoming).toEqual([]);
    expect(block!.nextEvent).toBeNull();
  });

  it("reads day logs from the calendar's default window, not the whole history", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(profile());
    prismaMock.menstrualCycle.findMany.mockResolvedValue(cycles());
    await buildCycleSnapshotBlock("u1", "FEMALE", NOW);
    expect(prismaMock.cycleDayLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ date: { gte: "2025-12-22" } }),
      }),
    );
  });
});

describe("buildCycleSnapshotBlock — the reader's units", () => {
  it("states a weight contrast in pounds for an imperial reader", async () => {
    prismaMock.cycleProfile.findUnique.mockResolvedValue(profile());
    prismaMock.menstrualCycle.findMany.mockResolvedValue(cycles());
    prismaMock.user.findUnique.mockResolvedValue({
      sourcePriorityJson: null,
      unitPreference: "imperial",
    });
    const weight = rhrMeasurements().map((row) => ({
      ...row,
      type: "WEIGHT",
      value: (row.value as number) + 10,
    }));
    prismaMock.measurement.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(weight);
    const block = await buildCycleSnapshotBlock("u1", "FEMALE", NOW);
    const insight = block!.phaseInsight!;
    expect(insight.metric).toBe("weight");
    expect(insight.unit).toBe("lb");
    // Luteal ~73 kg, follicular ~67 kg: both means and the gap in pounds.
    expect(insight.lutealAvg).toBeGreaterThan(155);
    expect(insight.follicularAvg).toBeGreaterThan(145);
    expect(insight.delta).toBeGreaterThan(12);
    expect(insight.interpretation).toMatch(/runs about [\d.]+ lb higher/);
    expect(insight.interpretation).not.toContain("kg");
  });
});
