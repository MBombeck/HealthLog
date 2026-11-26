/**
 * A device's recovery chart reads that device alone.
 *
 * `RECOVERY_SCORE` is written by WHOOP, Oura and Polar and by the nightly
 * readiness job (`COMPUTED`). The chart's daily series picks one canonical
 * source per day, so on a day the band did not deliver the proxy fills in,
 * and a chart titled "WHOOP Recovery" would draw HealthLog's own number on
 * that day. `sourceEq` on the chart's series read narrows it to one source,
 * on the short daily path and on the long "All" path alike.
 *
 * The request is built by the chart's own `chartSeriesParams`, so the
 * parameter the client sends is the one the route honours.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { chartSeriesParams } from "@/components/charts/chart-series-request";
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

const prisma = getPrismaClient();
const USER = "device-recovery-series";
const DAY = 86_400_000;
const NOW = new Date();
const TODAY_NOON_UTC = Date.UTC(
  NOW.getUTCFullYear(),
  NOW.getUTCMonth(),
  NOW.getUTCDate(),
  12,
);
const at = (daysBack: number) => new Date(TODAY_NOON_UTC - daysBack * DAY);

async function read(days: number, sourceEq?: string) {
  const s = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
  const params = chartSeriesParams(
    "RECOVERY_SCORE",
    {
      from: new Date(TODAY_NOON_UTC - days * DAY).toISOString(),
      to: new Date(TODAY_NOON_UTC + DAY).toISOString(),
    },
    undefined,
    sourceEq,
  );
  const { GET } = await import("@/app/api/measurements/route");
  const res = await GET(
    new NextRequest(`http://localhost/api/measurements?${params}`),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    data: { measurements: Array<{ value: number; measuredAt: string }> };
  };
  return json.data.measurements;
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC" },
  });
  invalidateUserTimezone(USER);
  const rows = [];
  // The proxy writes every day; the band delivered on days 1, 2 and 4 only,
  // and once 500 days ago.
  for (const d of [1, 2, 3, 4, 5]) {
    rows.push({ source: "COMPUTED" as const, value: 40, measuredAt: at(d) });
  }
  for (const d of [1, 2, 4, 500]) {
    rows.push({ source: "WHOOP" as const, value: 80 + d, measuredAt: at(d) });
  }
  await prisma.measurement.createMany({
    data: rows.map((r, i) => ({
      id: `drs-${i}`,
      userId: USER,
      type: "RECOVERY_SCORE" as const,
      unit: "score",
      ...r,
    })),
  });
});

describe("device recovery series", () => {
  it("without a source the canonical pick fills the band's gaps with the proxy", async () => {
    const all = await read(30);
    expect(all).toHaveLength(5);
    expect(all.some((p) => p.value === 40)).toBe(true);
  });

  it("with the device's source it draws the band's own days only", async () => {
    const whoop = await read(30, "WHOOP");
    expect(whoop.map((p) => p.value).sort()).toEqual([81, 82, 84]);
  });

  it("keeps to the source over a window longer than the daily cap", async () => {
    const whoop = await read(800, "WHOOP");
    expect(whoop.length).toBeGreaterThan(0);
    expect(whoop.every((p) => p.value > 80)).toBe(true);
    expect(whoop.some((p) => p.value === 580)).toBe(true);
  });

  it("answers an empty series for a source that never wrote", async () => {
    expect(await read(30, "OURA")).toEqual([]);
  });
});
