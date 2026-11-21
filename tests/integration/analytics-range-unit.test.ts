/**
 * `/api/analytics/range` answers in the account's unit and names it: blood
 * glucose in its glucose unit (like `/api/measurements/series`), the
 * metric/imperial types in its unit system, against a real Postgres and the
 * real rollup read.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

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

const DAY = 24 * 60 * 60 * 1000;
const USER = "range-unit-user";
const prisma = getPrismaClient();

async function seed(prefs: { glucoseUnit?: string; unitPreference?: string }) {
  __resetAllCachesForTests();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC", ...prefs },
  });
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function reading(
  type: string,
  unit: string,
  daysAgo: number,
  value: number,
) {
  const at = new Date(Date.now() - daysAgo * DAY);
  at.setUTCHours(8, 0, 0, 0);
  await prisma.measurement.create({
    data: {
      userId: USER,
      type: type as never,
      value,
      unit,
      measuredAt: at,
      source: "MANUAL",
    },
  });
}

async function range(type: string) {
  const { GET } = await import("@/app/api/analytics/range/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/analytics/range?type=${type}&range=7d`,
    ),
  );
  expect(res.status).toBe(200);
  return (await res.json()).data as {
    unit: string;
    current: { mean: number | null; min: number | null };
    previous: { mean: number | null };
    delta: number | null;
  };
}

beforeEach(() => {
  __resetAllCachesForTests();
});

describe("/api/analytics/range in the account's unit", () => {
  it("serves glucose in mmol/L for an mmol/L account, delta included", async () => {
    await seed({ glucoseUnit: "mmol/L" });
    for (let d = 13; d >= 7; d--)
      await reading("BLOOD_GLUCOSE", "mg/dL", d, 90);
    for (let d = 6; d >= 1; d--)
      await reading("BLOOD_GLUCOSE", "mg/dL", d, 108);
    await recomputeUserRollups(USER, { granularities: ["DAY"] });

    const data = await range("BLOOD_GLUCOSE");
    expect(data.unit).toBe("mmol/L");
    expect(data.current.mean).toBeCloseTo(6.0, 1);
    expect(data.previous.mean).toBeCloseTo(5.0, 1);
    expect(data.delta).toBeCloseTo(1.0, 1);
  });

  it("keeps mg/dL, and says so, for an mg/dL account", async () => {
    await seed({ glucoseUnit: "mg/dL" });
    for (let d = 6; d >= 1; d--)
      await reading("BLOOD_GLUCOSE", "mg/dL", d, 108);
    await recomputeUserRollups(USER, { granularities: ["DAY"] });
    const data = await range("BLOOD_GLUCOSE");
    expect(data.unit).toBe("mg/dL");
    expect(data.current.mean).toBeCloseTo(108, 0);
  });

  it("serves weight in pounds for an imperial account and in kg otherwise", async () => {
    await seed({ unitPreference: "imperial" });
    for (let d = 6; d >= 1; d--) await reading("WEIGHT", "kg", d, 80);
    await recomputeUserRollups(USER, { granularities: ["DAY"] });
    const imperial = await range("WEIGHT");
    expect(imperial.unit).toBe("lb");
    expect(imperial.current.mean).toBeCloseTo(176.4, 1);

    await seed({});
    for (let d = 6; d >= 1; d--) await reading("WEIGHT", "kg", d, 80);
    await recomputeUserRollups(USER, { granularities: ["DAY"] });
    const metric = await range("WEIGHT");
    expect(metric.unit).toBe("kg");
    expect(metric.current.mean).toBeCloseTo(80, 1);
  });
});
