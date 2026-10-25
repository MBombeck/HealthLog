/**
 * The Insights baseline-drift read, driven as a route against real Postgres.
 *
 * The unit suite pins the arithmetic; this pins the pipe. A stored pulse value
 * the application declares impossible used to reach the card twice over — once
 * as "currently", once through the band it inflated — and the line read
 * "your pulse is above your usual range, currently 111,287,531.01 instead of
 * the usual 36,016.75". The shipped `GET` export answers here, so the readers
 * really have to apply the domain rather than a test's copy of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { startOfLocalDayInTz } from "@/lib/tz/local-day";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
/** The two numbers off the report, kept verbatim so the case stays legible. */
const IMPOSSIBLE_PULSE = 111287531.01;
/** A raised but real pulse, so the card has a genuine deviation to report. */
const REAL_RAISED_PULSE = 112;

let counter = 0;

async function makeUser() {
  const suffix = `hs-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `hs-${suffix}`,
      email: `hs-${suffix}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

/** A fortnight of ordinary readings for one metric, one per day. */
async function seedDaily(
  userId: string,
  type: "PULSE" | "WEIGHT",
  valueFor: (dayIndex: number) => number,
) {
  // Noon of each earlier local day: `now - d days` is still today on the
  // 25-hour day of an autumn DST change, and the card then reads yesterday's
  // value as one of today's.
  const todayStart = startOfLocalDayInTz(new Date(), "Europe/Berlin").getTime();
  const rows = [];
  for (let d = 14; d >= 1; d -= 1) {
    rows.push({
      userId,
      type,
      value: valueFor(d),
      unit: type === "PULSE" ? "bpm" : "kg",
      measuredAt: new Date(todayStart - d * DAY_MS + DAY_MS / 2),
      source: "MANUAL" as const,
    });
  }
  await getPrismaClient().measurement.createMany({ data: rows });
}

async function readHealthStatus() {
  const { GET } = await import("@/app/api/insights/health-status/route");
  const response = await (GET as (request: NextRequest) => Promise<Response>)(
    new NextRequest("http://localhost/api/insights/health-status", {
      method: "GET",
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: {
      present: boolean;
      deviations: {
        type: string;
        value: number;
        low: number;
        high: number;
      }[];
    };
  };
  return body.data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("GET /api/insights/health-status — implausible stored values", () => {
  it("reports today's real pulse, not the impossible row beside it", async () => {
    const user = await makeUser();
    await signIn(user.id);
    // Two banded vitals — the coincident engine needs a pair before it reports.
    await seedDaily(user.id, "PULSE", (d) => 64 + (d % 5));
    await seedDaily(user.id, "WEIGHT", (d) => 80 + (d % 3) * 0.2);
    // Today: a genuinely raised pulse — so the card has something real to say —
    // and beside it one impossible reading, the shape a provider unit-decode
    // slip leaves behind.
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "PULSE",
          value: REAL_RAISED_PULSE,
          unit: "bpm",
          measuredAt: new Date(Date.now() - 120_000),
          source: "MANUAL",
        },
        {
          userId: user.id,
          type: "PULSE",
          value: IMPOSSIBLE_PULSE,
          unit: "bpm",
          measuredAt: new Date(Date.now() - 60_000),
          source: "MANUAL",
        },
      ],
    });

    const data = await readHealthStatus();

    const pulse = data.deviations.find((d) => d.type === "PULSE");
    // The deviation has to be there — otherwise this asserts nothing.
    expect(pulse).toBeDefined();
    expect(pulse!.value).toBeCloseTo(REAL_RAISED_PULSE, 6);
    expect(pulse!.high).toBeLessThan(300);
    expect(pulse!.low).toBeGreaterThanOrEqual(20);
    // And the impossible number itself never reaches the wire.
    expect(JSON.stringify(data)).not.toContain(String(IMPOSSIBLE_PULSE));
  });
});
