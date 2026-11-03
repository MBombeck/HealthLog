/**
 * A workout entered by hand, end to end against a real Postgres.
 *
 * The web form builds its entry with `buildManualWorkoutEntry` and posts it
 * to `POST /api/workouts/batch`; this suite drives that exact entry through
 * the real route and reads it back through `GET /api/workouts`, then deletes
 * it through `DELETE /api/workouts/{id}`. Pins:
 *
 *   - the entry lands as `MANUAL`, with the start, duration and metres the
 *     form computed, and the list serves it;
 *   - a second submit of the same form is a `duplicate`, not a second row;
 *   - a submit after an edit is `updated` and the one row carries the edit,
 *     while a synced id with changed values stays first-write-wins;
 *   - an edit drops the paragraph written about the old values, lets go of
 *     its generation claim without freeing the day's slot, and raises the
 *     workout's arrival again so the paragraph is written from the new ones;
 *   - delete removes a hand-entered workout and refuses a synced one.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_USER_ID = "user-workout-manual-entry";

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

// The arrival seam is observed, not run: the edit test asserts the route
// raises one for the edited workout; what the spine then does is its own suite.
const emitDataArrival = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/arrivals/emit-shared", () => ({ emitDataArrival }));

const { POST: postBatch } = await import("@/app/api/workouts/batch/route");
const { GET: listWorkouts } = await import("@/app/api/workouts/route");
const { DELETE: deleteWorkout } = await import("@/app/api/workouts/[id]/route");
const { buildManualWorkoutEntry, newManualWorkoutExternalId } =
  await import("@/lib/workouts/manual-entry");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "workout-manual",
      email: "workout-manual@example.test",
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

function post(body: unknown): Promise<Response> {
  return postBatch(
    new NextRequest("http://localhost/api/workouts/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function list(): Promise<Response> {
  return listWorkouts(new NextRequest("http://localhost/api/workouts"));
}

function del(id: string): Promise<Response> {
  return deleteWorkout(
    new NextRequest(`http://localhost/api/workouts/${id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** The entry the form sends for a 45-minute imperial run, yesterday 07:30 Berlin. */
function formEntry(externalId: string) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const day = yesterday.toISOString().slice(0, 10);
  const built = buildManualWorkoutEntry(
    {
      sportType: "running",
      start: `${day}T07:30`,
      hours: "0",
      minutes: "45",
      distance: "5",
      energyKcal: "410",
    },
    {
      timezone: "Europe/Berlin",
      unitPreference: "imperial",
      externalId,
      now: new Date(),
    },
  );
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.entry;
}

