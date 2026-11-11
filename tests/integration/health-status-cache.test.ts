/**
 * `GET /api/insights/health-status` answers from the record's analytics cell,
 * against Postgres.
 *
 * Both engines behind the card walk every vital over up to 180 days, so a
 * second open of Insights serves the stored answer. A reading written past
 * the API (no sweep) is the witness: the cell still holds the answer from
 * before it. A measurement written through the API sweeps the cell, and a
 * module switch changes the key, so either one shows the reading. All data
 * invented.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as getHealthStatus } from "@/app/api/insights/health-status/route";
import { POST as createMeasurement } from "@/app/api/measurements/route";
import { PATCH as patchModules } from "@/app/api/auth/me/modules/route";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { startOfLocalDayInTz } from "@/lib/tz/local-day";

import { callRoute, type RouteAuth } from "../kit/call-route";
import { makeMeasurement, makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const TZ = "Europe/Berlin";
const DAY_MS = 86_400_000;
/** Well above the fortnight's 64 to 68 bpm, so the card reports it. */
const RAISED_PULSE = 112;

interface HealthStatusBody {
  present: boolean;
  deviations: Array<{ type: string; value: number }>;
  shifts: unknown[];
  generatedAt: string;
}

async function readHealthStatus(auth: RouteAuth) {
  const res = await callRoute<HealthStatusBody>(getHealthStatus, {
    method: "GET",
    route: "/api/insights/health-status",
    auth,
  });
  expect(res.status).toBe(200);
  return res.data;
}

/**
 * A fortnight of ordinary pulse and weight readings, one per earlier local
 * day at noon: the coincident engine needs two banded vitals before it
 * reports.
 */
async function seedFortnight(userId: string) {
  const todayStart = startOfLocalDayInTz(new Date(), TZ).getTime();
  const rows = [];
  for (let d = 14; d >= 1; d -= 1) {
    const measuredAt = new Date(todayStart - d * DAY_MS + DAY_MS / 2);
    rows.push(
      {
        userId,
        type: "PULSE" as const,
        value: 64 + (d % 5),
        unit: "bpm",
        measuredAt,
        source: "MANUAL" as const,
      },
      {
        userId,
        type: "WEIGHT" as const,
        value: 80 + (d % 3) * 0.2,
        unit: "kg",
        measuredAt,
        source: "MANUAL" as const,
      },
    );
  }
  await prisma.measurement.createMany({ data: rows });
}

async function signedInWithFortnight() {
  const user = await makeUser({ timezone: TZ });
  await seedFortnight(user.id);
  return { user, auth: await makeSession(user) };
}

const pulseDeviation = (body: HealthStatusBody) =>
  body.deviations.find((d) => d.type === "PULSE");

beforeEach(async () => {
  await truncateAllTables(prisma);
  __resetAllCachesForTests();
});

describe("GET /api/insights/health-status — the cached answer", () => {
  it("serves the second open from the cell", async () => {
    const { user, auth } = await signedInWithFortnight();
    const first = await readHealthStatus(auth);
    expect(pulseDeviation(first)).toBeUndefined();

    // Written past the API: nothing sweeps the cell.
    await makeMeasurement(user, {
      type: "PULSE",
      value: RAISED_PULSE,
      unit: "bpm",
      measuredAt: new Date(Date.now() - 60_000),
    });
    const second = await readHealthStatus(auth);

    expect(second).toEqual(first);
  });

  it("computes again after a measurement written through the API", async () => {
    const { auth } = await signedInWithFortnight();
    expect(pulseDeviation(await readHealthStatus(auth))).toBeUndefined();

    const write = await callRoute(createMeasurement, {
      method: "POST",
      route: "/api/measurements",
      body: {
        type: "PULSE",
        value: RAISED_PULSE,
        unit: "bpm",
        measuredAt: new Date(Date.now() - 60_000).toISOString(),
      },
      auth,
    });
    expect(write.status).toBe(201);

    expect(pulseDeviation(await readHealthStatus(auth))?.value).toBeCloseTo(
      RAISED_PULSE,
      6,
    );
  });

  it("computes again when a module is switched off", async () => {
    const { user, auth } = await signedInWithFortnight();
    expect(pulseDeviation(await readHealthStatus(auth))).toBeUndefined();

    await makeMeasurement(user, {
      type: "PULSE",
      value: RAISED_PULSE,
      unit: "bpm",
      measuredAt: new Date(Date.now() - 60_000),
    });
    const patch = await callRoute(patchModules, {
      method: "PATCH",
      route: "/api/auth/me/modules",
      body: { mood: false },
      auth,
    });
    expect(patch.status).toBe(200);

    expect(pulseDeviation(await readHealthStatus(auth))?.value).toBeCloseTo(
      RAISED_PULSE,
      6,
    );
  });
});
