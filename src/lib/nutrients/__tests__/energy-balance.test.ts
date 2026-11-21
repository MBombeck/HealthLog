import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: { findMany: vi.fn(async () => []) },
    measurement: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/day/daily-stats", () => ({
  readLocalDailyStats: vi.fn(async () => new Map()),
}));

import {
  ageOn,
  computeEnergyBalance,
  mifflinStJeor,
  readEnergyBalance,
  type EnergyProfile,
} from "../energy-balance";

const PROFILE: EnergyProfile = {
  sex: "FEMALE",
  heightCm: 170,
  birthDay: "1990-06-15",
};

const days = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `2026-11-${String(10 + i).padStart(2, "0")}`,
  );

const map = (entries: Record<string, number>) =>
  new Map(Object.entries(entries));

describe("computeEnergyBalance", () => {
  it("subtracts resting and active energy from the intake", () => {
    const out = computeEnergyBalance({
      dayKeys: ["2026-11-10"],
      today: "2026-11-20",
      intake: map({ "2026-11-10": 2000 }),
      resting: map({ "2026-11-10": 1500 }),
      active: map({ "2026-11-10": 700 }),
      weight: new Map(),
      seedWeightKg: null,
      profile: PROFILE,
    });
    expect(out.days[0]).toMatchObject({
      intakeKcal: 2000,
      restingKcal: 1500,
      restingEstimated: false,
      expenditureKcal: 2200,
      balanceKcal: -200,
    });
  });

  it("estimates resting energy only with the whole profile", () => {
    const base = {
      dayKeys: ["2026-11-10"],
      today: "2026-11-20",
      intake: map({ "2026-11-10": 2000 }),
      resting: new Map<string, number>(),
      active: map({ "2026-11-10": 300 }),
      weight: new Map<string, number>(),
      seedWeightKg: 65,
    };
    const estimated = computeEnergyBalance({ ...base, profile: PROFILE });
    const expected = Math.round(
      mifflinStJeor({
        sex: "FEMALE",
        weightKg: 65,
        heightCm: 170,
        ageYears: 36,
      }),
    );
    expect(estimated.days[0]).toMatchObject({
      restingKcal: expected,
      restingEstimated: true,
      expenditureKcal: expected + 300,
    });
    expect(estimated.estimateGaps).toEqual([]);

    const noSex = computeEnergyBalance({
      ...base,
      profile: { ...PROFILE, sex: null },
    });
    expect(noSex.days[0].restingKcal).toBeNull();
    expect(noSex.days[0].balanceKcal).toBeNull();
    expect(noSex.estimateGaps).toEqual(["sex"]);
  });

  it("never turns a missing input into a zero", () => {
    const out = computeEnergyBalance({
      dayKeys: ["2026-11-10", "2026-11-11"],
      today: "2026-11-20",
      intake: map({ "2026-11-11": 1800 }),
      resting: map({ "2026-11-10": 1500, "2026-11-11": 1500 }),
      active: map({ "2026-11-10": 500 }),
      weight: new Map(),
      seedWeightKg: null,
      profile: PROFILE,
    });
    // No intake on the 10th, no active energy on the 11th.
    expect(out.days.map((d) => d.balanceKcal)).toEqual([null, null]);
    expect(out.summary.meanBalanceKcal).toBeNull();
  });

  it("keeps today out of the trend and the means", () => {
    const keys = days(8);
    const all = (v: number) =>
      new Map(keys.map((k) => [k, v] as [string, number]));
    const out = computeEnergyBalance({
      dayKeys: keys,
      today: keys[7],
      intake: new Map(
        [...all(2000)].map(([k, v]) => [k, k === keys[7] ? 400 : v]),
      ),
      resting: all(1500),
      active: all(800),
      weight: new Map(),
      seedWeightKg: null,
      profile: PROFILE,
    });
    expect(out.days[7].partial).toBe(true);
    expect(out.days[7].trendKcal).toBeNull();
    // Four days are needed before the trend starts.
    expect(out.days.slice(0, 3).every((d) => d.trendKcal === null)).toBe(true);
    expect(out.days[3].trendKcal).toBe(-300);
    expect(out.summary).toEqual({
      daysWithBalance: 7,
      meanIntakeKcal: 2000,
      meanExpenditureKcal: 2300,
      meanBalanceKcal: -300,
    });
  });

  it("carries the last weight forward into the window", () => {
    const out = computeEnergyBalance({
      dayKeys: ["2026-11-10", "2026-11-11"],
      today: "2026-11-20",
      intake: map({ "2026-11-10": 2000, "2026-11-11": 2000 }),
      resting: new Map(),
      active: map({ "2026-11-10": 0, "2026-11-11": 0 }),
      weight: map({ "2026-11-11": 75 }),
      seedWeightKg: 65,
      profile: PROFILE,
    });
    // Ten kilograms more is 100 kcal more resting energy.
    expect(
      (out.days[1].restingKcal as number) - (out.days[0].restingKcal as number),
    ).toBe(100);
  });
});

describe("ageOn", () => {
  it("counts a birthday only once it has passed", () => {
    expect(ageOn("1990-06-15", "2026-06-14")).toBe(35);
    expect(ageOn("1990-06-15", "2026-06-15")).toBe(36);
  });
});

describe("readEnergyBalance", () => {
  const read = () =>
    readEnergyBalance({
      userId: "u",
      tz: "Europe/Berlin",
      days: 7,
      gender: null,
      heightCm: null,
      dateOfBirth: null,
      sourcePriorityJson: null,
    });

  it("lists the window oldest first and ends on today, partial, with no intake at all", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-21T12:00:00.000Z") });
    try {
      const out = await read();
      expect(out.days.map((d) => d.day)).toEqual([
        "2026-11-15",
        "2026-11-16",
        "2026-11-17",
        "2026-11-18",
        "2026-11-19",
        "2026-11-20",
        "2026-11-21",
      ]);
      expect(out.days.map((d) => d.partial)).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(out.days.at(-1)?.intakeKcal).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns the day at the record zone's midnight, not at UTC's", async () => {
    // 23:59:59 and 00:00:00 in Berlin (UTC+1 in November).
    for (const [now, today] of [
      ["2026-11-21T22:59:59.000Z", "2026-11-21"],
      ["2026-11-21T23:00:00.000Z", "2026-11-22"],
    ] as const) {
      vi.useFakeTimers({ now: new Date(now) });
      try {
        const out = await read();
        expect(out.days.at(-1)).toMatchObject({ day: today, partial: true });
        expect(out.days.filter((d) => d.partial)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