describe("a workout entered by hand", () => {
  it("lands through the batch route as MANUAL and is served by the list", async () => {
    const entry = formEntry(newManualWorkoutExternalId());

    const res = await post({ workouts: [entry] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.entries).toEqual([{ index: 0, status: "inserted" }]);

    const listRes = await list();
    expect(listRes.status).toBe(200);
    const { data } = await listRes.json();
    expect(data.workouts).toHaveLength(1);
    const row = data.workouts[0];
    expect(row).toMatchObject({
      sportType: "running",
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      durationSec: 45 * 60,
      // 5 mi, stored in metres to a tenth.
      distanceM: 8046.7,
      activeEnergyKcal: 410,
      source: "MANUAL",
      externalId: entry.externalId,
    });
  });

  it("stores a second submit of the same form once", async () => {
    const entry = formEntry(newManualWorkoutExternalId());

    await post({ workouts: [entry] });
    const again = await post({ workouts: [entry] });

    expect((await again.json()).data.entries).toEqual([
      { index: 0, status: "duplicate" },
    ]);
    expect(
      await getPrismaClient().workout.count({
        where: { userId: TEST_USER_ID },
      }),
    ).toBe(1);
  });

  it("updates the stored row when the same form is sent again with an edit", async () => {
    const prisma = getPrismaClient();
    const entry = formEntry(newManualWorkoutExternalId());
    await post({ workouts: [entry] });
    const stored = await prisma.workout.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });
    // A record the first values set; the edit must not leave it behind.
    await prisma.personalRecord.create({
      data: {
        userId: TEST_USER_ID,
        metricType: "WALKING_RUNNING_DISTANCE",
        metricSlot: "longest_distance_run",
        direction: "MAX",
        value: 8046.7,
        unit: "m",
        achievedAt: stored.startedAt,
        source: "MANUAL",
        externalId: entry.externalId,
      },
    });

    const edited = { ...entry, totalDistanceM: 6000, totalEnergyKcal: 380 };
    const res = await post({ workouts: [edited] });

    expect((await res.json()).data.entries).toEqual([
      { index: 0, status: "updated" },
    ]);
    const rows = await prisma.workout.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: stored.id,
      totalDistanceM: 6000,
      totalEnergyKcal: 380,
      durationSec: 45 * 60,
    });
    expect(
      await prisma.personalRecord.count({
        where: { userId: TEST_USER_ID, externalId: entry.externalId },
      }),
    ).toBe(0);

    // The same edit once more changes nothing and says so.
    const again = await post({ workouts: [edited] });
    expect((await again.json()).data.entries).toEqual([
      { index: 0, status: "duplicate" },
    ]);
  });

  it("drops the paragraph about the old values when an edit lands", async () => {
    const prisma = getPrismaClient();
    const entry = formEntry(newManualWorkoutExternalId());
    await post({ workouts: [entry] });
    const stored = await prisma.workout.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });
    // What the worker leaves behind once it wrote the paragraph.
    const claim = await prisma.workoutInsightGenerationClaim.create({
      data: {
        userId: TEST_USER_ID,
        workoutId: stored.id,
        localDate: "2026-10-03",
        providerInvokedAt: new Date(),
        completedAt: new Date(),
      },
    });
    await prisma.workoutInsight.create({
      data: {
        userId: TEST_USER_ID,
        workoutId: stored.id,
        paragraphEncrypted: Buffer.from("ciphertext-stand-in", "utf8"),
        inputHash: "hash-of-the-old-values",
        promptVersion: "1.0.0",
        providerType: "local",
        locale: "en",
        generatedAt: new Date(),
      },
    });
    emitDataArrival.mockClear();

    // A run corrected from 8 km to 1.2 km.
    const res = await post({
      workouts: [{ ...entry, totalDistanceM: 1200 }],
    });
    expect((await res.json()).data.entries).toEqual([
      { index: 0, status: "updated" },
    ]);

    expect(
      await prisma.workoutInsight.count({ where: { workoutId: stored.id } }),
    ).toBe(0);
    // The claim stays as the day's ledger, detached from the workout, so the
    // edit frees no slot and a fresh claim for the workout is possible.
    const ledger = await prisma.workoutInsightGenerationClaim.findUniqueOrThrow(
      { where: { id: claim.id } },
    );
    expect(ledger.workoutId).toBeNull();
    expect(ledger.providerInvokedAt).not.toBeNull();
    await vi.waitFor(() =>
      expect(emitDataArrival).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: TEST_USER_ID,
          kind: "workout",
          refId: stored.id,
        }),
      ),
    );
  });

  it("keeps the paragraph when the same form is sent again unchanged", async () => {
    const prisma = getPrismaClient();
    const entry = formEntry(newManualWorkoutExternalId());
    await post({ workouts: [entry] });
    const stored = await prisma.workout.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });
    await prisma.workoutInsight.create({
      data: {
        userId: TEST_USER_ID,
        workoutId: stored.id,
        paragraphEncrypted: Buffer.from("ciphertext-stand-in", "utf8"),
        inputHash: "hash-of-the-values",
        promptVersion: "1.0.0",
        providerType: "local",
        locale: "en",
        generatedAt: new Date(),
      },
    });
    emitDataArrival.mockClear();

    const res = await post({ workouts: [entry] });
    expect((await res.json()).data.entries).toEqual([
      { index: 0, status: "duplicate" },
    ]);
    expect(
      await prisma.workoutInsight.count({ where: { workoutId: stored.id } }),
    ).toBe(1);
    expect(emitDataArrival).not.toHaveBeenCalled();
  });

  it("keeps a synced workout first-write-wins under the same resend", async () => {
    const prisma = getPrismaClient();
    const entry = {
      ...formEntry("hk-uuid-1"),
      source: "APPLE_HEALTH" as const,
      externalId: "8F14E45F-CEEA-467A-9575-0F5D6C5A1B2C",
    };
    await post({ workouts: [entry] });

    const res = await post({
      workouts: [{ ...entry, totalDistanceM: 1234 }],
    });

    expect((await res.json()).data.entries).toEqual([
      { index: 0, status: "duplicate" },
    ]);
    const row = await prisma.workout.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });
    expect(row.totalDistanceM).not.toBe(1234);
  });

  it("can be deleted, and is gone from the list", async () => {
    await post({ workouts: [formEntry(newManualWorkoutExternalId())] });
    const stored = await getPrismaClient().workout.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });

    const res = await del(stored.id);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ deleted: true });

    const { data } = await (await list()).json();
    expect(data.workouts).toHaveLength(0);
  });

  it("refuses to delete a synced workout and leaves it in place", async () => {
    const synced = await getPrismaClient().workout.create({
      data: {
        userId: TEST_USER_ID,
        sportType: "cycling",
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        endedAt: new Date(Date.now() - 60 * 60 * 1000),
        durationSec: 3600,
        source: "APPLE_HEALTH",
        externalId: "hk-sync-1",
      },
    });

    const res = await del(synced.id);

    expect(res.status).toBe(409);
    expect(
      await getPrismaClient().workout.count({ where: { id: synced.id } }),
    ).toBe(1);
  });
});
