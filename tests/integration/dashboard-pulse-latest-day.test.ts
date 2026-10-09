/**
 * "Pulse" names one statistic on the dashboard and in the day view.
 *
 * The dashboard's pulse tile led with the latest single reading while the day
 * view showed the day's pulse as the mean of its local hours' means. The slim
 * summaries slice now reports `latest` of an hourly-mean type as the value of
 * its latest local day, through the day view's own canonical-source pick and
 * the shared day-mean helper, so the two read the same number for one day.
 *
 * The day (three weeks back, Europe/Berlin): three readings at 60 in one
 * hour, one at 90 in the next, and a last one at 70 an hour later. Hour means
 * 60, 90 and 70: the day's pulse is 73.33. The latest reading is 70, the plain
 * mean of the five readings 68.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const USER = "pulse-latest-day";
const now = new Date();
/** UTC midnight three weeks back; 08:00Z is 10:00 in Berlin in any season. */
const D = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate() - 21,
);
const at = (h: number, m: number) => new Date(D + h * 3_600_000 + m * 60_000);
const DAY_KEY = new Date(D).toISOString().slice(0, 10);

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "Europe/Berlin",
      locale: "en",
    },
  });
  invalidateUserTimezone(USER);
  const readings: Array<[Date, number]> = [
    [at(8, 0), 60],
    [at(8, 20), 60],
    [at(8, 40), 60],
    [at(9, 10), 90],
    [at(10, 5), 70],
  ];
  await prisma.measurement.createMany({
    data: readings.map(([measuredAt, value], i) => ({
      id: `${USER}-${i}`,
      userId: USER,
      type: "PULSE",
      unit: "bpm",
      source: "APPLE_HEALTH",
      value,
      measuredAt,
    })),
  });
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}, 120_000);

describe("the dashboard's pulse and the day view's pulse", () => {
  it("report the latest day's value, not its latest reading", async () => {
    const { computeSummariesSlice } =
      await import("@/lib/analytics/summaries-slice");
    const slice = await computeSummariesSlice(USER);
    expect(slice.summaries.PULSE.latest).toBeCloseTo(220 / 3, 6);
  });

  it("is the number the day view shows for that day", async () => {
    const { GET } = await import("@/app/api/day/[date]/route");
    const res = await (
      GET as unknown as (
        req: NextRequest,
        ctx: { params: Promise<{ date: string }> },
      ) => Promise<Response>
    )(new NextRequest(`http://localhost/api/day/${DAY_KEY}`), {
      params: Promise.resolve({ date: DAY_KEY }),
    });
    expect(res.status).toBe(200);
    const day = (
      (await res.json()) as {
        data: { values: Array<{ type: string; value: number }> };
      }
    ).data;
    const pulse = day.values.find((v) => v.type === "PULSE");
    expect(pulse?.value).toBeCloseTo(73.33, 2);

    const { computeSummariesSlice } =
      await import("@/lib/analytics/summaries-slice");
    const slice = await computeSummariesSlice(USER);
    expect(Math.round(slice.summaries.PULSE.latest! * 100) / 100).toBe(
      pulse?.value,
    );
  });
});
