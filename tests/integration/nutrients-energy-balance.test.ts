/**
 * The daily energy balance (`GET /api/nutrients/energy-balance`) against real
 * Postgres: the intake folded across sources, resting and active energy
 * summed on the record's own day, the resting estimate on a day without a
 * reading, no balance where an input is missing, and the module gate.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const TZ = "Europe/Berlin";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(nutrients: boolean) {
  const db = getPrismaClient();
  const owner = await db.user.create({
    data: {
      username: "energy-owner",
      email: "energy-owner@example.test",
      timezone: TZ,
      gender: "MALE",
      heightCm: 180,
      dateOfBirth: new Date("1986-03-01T00:00:00.000Z"),
      modulePreferencesJson: { nutrients },
    },
  });
  const session = await db.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return owner.id;
}

/** Noon on a local day, as an instant. */
const noon = (day: string) =>
  new Date(startOfLocalDayKey(day, TZ).getTime() + 12 * 3_600_000);

async function read(days = 7) {
  const { GET } = await import("@/app/api/nutrients/energy-balance/route");
  return (GET as unknown as (r: NextRequest) => Promise<Response>)(
    new NextRequest(
      `http://localhost/api/nutrients/energy-balance?days=${days}`,
    ),
  );
}

type Balance = import("@/lib/nutrients/energy-balance").EnergyBalance;

describe("GET /api/nutrients/energy-balance", () => {
  it("balances the day's intake against resting and active energy", async () => {
    const db = getPrismaClient();
    const userId = await signIn(true);
    const today = userDayKey(new Date(), TZ);
    const measured = shiftDateKey(today, -2);
    const estimated = shiftDateKey(today, -1);
    const empty = shiftDateKey(today, -3);

    await db.nutrientIntakeDay.createMany({
      data: [
        // Two day-total sources: only the larger counts.
        {
          userId,
          day: measured,
          nutrient: "energy",
          amount: 2400,
          unit: "kcal",
          source: "APPLE_HEALTH",
        },
        {
          userId,
          day: measured,
          nutrient: "energy",
          amount: 2300,
          unit: "kcal",
          source: "EXTERNAL",
        },
        {
          userId,
          day: estimated,
          nutrient: "energy",
          amount: 2100,
          unit: "kcal",
          source: "EXTERNAL",
        },
      ],
    });
    await db.measurement.createMany({
      data: [
        {
          userId,
          type: "BASAL_ENERGY_BURNED",
          value: 1000,
          unit: "kcal",
          measuredAt: noon(measured),
          source: "APPLE_HEALTH",
        },
        {
          userId,
          type: "BASAL_ENERGY_BURNED",
          value: 800,
          unit: "kcal",
          measuredAt: new Date(noon(measured).getTime() + 3_600_000),
          source: "APPLE_HEALTH",
        },
        {
          userId,
          type: "ACTIVE_ENERGY_BURNED",
          value: 500,
          unit: "kcal",
          measuredAt: noon(measured),
          source: "APPLE_HEALTH",
        },
        {
          userId,
          type: "ACTIVE_ENERGY_BURNED",
          value: 400,
          unit: "kcal",
          measuredAt: noon(estimated),
          source: "APPLE_HEALTH",
        },
        {
          userId,
          type: "ACTIVE_ENERGY_BURNED",
          value: 300,
          unit: "kcal",
          measuredAt: noon(empty),
          source: "APPLE_HEALTH",
        },
        {
          userId,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          measuredAt: noon(shiftDateKey(today, -30)),
          source: "MANUAL",
        },
      ],
    });

    const res = await read();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Balance };
    expect(data.windowDays).toBe(7);
    const byDay = new Map(data.days.map((d) => [d.day, d]));

    expect(byDay.get(measured)).toMatchObject({
      intakeKcal: 2400,
      restingKcal: 1800,
      restingEstimated: false,
      activeKcal: 500,
      expenditureKcal: 2300,
      balanceKcal: 100,
    });
    // No resting reading: Mifflin-St Jeor from 80 kg, 180 cm, the age that day.
    const est = byDay.get(estimated)!;
    expect(est.restingEstimated).toBe(true);
    expect(est.restingKcal).toBeGreaterThan(1600);
    expect(est.restingKcal).toBeLessThan(1900);
    expect(est.balanceKcal).toBe(2100 - (est.restingKcal as number) - 400);
    // Active energy but nothing eaten logged: no balance, not a fast.
    expect(byDay.get(empty)?.balanceKcal).toBeNull();
    expect(byDay.get(today)?.partial).toBe(true);
    expect(data.summary.daysWithBalance).toBe(2);
    expect(data.estimateGaps).toEqual([]);
  });

  it("answers the module notice with the module off", async () => {
    await signIn(false);
    const res = await read();
    expect(res.status).toBe(403);
  });

  it("refuses a window outside 7 to 90 days", async () => {
    await signIn(true);
    expect((await read(3)).status).toBe(422);
  });
});
