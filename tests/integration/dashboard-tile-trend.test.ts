/**
 * #176 — the dashboard tile's trend and the metric page's delta agree.
 *
 * The weight tile used to read its arrow first-to-last off the last seven
 * daily buckets while the page compared this month's mean with last month's,
 * so the same visit could show a falling arrow on the tile and "+0.1 kg vs
 * last month" on the page. The tile now takes its trend from the same
 * month-over-month comparison (`computeRangeDelta(..., "30d")` and
 * `rangeTrend`), and says which window it used.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-dashboard-tile-trend-integration-1234567890abcdef";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER = "user-dashboard-tile-trend";
const DAY = 86_400_000;

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

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC" },
  });
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

/** One weight reading a day, `daysAgo` days back at 07:00 UTC. */
async function weigh(daysAgo: number, kg: number) {
  const day = new Date(Date.now() - daysAgo * DAY);
  day.setUTCHours(7, 0, 0, 0);
  await prisma.measurement.create({
    data: {
      userId: USER,
      type: "WEIGHT",
      value: kg,
      unit: "kg",
      measuredAt: day,
      source: "MANUAL",
    },
  });
}

async function json(path: string, handler: unknown): Promise<unknown> {
  const res = await (handler as (r: NextRequest) => Promise<Response>)(
    new NextRequest(`http://localhost${path}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

describe("weight tile trend vs the metric page", () => {
  it("points the way the month-over-month delta does, and names the window", async () => {
    // Last month around 80.0 kg; this month around 80.2 kg, but the last
    // week slips from 80.6 to 80.0. First-to-last over seven days reads
    // "down"; this month against last month is up.
    for (let d = 59; d >= 30; d--) await weigh(d, 80);
    for (let d = 29; d >= 7; d--) await weigh(d, 80.1);
    const lastWeek = [80.6, 80.5, 80.4, 80.3, 80.2, 80.1, 80.0];
    for (let i = 0; i < 7; i++) await weigh(6 - i, lastWeek[i]);
    await recomputeUserRollups(USER, { granularities: ["DAY"] });

    const range = (await json(
      "/api/analytics/range?type=WEIGHT&range=30d",
      (await import("@/app/api/analytics/range/route")).GET,
    )) as { delta: number; trend: string };
    expect(range.delta).toBeGreaterThan(0);
    expect(range.trend).toBe("up");

    const summary = (await json(
      "/api/dashboard/summary",
      (await import("@/app/api/dashboard/summary/route")).GET,
    )) as {
      metrics: Array<{ kind: string; trend: string; trendWindowDays: number }>;
    };
    const weight = summary.metrics.find((m) => m.kind === "weight");
    expect(weight?.trend).toBe(range.trend);
    expect(weight?.trendWindowDays).toBe(30);
  });

  it("falls back to the seven-day line, and says so, without a previous month", async () => {
    for (let d = 6; d >= 0; d--) await weigh(d, 80 + d / 10);
    await recomputeUserRollups(USER, { granularities: ["DAY"] });

    const summary = (await json(
      "/api/dashboard/summary",
      (await import("@/app/api/dashboard/summary/route")).GET,
    )) as {
      metrics: Array<{ kind: string; trend: string; trendWindowDays: unknown }>;
    };
    const weight = summary.metrics.find((m) => m.kind === "weight");
    expect(weight?.trend).toBe("down");
    expect(weight?.trendWindowDays).toBeNull();
  });
});
