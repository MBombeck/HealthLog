/**
 * v1.4.25 W8c — two-axis source-priority resolution, end-to-end.
 *
 * Wave 8c lays down a per-user, per-metric, per-device-type canonical
 * picker. The picker is unit-tested at the helper level; this file
 * locks the integration path: a user with both axes set in
 * `User.sourcePriorityJson`, multiple Measurement rows for the same
 * day across sources + device-types, and the analytics route's
 * SLEEP_DURATION aggregator picking exactly the canonical row.
 *
 * Three fixtures, all on the same Berlin day:
 *
 *   1. Plain default user — only Withings rows. The picker is a
 *      pass-through; the route returns the raw total. Locks the
 *      v1.4.25-today behaviour against regressions.
 *
 *   2. Per-metric override — Withings + Apple Health both contributed
 *      sleep for the same night. The user's per-metric ladder pins
 *      Withings first (default for sleep is Apple Health > Withings),
 *      so the route should report Withings' total only.
 *
 *   3. Per-device override — Apple Watch + iPhone both wrote sleep
 *      rows under APPLE_HEALTH. The default device-type ladder ranks
 *      watch above phone, so the route should pick the watch row and
 *      drop the iPhone row.
 *
 * Sleep is the right metric to verify end-to-end because the
 * analytics route's sleep aggregation is the only call site of
 * `pickCanonicalSourceRows()` today; this test guards the wire-up
 * without needing a new aggregator.
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface AnalyticsEnvelope {
  data: {
    summaries: Record<
      string,
      { count: number; latest: number | null; mean: number | null }
    >;
  };
}

async function seedUserWithSession(
  username: string,
  sourcePriorityJson?: unknown,
) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      ...(sourcePriorityJson !== undefined
        ? {
            sourcePriorityJson:
              sourcePriorityJson as import("@/generated/prisma/client").Prisma.InputJsonValue,
          }
        : {}),
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

async function callAnalytics(): Promise<AnalyticsEnvelope> {
  const { GET } = await import("@/app/api/analytics/route");
  const response = await (
    GET as unknown as (req: Request) => Promise<Response>
  )(new Request("http://localhost/api/analytics"));
  expect(response.status).toBe(200);
  return (await response.json()) as AnalyticsEnvelope;
}

describe("GET /api/analytics — two-axis canonical source resolution (W8c)", () => {
  it("plain default user: single-source rows pass through unchanged", async () => {
    // Locks the v1.4.25-today behaviour: a user with no override and
    // only one source per metric should see the raw daily total.
    const prisma = getPrismaClient();
    const user = await seedUserWithSession("plain-default");

    // 420 minutes of sleep, one Withings row, no override.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 420,
        unit: "minutes",
        source: "WITHINGS",
        measuredAt: new Date("2026-05-12T07:00:00.000Z"),
      },
    });

    const envelope = await callAnalytics();
    const summary = envelope.data.summaries.SLEEP_DURATION;
    expect(summary.count).toBe(1);
    expect(summary.latest).toBe(420);
  });

  it("per-metric override pins Withings first when Apple Health also reported sleep", async () => {
    // Same night, both sources contributed sleep duration. Without an
    // override the default ladder (APPLE_HEALTH > WITHINGS) would win;
    // with the override the picker returns the Withings row instead.
    const prisma = getPrismaClient();
    const user = await seedUserWithSession("per-metric-override", {
      metricPriority: {
        sleep: ["WITHINGS", "APPLE_HEALTH"],
      },
    });

    // Apple Health stage row — 480 minutes total.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 480,
        unit: "minutes",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-12T06:00:00.000Z"),
        externalId: "ah-sleep-1",
      },
    });
    // Withings nightly summary — 410 minutes.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 410,
        unit: "minutes",
        source: "WITHINGS",
        measuredAt: new Date("2026-05-12T07:00:00.000Z"),
      },
    });

    const envelope = await callAnalytics();
    const summary = envelope.data.summaries.SLEEP_DURATION;
    // One canonical night (the Withings row); the Apple Health row is
    // dropped from the aggregation but still lives in the DB.
    expect(summary.count).toBe(1);
    expect(summary.latest).toBe(410);
  });

  it("per-device override drops iPhone rows in favour of Apple Watch rows", async () => {
    // Same source, same night — but Apple Watch and iPhone both wrote
    // sleep samples. The default device-type ladder ranks watch above
    // phone, so the watch row should survive.
    const prisma = getPrismaClient();
    const user = await seedUserWithSession("per-device-override");

    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 480,
        unit: "minutes",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-12T06:00:00.000Z"),
        externalId: "ah-sleep-watch",
        deviceType: "watch",
      },
    });
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 380,
        unit: "minutes",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-12T06:30:00.000Z"),
        externalId: "ah-sleep-phone",
        deviceType: "phone",
      },
    });

    const envelope = await callAnalytics();
    const summary = envelope.data.summaries.SLEEP_DURATION;
    // Watch wins; the phone row drops out of the aggregate.
    expect(summary.count).toBe(1);
    expect(summary.latest).toBe(480);
  });

  it("user override flips device-type ladder so phone wins", async () => {
    // Same fixture as the previous test, but the user pinned phone
    // first via the deviceTypePriority.default ladder.
    const prisma = getPrismaClient();
    const user = await seedUserWithSession("phone-first", {
      deviceTypePriority: { default: ["phone", "watch"] },
    });

    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 480,
        unit: "minutes",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-12T06:00:00.000Z"),
        externalId: "ah-sleep-watch",
        deviceType: "watch",
      },
    });
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 380,
        unit: "minutes",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-12T06:30:00.000Z"),
        externalId: "ah-sleep-phone",
        deviceType: "phone",
      },
    });

    const envelope = await callAnalytics();
    const summary = envelope.data.summaries.SLEEP_DURATION;
    expect(summary.count).toBe(1);
    expect(summary.latest).toBe(380);
  });
});
