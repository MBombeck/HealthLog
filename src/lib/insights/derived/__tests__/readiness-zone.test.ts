/**
 * Readiness groups "same day" in the account's zone.
 *
 * The blend scores each vital's latest local-day mean, so the zone decides
 * which readings share a day. A caller that passes no zone (the derived
 * route, the dashboard rings, the Coach snapshot, the nightly jobs) used to
 * get `Europe/Berlin`, so for an account in Los Angeles a 23:30 reading was
 * folded into the next morning's day mean. Omitted, the zone is now the
 * account's stored one, resolved the same way the sleep score resolves it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));
vi.mock("@/lib/measurements/dense-bucket-read", async () => {
  const { makeFakeDenseBucketRead } =
    await import("@/lib/measurements/__tests__/fake-dense-bucket-read");
  const { prisma } = await import("@/lib/db");
  return makeFakeDenseBucketRead((args) =>
    (prisma.measurement.findMany as (a: unknown) => never)(args),
  );
});
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { computeReadiness, type ReadinessValue } from "../readiness";
import { computeDerivedMetric } from "../dispatch";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const DAY_MS = 24 * 60 * 60 * 1000;
const LA = "America/Los_Angeles";
const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
const moodFindMany = prisma.moodEntry.findMany as ReturnType<typeof vi.fn>;
const resolveTz = resolveUserTimezone as ReturnType<typeof vi.fn>;

// 08:00 in Los Angeles (PDT, UTC-7) on 2 June.
const NOW = new Date("2026-06-02T15:00:00Z");

/**
 * Ten mornings of resting pulse 58 and HRV 65 at 05:00 Los Angeles time, one
 * main night per day, plus a resting pulse of 80 taken at 23:30 Los Angeles
 * time on 1 June (06:30 UTC on 2 June, already 2 June in Berlin) and a 58 at
 * 07:00 on 2 June. In the account's zone today's day mean is 58; folded in
 * Berlin it carries the late 80 and reads as an elevated pulse.
 */
function seed() {
  const morning = (back: number) =>
    new Date(Date.parse("2026-06-02T12:00:00Z") - back * DAY_MS);
  const series = (type: string, value: number) =>
    Array.from({ length: 10 }, (_, i) => ({
      value,
      measuredAt: morning(i),
      type,
    }));
  const rhr = [
    ...series("RESTING_HEART_RATE", 58),
    {
      value: 80,
      measuredAt: new Date("2026-06-02T06:30:00Z"),
      type: "RESTING_HEART_RATE",
    },
    {
      value: 58,
      measuredAt: new Date("2026-06-02T14:00:00Z"),
      type: "RESTING_HEART_RATE",
    },
  ];
  const nights = Array.from({ length: 5 }, (_, i) => ({
    value: 420,
    measuredAt: morning(i),
    sleepStage: "ASLEEP",
    source: "APPLE_HEALTH",
    deviceType: null,
  }));
  findMany.mockImplementation(async (args: { where: { type: unknown } }) => {
    const type = args.where.type;
    if (type === "RESTING_HEART_RATE") return rhr;
    if (type === "HEART_RATE_VARIABILITY")
      return series("HEART_RATE_VARIABILITY", 65);
    if (type === "SLEEP_DURATION") return nights;
    return [];
  });
}

function rhrOf(value: ReadinessValue): number | null {
  return value.components.find((c) => c.key === "rhr")?.value ?? null;
}

async function readiness(tz?: string): Promise<ReadinessValue> {
  const result = await computeReadiness("u1", PROFILE, {
    now: NOW,
    ...(tz ? { tz } : {}),
  });
  if (result.status !== "ok") throw new Error(`readiness ${result.status}`);
  return result.value;
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  moodFindMany.mockResolvedValue([]);
  resolveTz.mockResolvedValue(LA);
  seed();
});

describe("readiness day grouping without an explicit zone", () => {
  it("the zone changes the resting-pulse day mean (fixture sanity)", async () => {
    const inLa = rhrOf(await readiness(LA));
    const inBerlin = rhrOf(await readiness("Europe/Berlin"));
    expect(inLa).not.toBeNull();
    expect(inBerlin).not.toBeNull();
    expect(inLa).not.toBe(inBerlin);
  });

  it("keys the day on the account's stored zone, not Berlin", async () => {
    const expected = rhrOf(await readiness(LA));
    const value = await readiness();
    expect(resolveTz).toHaveBeenCalledWith("u1");
    expect(rhrOf(value)).toBe(expected);
  });

  it("the dispatcher path (route, rings, Coach, jobs) gets the same day", async () => {
    const expected = await readiness(LA);
    const derived = await computeDerivedMetric({
      metric: "READINESS",
      userId: "u1",
      profile: PROFILE,
      now: NOW,
    });
    expect(derived.status).toBe("ok");
    const value = (derived as { value: ReadinessValue }).value;
    expect(rhrOf(value)).toBe(rhrOf(expected));
    expect(value.score).toBe(expected.score);
  });
});
