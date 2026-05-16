/**
 * v1.4.35 — integration coverage for the comprehensive insights cache.
 *
 * Pins two contracts the unit suite cannot reach:
 *
 *   1. **Read-through cache.** Priming with one call counts as a
 *      miss; the second call inside the 60-second TTL counts as a hit
 *      and annotates `cache.analytics.outcome === "hit"` on the route's
 *      wide event.
 *
 *   2. **SQL aggregation parity end-to-end.** The route's envelope
 *      includes every legacy key (summaries / bmi / bp* / mood* /
 *      medications / alerts / hasProvider / dataSpanDays /
 *      totalMeasurements) computed from a fixture of ~50 measurement
 *      rows. The byte-shape matches what the consumer (/insights page)
 *      reads on first paint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// `resolveProvider` reads `app_settings.default_locale` which trails the
// production schema in this integration env. Mock the leaf: the route
// only uses `provider.type !== "none"` to set the `hasProvider` flag.
vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn().mockResolvedValue({ type: "none" }),
}));

import { clearLogBuffer, readLogBuffer } from "@/lib/logging/in-memory-buffer";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  clearLogBuffer();
  const { __resetAllCachesForTests } = await import(
    "@/lib/cache/server-cache"
  );
  __resetAllCachesForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      heightCm: 180,
      dateOfBirth: new Date("1985-01-01"),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

describe("GET /api/insights/comprehensive — server cache", () => {
  it("returns a hit on the second call inside the TTL", async () => {
    const user = await seedSession("comp-cache-hit-user");
    const prisma = getPrismaClient();

    // Seed ~50 rows so the aggregator has data to return.
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const weightRows = Array.from({ length: 30 }, (_, i) => ({
      userId: user.id,
      type: "WEIGHT" as const,
      value: 80 + (i % 5) * 0.2,
      unit: "kg",
      source: "MANUAL" as const,
      measuredAt: new Date(now - i * DAY_MS),
    }));
    const sysRows = Array.from({ length: 10 }, (_, i) => ({
      userId: user.id,
      type: "BLOOD_PRESSURE_SYS" as const,
      value: 120 + i,
      unit: "mmHg",
      source: "MANUAL" as const,
      measuredAt: new Date(now - i * DAY_MS),
    }));
    const diaRows = Array.from({ length: 10 }, (_, i) => ({
      userId: user.id,
      type: "BLOOD_PRESSURE_DIA" as const,
      value: 75 + i,
      unit: "mmHg",
      source: "MANUAL" as const,
      measuredAt: new Date(now - i * DAY_MS),
    }));
    await prisma.measurement.createMany({
      data: [...weightRows, ...sysRows, ...diaRows],
    });

    const { GET } = await import("@/app/api/insights/comprehensive/route");
    const { caches } = await import("@/lib/cache/server-cache");

    const first = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/insights/comprehensive"));
    expect(first.status).toBe(200);
    expect(caches.analytics.stats().misses).toBe(1);
    expect(caches.analytics.stats().hits).toBe(0);

    // Second call inside the TTL — hit.
    const second = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/insights/comprehensive"));
    expect(second.status).toBe(200);
    expect(caches.analytics.stats().hits).toBe(1);

    // The wide-event annotation carries the cache outcome on the hit.
    const events = readLogBuffer({});
    const cacheEvent = events.find(
      (e) =>
        (e?.meta as Record<string, unknown> | undefined)?.[
          "cache.analytics.outcome"
        ] === "hit",
    );
    expect(cacheEvent).toBeDefined();
  });

  it("emits every legacy envelope key with real SQL aggregation", async () => {
    const user = await seedSession("comp-cache-shape-user");
    const prisma = getPrismaClient();

    // A tight fixture: 5 paired BP readings + 5 weight rows + 5 mood
    // entries spread across 5 distinct days. Enough to populate every
    // correlation block (n >= 5 is the pearsonCorrelation gate).
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const dayDates = Array.from(
      { length: 5 },
      (_, i) => new Date(now - i * DAY_MS),
    );
    await prisma.measurement.createMany({
      data: [
        // Sys + dia at exactly the same instant (5-min tolerance auto-passes)
        ...dayDates.flatMap((d, i) => [
          {
            userId: user.id,
            type: "BLOOD_PRESSURE_SYS" as const,
            value: 120 + i,
            unit: "mmHg",
            source: "MANUAL" as const,
            measuredAt: d,
          },
          {
            userId: user.id,
            type: "BLOOD_PRESSURE_DIA" as const,
            value: 75 + i,
            unit: "mmHg",
            source: "MANUAL" as const,
            measuredAt: d,
          },
        ]),
        ...dayDates.map((d, i) => ({
          userId: user.id,
          type: "WEIGHT" as const,
          value: 80 + i,
          unit: "kg",
          source: "MANUAL" as const,
          measuredAt: d,
        })),
        ...dayDates.map((d, i) => ({
          userId: user.id,
          type: "PULSE" as const,
          value: 65 + i,
          unit: "bpm",
          source: "MANUAL" as const,
          measuredAt: d,
        })),
      ],
    });

    await prisma.moodEntry.createMany({
      data: dayDates.map((d, i) => ({
        userId: user.id,
        date: d.toISOString().slice(0, 10),
        mood: "GUT",
        score: 3 + (i % 3),
        moodLoggedAt: d,
      })),
    });

    const { GET } = await import("@/app/api/insights/comprehensive/route");

    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/insights/comprehensive"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: Record<string, unknown> & {
        summaries: Record<
          string,
          { count: number; latest: number | null; mean: number | null } | undefined
        >;
        totalMeasurements: number;
        bpPctInTarget: number | null;
        bpClassification: { category: string } | null;
        bmi: number | null;
      };
    };

    // Every legacy key still present.
    const legacyKeys = [
      "summaries",
      "bmi",
      "bmiClassification",
      "bpClassification",
      "bpPctInTarget",
      "bpTargets",
      "weightBpCorrelation",
      "scatterData",
      "bpMedicationCorrelation",
      "bpMedicationScatterData",
      "moodSummary",
      "moodBpCorrelation",
      "moodBpScatterData",
      "moodWeightCorrelation",
      "moodWeightScatterData",
      "moodPulseCorrelation",
      "moodPulseScatterData",
      "medications",
      "alerts",
      "hasProvider",
      "dataSpanDays",
      "totalMeasurements",
    ];
    for (const key of legacyKeys) {
      expect(body.data).toHaveProperty(key);
    }

    // Sanity-check the aggregator's numbers.
    expect(body.data.summaries.WEIGHT?.count).toBe(5);
    expect(body.data.summaries.BLOOD_PRESSURE_SYS?.count).toBe(5);
    expect(body.data.summaries.PULSE?.count).toBe(5);
    // 5 SYS + 5 DIA + 5 WEIGHT + 5 PULSE = 20 measurement rows. Mood
    // entries live on `moodEntries` and don't count toward this field
    // (matches legacy semantics).
    expect(body.data.totalMeasurements).toBe(20);
    // bpPctInTarget: 120-124/75-79 all inside under-65 ceiling.
    expect(body.data.bpPctInTarget).toBe(100);
    // BMI: latest weight = 80 (newest day, smallest i) at 1.80m → 24.7.
    expect(body.data.bmi).toBeCloseTo(24.7, 1);
  });
});
