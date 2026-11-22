/**
 * Two rules of `POST /api/measurements/batch` for `stats:` day totals
 * (iOS #191), against real Postgres.
 *
 *   - A day whose samples were all deleted in Apple Health is sent once more
 *     with `value: 0`. That is a real total for every cumulative type, so it
 *     answers `updated` and stores 0, rather than `value_out_of_range`.
 *   - Newer wins: an entry carrying `computedAt` earlier than the stored
 *     row's is refused, `duplicate` with reason `stale`, and the newer value
 *     stays. An entry without one overwrites as before, and clears the
 *     stored time, since the stored value no longer has a known one. Held at
 *     every write path: the prefilter, the set settle and the reconciler.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  APPLE_HEALTH_TYPE_MAP,
  CUMULATIVE_HK_TYPES,
} from "@/lib/measurements/apple-health-mapping";

const USER = "user-stats-day-totals";

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

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "UTC",
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

const DAY = "2026-11-18";

function total(
  hkIdentifier: string,
  unit: string,
  value: number,
  computedAt?: string,
) {
  return {
    hkIdentifier,
    value,
    unit,
    startDate: `${DAY}T00:00:00.000Z`,
    endDate: `${DAY}T20:00:00.000Z`,
    externalId: `stats:${hkIdentifier}:${DAY}`,
    ...(computedAt ? { computedAt } : {}),
  };
}

async function send(
  entries: unknown[],
): Promise<Array<{ status: string; reason?: string }>> {
  const { POST } = await import("@/app/api/measurements/batch/route");
  const res = await POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      data: { entries: Array<{ status: string; reason?: string }> };
    }
  ).data.entries.map(({ status, reason }) => ({
    status,
    ...(reason ? { reason } : {}),
  }));
}

async function stored(hkIdentifier: string) {
  return getPrismaClient().measurement.findFirstOrThrow({
    where: { userId: USER, externalId: `stats:${hkIdentifier}:${DAY}` },
    select: { value: true, statsComputedAt: true, deletedAt: true },
  });
}

const cumulative = Object.values(APPLE_HEALTH_TYPE_MAP).filter((m) =>
  CUMULATIVE_HK_TYPES.has(m.measurementType),
);

describe("a day total of 0", () => {
  it("covers every cumulative type", () => {
    expect(new Set(cumulative.map((m) => m.measurementType))).toEqual(
      CUMULATIVE_HK_TYPES,
    );
  });

  it.each(cumulative.map((m) => [m.hkIdentifier, m.hkUnit] as const))(
    "%s: answers `updated` and stores 0",
    async (hkIdentifier, unit) => {
      expect(await send([total(hkIdentifier, unit, 5)])).toEqual([
        { status: "inserted" },
      ]);
      expect(await send([total(hkIdentifier, unit, 0)])).toEqual([
        { status: "updated" },
      ]);
      expect(await stored(hkIdentifier)).toMatchObject({
        value: 0,
        deletedAt: null,
      });
      // And a first post of 0, for a day not held yet, lands too.
      expect(
        await send([
          {
            ...total(hkIdentifier, unit, 0),
            startDate: "2026-11-17T00:00:00.000Z",
            endDate: "2026-11-17T20:00:00.000Z",
            externalId: `stats:${hkIdentifier}:2026-11-17`,
          },
        ]),
      ).toEqual([{ status: "inserted" }]);
    },
  );

  it("is still refused for an instantaneous reading", async () => {
    expect(
      await send([
        {
          hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
          value: 0,
          unit: "count/min",
          startDate: `${DAY}T08:00:00.000Z`,
          endDate: `${DAY}T08:00:00.000Z`,
          externalId: "uuid-hr-zero",
        },
      ]),
    ).toEqual([{ status: "skipped", reason: "value_out_of_range" }]);
  });
});

describe("newer wins for `stats:` rows", () => {
  const STEPS = "HKQuantityTypeIdentifierStepCount";
  const T1 = "2026-11-18T12:00:00.000Z";
  const T2 = "2026-11-18T18:00:00.000Z";

  it("keeps the newer total against an out-of-order replay", async () => {
    expect(await send([total(STEPS, "count", 9000, T2)])).toEqual([
      { status: "inserted" },
    ]);
    expect((await stored(STEPS)).statsComputedAt?.toISOString()).toBe(T2);

    // An older computation arrives late.
    expect(await send([total(STEPS, "count", 4000, T1)])).toEqual([
      { status: "duplicate", reason: "stale" },
    ]);
    expect(await stored(STEPS)).toMatchObject({ value: 9000 });

    // The same time again, or a later one, writes.
    expect(await send([total(STEPS, "count", 9100, T2)])).toEqual([
      { status: "updated" },
    ]);
    expect(await stored(STEPS)).toMatchObject({ value: 9100 });
  });

  it("leaves a write without `computedAt` as it was, and forgets the stored time", async () => {
    await send([total(STEPS, "count", 9000, T2)]);
    // An older build: no `computedAt`, overwrite as before.
    expect(await send([total(STEPS, "count", 4000)])).toEqual([
      { status: "updated" },
    ]);
    expect(await stored(STEPS)).toMatchObject({
      value: 4000,
      statsComputedAt: null,
    });
    // The stored value has no known time now: any stated one writes.
    expect(await send([total(STEPS, "count", 8000, T1)])).toEqual([
      { status: "updated" },
    ]);
    expect((await stored(STEPS)).statsComputedAt?.toISOString()).toBe(T1);
  });

  it("is ignored on a sample entry", async () => {
    expect(
      await send([
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 80,
          unit: "kg",
          startDate: `${DAY}T08:00:00.000Z`,
          endDate: `${DAY}T08:00:00.000Z`,
          externalId: "uuid-weight-computed",
          computedAt: T2,
        },
      ]),
    ).toEqual([{ status: "inserted" }]);
    const row = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: USER, externalId: "uuid-weight-computed" },
      select: { statsComputedAt: true },
    });
    expect(row.statsComputedAt).toBeNull();
  });

  it("holds under the reconciler and the set settle, past the prefilter", async () => {
    await send([total(STEPS, "count", 9000, T2)]);
    const prisma = getPrismaClient();
    const { reconcileExternalMeasurement, reconcileExternalMeasurements } =
      await import("@/lib/measurements/reconcile-external-measurement");
    const desired = {
      userId: USER,
      type: "ACTIVITY_STEPS" as const,
      value: 4000,
      unit: "steps",
      source: "APPLE_HEALTH" as const,
      measuredAt: (
        await prisma.measurement.findFirstOrThrow({
          where: { userId: USER, externalId: `stats:${STEPS}:${DAY}` },
        })
      ).measuredAt,
      externalId: `stats:${STEPS}:${DAY}`,
      aggregationProvenance: "HEALTHKIT_STATISTICS" as const,
      statsComputedAt: new Date(T1),
    };

    const one = await prisma.$transaction((tx) =>
      reconcileExternalMeasurement(tx, desired, {
        exactExternalMatch: "update",
      }),
    );
    expect(one).toMatchObject({ status: "duplicate", stale: true });

    const set = await prisma.$transaction((tx) =>
      reconcileExternalMeasurements(tx, [desired], {
        exactExternalMatch: "update",
      }),
    );
    expect(set[0]).toMatchObject({ status: "duplicate", stale: true });
    expect(await stored(STEPS)).toMatchObject({ value: 9000 });
  });
});
