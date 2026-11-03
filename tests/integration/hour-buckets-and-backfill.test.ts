/**
 * Hour buckets for summed types and the `backfill` trigger (ios #77), against
 * real Postgres.
 *
 * An hourly `stats:<HK>:<YYYY-MM-DD>T<HH>` row must never become a
 * measurement: the day total stays the day row, and an hour stored as a
 * measurement would be counted into that day a second time. The hours land in
 * the intraday profile instead, which is what makes the same-time baseline
 * usable on day one after a thirty-day backfill. And a backfill is a
 * catch-up, so it must not move the live sync stamps.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-hour-buckets-backfill-32-bytes-minimum-1234";

const USER_ID = "user-hour-buckets";
const STEPS = "HKQuantityTypeIdentifierStepCount";

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
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "hour-buckets",
      email: "hour-buckets@example.test",
      timezone: "UTC",
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

async function postBatch(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/measurements/batch/route");
  const res = await POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).data as {
    inserted: number;
    updated: number;
    entries: Array<{ index: number; status: string; reason?: string }>;
  };
}

function dayKeyBack(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function hourEntry(dateKey: string, hour: number, value: number) {
  const hh = String(hour).padStart(2, "0");
  const start = `${dateKey}T${hh}:00:00.000Z`;
  return {
    hkIdentifier: STEPS,
    value,
    unit: "count",
    startDate: start,
    endDate: new Date(Date.parse(start) + 3_600_000).toISOString(),
    externalId: `stats:${STEPS}:${dateKey}T${hh}`,
  };
}

function dayEntry(dateKey: string, value: number) {
  return {
    hkIdentifier: STEPS,
    value,
    unit: "count",
    startDate: `${dateKey}T00:00:00.000Z`,
    endDate: `${dateKey}T12:00:00.000Z`,
    externalId: `stats:${STEPS}:${dateKey}`,
  };
}

describe("hour buckets for summed types", () => {
  it("keeps the day total as the only measurement and builds the profile from the hours", async () => {
    const day = dayKeyBack(2);
    const hours = Array.from({ length: 24 }, (_, h) =>
      hourEntry(day, h, h * 10),
    );
    const total = hours.reduce((s, e) => s + e.value, 0);

    const first = await postBatch({
      entries: [dayEntry(day, total), ...hours],
    });
    expect(first.entries.slice(1).every((e) => e.status === "inserted")).toBe(
      true,
    );

    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: USER_ID, type: "ACTIVITY_STEPS" },
      select: { value: true, externalId: true },
    });
    // The guard: no hour of a summed type ever reaches `measurements`.
    expect(rows).toEqual([
      { value: total, externalId: `stats:${STEPS}:${day}` },
    ]);

    const profile =
      await getPrismaClient().intradayCumulativeProfile.findUniqueOrThrow({
        where: {
          userId_type_dateKey: {
            userId: USER_ID,
            type: "ACTIVITY_STEPS",
            dateKey: day,
          },
        },
      });
    expect(profile.basis).toBe("HOUR_BUCKETS");
    expect(profile.bucketCount).toBe(24);
    expect(profile.hourlyIncrements).toEqual(hours.map((e) => e.value));
    expect(profile.hourlyCumulative[23]).toBe(total);
    expect(profile.dayTotal).toBe(total);
    expect(profile.timezone).toBe("UTC");

    // A re-post of one hour overwrites it.
    const again = await postBatch({ entries: [hourEntry(day, 5, 999)] });
    expect(again.entries[0]).toMatchObject({ status: "updated" });
    expect(again.updated).toBe(1);
    const after =
      await getPrismaClient().intradayCumulativeProfile.findFirstOrThrow({
        where: { userId: USER_ID, dateKey: day },
      });
    expect(after.hourlyIncrements[5]).toBe(999);
    expect(after.dayTotal).toBe(total - 50 + 999);
    // And the day row did not move.
    const dayRow = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: USER_ID, type: "ACTIVITY_STEPS" },
    });
    expect(dayRow.value).toBe(total);
  });

  it("keeps a day under four hours on its per-sample shape", async () => {
    const day = dayKeyBack(3);
    await postBatch({
      entries: [hourEntry(day, 8, 100), hourEntry(day, 9, 200)],
    });
    const profile =
      await getPrismaClient().intradayCumulativeProfile.findFirstOrThrow({
        where: { userId: USER_ID, dateKey: day },
      });
    expect(profile.basis).toBe("PER_SAMPLE");
    expect(profile.bucketCount).toBe(2);
    expect(profile.hourlyCumulative).toEqual([]);

    // The drain's fold then fills the curve; the posted hours stay put.
    const { mergeIntradayCumulativeProfile } =
      await import("@/lib/measurements/intraday-cumulative-profile");
    await getPrismaClient().$transaction((tx) =>
      mergeIntradayCumulativeProfile(tx, {
        userId: USER_ID,
        type: "ACTIVITY_STEPS",
        increment: {
          dateKey: day,
          timezone: "UTC",
          hourlyCumulative: Array.from({ length: 24 }, (_, h) =>
            h >= 8 ? 300 : 0,
          ),
          dayTotal: 300,
          sampleCount: 30,
        },
      }),
    );
    const folded =
      await getPrismaClient().intradayCumulativeProfile.findFirstOrThrow({
        where: { userId: USER_ID, dateKey: day },
      });
    expect(folded.dayTotal).toBe(300);
    expect(folded.hourlyIncrements[9]).toBe(200);
  });

  it("does not let the per-sample fold count a bucket-built day twice", async () => {
    const day = dayKeyBack(4);
    await postBatch({
      entries: Array.from({ length: 6 }, (_, h) => hourEntry(day, h + 8, 100)),
    });
    const { mergeIntradayCumulativeProfile } =
      await import("@/lib/measurements/intraday-cumulative-profile");
    await getPrismaClient().$transaction((tx) =>
      mergeIntradayCumulativeProfile(tx, {
        userId: USER_ID,
        type: "ACTIVITY_STEPS",
        increment: {
          dateKey: day,
          timezone: "UTC",
          hourlyCumulative: new Array(24).fill(600),
          dayTotal: 600,
          sampleCount: 60,
        },
      }),
    );
    const profile =
      await getPrismaClient().intradayCumulativeProfile.findFirstOrThrow({
        where: { userId: USER_ID, dateKey: day },
      });
    expect(profile.basis).toBe("HOUR_BUCKETS");
    expect(profile.dayTotal).toBe(600);
    expect(profile.sampleCount).toBe(6);
  });

  it("names every refusal", async () => {
    const day = dayKeyBack(2);
    const misaligned = {
      ...hourEntry(day, 9, 10),
      startDate: `${day}T09:30:00.000Z`,
    };
    const unsupported = {
      ...hourEntry(day, 9, 10),
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      unit: "kg",
      externalId: `stats:HKQuantityTypeIdentifierBodyMass:${day}T09`,
    };
    const old = hourEntry("2024-01-02", 9, 10);
    const result = await postBatch({ entries: [misaligned, unsupported, old] });
    expect(result.entries.map((e) => e.reason)).toEqual([
      "hour_bucket_misaligned",
      "hour_bucket_unsupported_type",
      "hour_bucket_too_old",
    ]);
    expect(
      await getPrismaClient().intradayCumulativeProfile.count({
        where: { userId: USER_ID },
      }),
    ).toBe(0);
  });

  it("makes the same-time baseline usable on day one after a thirty-day backfill", async () => {
    const entries = [];
    for (let back = 31; back >= 1; back -= 1) {
      const day = dayKeyBack(back);
      for (let h = 0; h < 24; h += 1) entries.push(hourEntry(day, h, 50 + h));
    }
    for (let i = 0; i < entries.length; i += 400) {
      await postBatch({
        syncTrigger: "backfill",
        entries: entries.slice(i, i + 400),
      });
    }
    const { computeSameTimeBaseline } =
      await import("@/lib/insights/derived/same-time-baseline");
    // "Today" is the last backfilled day, at 20:30.
    const now = new Date(`${dayKeyBack(1)}T20:30:00.000Z`);
    const derived = await computeSameTimeBaseline(USER_ID, null, {
      type: "ACTIVITY_STEPS",
      now,
    });
    expect(derived.status).toBe("ok");
  });
});

describe('syncTrigger "backfill"', () => {
  it("records lastBackfillAt and moves none of the live stamps", async () => {
    const live = await postBatch({
      syncTrigger: "foreground",
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
          value: 61,
          unit: "count/min",
          startDate: "2026-10-01T06:00:00.000Z",
          endDate: "2026-10-01T06:00:00.000Z",
          externalId: "uuid-live-1",
        },
      ],
    });
    expect(live.inserted).toBe(1);
    const prisma = getPrismaClient();
    const userBefore = await prisma.user.findUniqueOrThrow({
      where: { id: USER_ID },
      select: {
        lastSyncedAt: true,
        healthKitLastSyncedAt: true,
        healthKitLastSyncTrigger: true,
        healthKitLastBackgroundSyncAt: true,
      },
    });
    const ledgerBefore = await prisma.healthKitTypeSync.findUniqueOrThrow({
      where: { userId_type: { userId: USER_ID, type: "PULSE" } },
    });

    const backfill = await postBatch({
      syncTrigger: "backfill",
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
          value: 63,
          unit: "count/min",
          startDate: "2026-09-01T06:00:00.000Z",
          endDate: "2026-09-01T06:00:00.000Z",
          externalId: "uuid-backfill-1",
        },
      ],
    });
    expect(backfill.inserted).toBe(1);

    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: USER_ID },
        select: {
          lastSyncedAt: true,
          healthKitLastSyncedAt: true,
          healthKitLastSyncTrigger: true,
          healthKitLastBackgroundSyncAt: true,
        },
      }),
    ).toEqual(userBefore);
    expect(
      await prisma.healthKitTypeSync.findUniqueOrThrow({
        where: { userId_type: { userId: USER_ID, type: "PULSE" } },
      }),
    ).toEqual(ledgerBefore);
    const backfillRow = await prisma.healthKitTypeSync.findUniqueOrThrow({
      where: { userId_type: { userId: USER_ID, type: "backfill:PULSE" } },
    });
    expect(backfillRow.lastTrigger).toBeNull();

    // The status read serves it, and the live facts are the foreground ones.
    const { GET } = await import("@/app/api/integrations/healthkit/route");
    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()).data as {
      metricFreshness: Array<Record<string, unknown>>;
      syncProgress: { recordsAccepted: number } | null;
    };
    const pulse = body.metricFreshness.find((e) => e.type === "PULSE");
    expect(pulse).toMatchObject({
      lastReceivedAt: ledgerBefore.lastReceivedAt.toISOString(),
      lastTrigger: "foreground",
      lastBackfillAt: backfillRow.lastReceivedAt.toISOString(),
    });
    // syncProgress counts what arrived, the backfill included.
    expect(body.syncProgress?.recordsAccepted).toBe(2);
    expect(
      body.metricFreshness.some((e) => String(e.type).startsWith("backfill:")),
    ).toBe(false);
  });

  it("is refused by name for anything outside the enum", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");
    const res = await POST(
      new NextRequest("http://localhost/api/measurements/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          syncTrigger: "history",
          entries: [dayEntry("2026-10-01", 1)],
        }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
