/**
 * The chart's own request, against the real route, on a dense stream.
 *
 * The 7-day range used to ask for raw rows oldest-first with a 5 000-row
 * limit. Per-minute heart rate puts 10 080 rows in seven days, so the answer
 * stopped about three and a half days in and the chart silently lost the
 * most recent days. Every range now asks for one row per local day, so the
 * whole window arrives whatever the sampling rate.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { chartSeriesParams } from "@/components/charts/chart-series-request";
import { userDayKey } from "@/lib/tz/format";
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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const USER = "chart-range-dense-user";
const TZ = "Europe/Berlin";
const TO = new Date("2026-09-20T18:00:00.000Z");
const MINUTES = 7 * 24 * 60;

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: TZ },
  });
  invalidateUserTimezone(USER);
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at,
       created_at, updated_at, sync_version)
     SELECT 'cr' || lpad(g::text, 6, '0'), $1, 'PULSE'::measurement_type,
       60 + (g % 30), 'bpm', 'GOOGLE_HEALTH'::measurement_source,
       ($2::timestamptz AT TIME ZONE 'UTC') - (g * interval '1 minute'),
       now(), now(), 1
     FROM generate_series(0, $3::int - 1) g`,
    USER,
    TO.toISOString(),
    MINUTES,
  );
}, 120_000);

describe("7-day chart range on per-minute pulse", () => {
  it("returns every day of the window, the newest included", async () => {
    const from = new Date(TO.getTime() - 7 * 86_400_000);
    const params = chartSeriesParams("PULSE", {
      from: from.toISOString(),
      to: TO.toISOString(),
    });
    const { GET } = await import("@/app/api/measurements/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/measurements?${params}`),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { measurements: Array<{ measuredAt: string }> };
    };
    const days = new Set(
      json.data.measurements.map((m) => userDayKey(new Date(m.measuredAt), TZ)),
    );
    // 20 Sep 20:00 Berlin back to 13 Sep 20:00: eight calendar days.
    expect([...days].sort()).toEqual([
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ]);
  });
});
