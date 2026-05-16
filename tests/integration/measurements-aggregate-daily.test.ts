/**
 * v1.4.29 C2 — `aggregate=daily` against a real Postgres.
 *
 * The mocked-`$queryRaw` unit test in
 * `src/app/api/measurements/__tests__/range-aggregation-route.test.ts`
 * passes because nothing exercises the actual SQL. In production the
 * `date_trunc(${truncUnit}, …)` call 500'd for every grain because
 * Postgres rejects a bound parameter for `date_trunc`'s unit argument.
 *
 * This suite hits the route against a real database so the SQL has
 * to compile + execute. It would fail on the pre-fix code and passes
 * after switching `${truncUnit}` from a bound parameter to a SQL
 * literal via `Prisma.raw`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-aggregate-daily-test";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "aggregate-daily",
      email: "aggregate-daily@example.test",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements?${query}`, {
    method: "GET",
  });
}

describe("GET /api/measurements?aggregate=… (real Postgres)", () => {
  it("returns bucketed rows for grain=daily without 500'ing on date_trunc", async () => {
    // Two pulse rows on the same calendar day plus one on a second
    // day — three rows total, two distinct daily buckets.
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 60,
          unit: "bpm",
          source: "MANUAL",
          measuredAt: new Date("2026-05-01T08:00:00.000Z"),
        },
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 80,
          unit: "bpm",
          source: "MANUAL",
          measuredAt: new Date("2026-05-01T20:00:00.000Z"),
        },
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 70,
          unit: "bpm",
          source: "MANUAL",
          measuredAt: new Date("2026-05-02T12:00:00.000Z"),
        },
      ],
    });

    const { GET } = await import("@/app/api/measurements/route");
    const response = await GET(
      getRequest(
        "type=PULSE&from=2026-05-01T00:00:00Z&to=2026-05-03T00:00:00Z&aggregate=daily&limit=365",
      ),
    );

    // Pre-fix the response was 500; post-fix it must be 200 with two
    // daily buckets.
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: {
        measurements: Array<{
          type: string;
          value: number;
          measuredAt: string;
          count: number;
        }>;
        meta: { aggregate?: string };
      };
    };
    expect(json.data.meta.aggregate).toBe("daily");
    expect(json.data.measurements).toHaveLength(2);

    const may1 = json.data.measurements.find((m) =>
      m.measuredAt.startsWith("2026-05-01"),
    );
    const may2 = json.data.measurements.find((m) =>
      m.measuredAt.startsWith("2026-05-02"),
    );
    expect(may1).toBeDefined();
    expect(may1!.count).toBe(2);
    expect(may2).toBeDefined();
    expect(may2!.count).toBe(1);
  });

  it("returns bucketed rows for grain=weekly", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/measurements/route");
    const response = await GET(
      getRequest(
        "type=WEIGHT&from=2026-04-01T00:00:00Z&to=2026-05-30T00:00:00Z&aggregate=weekly&limit=105",
      ),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: { meta: { aggregate?: string } };
    };
    expect(json.data.meta.aggregate).toBe("weekly");
  });

  it("returns bucketed rows for grain=monthly", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/measurements/route");
    const response = await GET(
      getRequest(
        "type=WEIGHT&from=2025-01-01T00:00:00Z&to=2026-05-30T00:00:00Z&aggregate=monthly&limit=24",
      ),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: { meta: { aggregate?: string } };
    };
    expect(json.data.meta.aggregate).toBe("monthly");
  });

  // v1.4.29 — cumulative HK types (steps, active energy, flights,
  // distance, daylight) must aggregate with SUM, not AVG. Five rows
  // of 1000 steps each on the same day must collapse to 5000, not
  // 1000. See R-A finding 2.
  it("sums cumulative HK types instead of averaging", async () => {
    const prisma = getPrismaClient();
    const baseTime = new Date("2026-05-01T08:00:00.000Z").getTime();
    await prisma.measurement.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS" as const,
        value: 1000,
        unit: "steps",
        source: "MANUAL" as const,
        measuredAt: new Date(baseTime + i * 60 * 60 * 1000),
      })),
    });

    const { GET } = await import("@/app/api/measurements/route");
    const response = await GET(
      getRequest(
        "type=ACTIVITY_STEPS&from=2026-05-01T00:00:00Z&to=2026-05-02T00:00:00Z&aggregate=daily&limit=365",
      ),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: {
        measurements: Array<{ value: number; count: number }>;
      };
    };
    expect(json.data.measurements).toHaveLength(1);
    expect(json.data.measurements[0].value).toBe(5000);
    expect(json.data.measurements[0].count).toBe(5);
  });

  it("averages spot types (pulse) rather than summing", async () => {
    // Belt-and-braces guard so a future refactor that mis-wires the
    // SUM branch back across every type catches loudly here.
    const prisma = getPrismaClient();
    const baseTime = new Date("2026-05-01T08:00:00.000Z").getTime();
    await prisma.measurement.createMany({
      data: [60, 70, 80].map((v, i) => ({
        userId: TEST_USER_ID,
        type: "PULSE" as const,
        value: v,
        unit: "bpm",
        source: "MANUAL" as const,
        measuredAt: new Date(baseTime + i * 60 * 60 * 1000),
      })),
    });

    const { GET } = await import("@/app/api/measurements/route");
    const response = await GET(
      getRequest(
        "type=PULSE&from=2026-05-01T00:00:00Z&to=2026-05-02T00:00:00Z&aggregate=daily&limit=365",
      ),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: { measurements: Array<{ value: number }> };
    };
    expect(json.data.measurements).toHaveLength(1);
    expect(json.data.measurements[0].value).toBe(70); // (60+70+80)/3
  });
});
