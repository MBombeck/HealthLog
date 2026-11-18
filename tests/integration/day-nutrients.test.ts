/**
 * The day carries its nutrient totals (`GET /api/day/{date}` → `nutrients`),
 * summed across sources the way the nutrients page sums them, and only with
 * the nutrients module on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const DAY = "2026-11-10";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(nutrients: boolean): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "day-nutrients-owner",
      email: "day-nutrients-owner@example.test",
      timezone: "UTC",
      modulePreferencesJson: { nutrients },
    },
  });
  const session = await prisma.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  await prisma.nutrientIntakeDay.createMany({
    data: [
      // A tracker and Apple Health report the same meals: the larger counts.
      {
        userId: owner.id,
        day: DAY,
        nutrient: "protein",
        amount: 82.5,
        unit: "g",
        source: "EXTERNAL",
      },
      {
        userId: owner.id,
        day: DAY,
        nutrient: "protein",
        amount: 80,
        unit: "g",
        source: "APPLE_HEALTH",
      },
      // Manual water adds to the synced total.
      {
        userId: owner.id,
        day: DAY,
        nutrient: "water",
        amount: 1200,
        unit: "ml",
        source: "APPLE_HEALTH",
      },
      {
        userId: owner.id,
        day: DAY,
        nutrient: "water",
        amount: 250,
        unit: "ml",
        source: "MANUAL",
      },
      // Another day stays out.
      {
        userId: owner.id,
        day: "2026-11-09",
        nutrient: "energy",
        amount: 2000,
        unit: "kcal",
        source: "EXTERNAL",
      },
    ],
  });
  return owner.id;
}

async function readDay() {
  const { GET } = await import("@/app/api/day/[date]/route");
  const res = await GET(
    new Request(`http://localhost/api/day/${DAY}`) as never,
    {
      params: Promise.resolve({ date: DAY }),
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    data: { nutrients?: Array<{ code: string; amount: number; unit: string }> };
  };
}

describe("the day's nutrient totals", () => {
  it("sums the day across sources and leaves other days out", async () => {
    await signIn(true);
    const body = await readDay();
    const byCode = Object.fromEntries(
      (body.data.nutrients ?? []).map((n) => [n.code, n]),
    );
    expect(Object.keys(byCode).sort()).toEqual(["protein", "water"]);
    expect(byCode.protein.amount).toBe(82.5);
    expect(byCode.water.amount).toBe(1450);
  });

  it("is absent with the nutrients module off", async () => {
    await signIn(false);
    const body = await readDay();
    expect(body.data.nutrients).toBeUndefined();
  });
});
