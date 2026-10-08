/**
 * Editing a hand-entered workout (#1162), end to end against real Postgres:
 * the detail read the page opens the edit sheet from, the entry the form
 * builds from it, and the batch route's overwrite of the `manual:` row.
 *
 * The overwrite replaces every overwritable column and nulls the ones a
 * re-post leaves out. The form has no heart-rate or step fields, so an edit
 * that did not carry them back would erase them; and the detail read's
 * `avgHr` can be filled in from a same-session twin, which must not end up
 * stored on the hand-entered row.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  buildManualWorkoutEntry,
  manualWorkoutOriginalFromRow,
} from "@/lib/workouts/manual-entry";

const USER_ID = "user-manual-workout-edit";
const EXTERNAL_ID = "manual:0f9e8d7c-1111-4222-8333-444455556666";

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
      id: USER_ID,
      username: "manual-workout-edit",
      email: "manual-workout-edit@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

async function postWorkouts(workouts: unknown[]) {
  const { POST } = await import("@/app/api/workouts/batch/route");
  const res = await POST(
    new NextRequest("http://localhost/api/workouts/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workouts }),
    }),
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as { data: { entries: Array<{ status: string }> } }
  ).data.entries;
}

async function readDetail(id: string) {
  const { GET } = await import("@/app/api/workouts/[id]/route");
  const res = await (
    GET as unknown as (
      r: NextRequest,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>
  )(new NextRequest(`http://localhost/api/workouts/${id}?compact=1`), {
    params: Promise.resolve({ id }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe("editing a hand-entered workout (#1162)", () => {
  it("changes the edited field and keeps every field the form has no input for", async () => {
    // A MANUAL row carrying heart rate and steps, as a client other than the
    // web form can write it.
    const [created] = await postWorkouts([
      {
        sportType: "running",
        startedAt: "2026-09-15T05:12:34.000Z",
        endedAt: "2026-09-15T05:59:54.000Z",
        source: "MANUAL",
        externalId: EXTERNAL_ID,
        totalDistanceM: 5000,
        totalEnergyKcal: 410,
        avgHeartRate: 142,
        maxHeartRate: 171,
        minHeartRate: 98,
        stepCount: 6400,
        elevationM: 42.5,
        pauseDurationSec: 60,
      },
    ]);
    expect(created?.status).toBe("inserted");
    const row = await getPrismaClient().workout.findFirstOrThrow({
      where: { userId: USER_ID, externalId: EXTERNAL_ID },
    });

    const detail = await readDetail(row.id);
    expect(detail.storedAvgHr).toBe(142);
    const original = manualWorkoutOriginalFromRow(
      detail as unknown as Parameters<typeof manualWorkoutOriginalFromRow>[0],
      { timezone: "Europe/Berlin", unitPreference: "imperial" },
    );
    const built = buildManualWorkoutEntry(
      { ...original.draft, energyKcal: "455" },
      {
        timezone: "Europe/Berlin",
        unitPreference: "imperial",
        externalId: detail.externalId as string,
        now: new Date("2026-09-16T12:00:00.000Z"),
        original,
      },
    );
    if (!built.ok) throw new Error(JSON.stringify(built.errors));

    const [edited] = await postWorkouts([built.entry]);
    expect(edited?.status).toBe("updated");

    const after = await getPrismaClient().workout.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.totalEnergyKcal).toBe(455);
    expect(after.avgHeartRate).toBe(142);
    expect(after.maxHeartRate).toBe(171);
    expect(after.minHeartRate).toBe(98);
    expect(after.stepCount).toBe(6400);
    expect(after.elevationM).toBe(42.5);
    expect(after.pauseDurationSec).toBe(60);
    // Shown as 3.11 mi and left alone: the stored metres, not 5 005.1.
    expect(after.totalDistanceM).toBe(5000);
    expect(after.startedAt.toISOString()).toBe("2026-09-15T05:12:34.000Z");
    expect(after.endedAt.toISOString()).toBe("2026-09-15T05:59:54.000Z");
    expect(
      await getPrismaClient().workout.count({ where: { userId: USER_ID } }),
    ).toBe(1);
  });

  it("answers duplicate, and writes nothing, for an edit saved unchanged", async () => {
    await postWorkouts([
      {
        sportType: "cycling",
        startedAt: "2026-09-15T06:00:00.000Z",
        endedAt: "2026-09-15T07:30:00.000Z",
        source: "MANUAL",
        externalId: EXTERNAL_ID,
        totalDistanceM: 32000,
      },
    ]);
    const row = await getPrismaClient().workout.findFirstOrThrow({
      where: { userId: USER_ID },
    });
    const detail = await readDetail(row.id);
    const original = manualWorkoutOriginalFromRow(
      detail as unknown as Parameters<typeof manualWorkoutOriginalFromRow>[0],
      { timezone: "Europe/Berlin", unitPreference: "metric" },
    );
    const built = buildManualWorkoutEntry(original.draft, {
      timezone: "Europe/Berlin",
      unitPreference: "metric",
      externalId: EXTERNAL_ID,
      now: new Date("2026-09-16T12:00:00.000Z"),
      original,
    });
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    const [result] = await postWorkouts([built.entry]);
    expect(result?.status).toBe("duplicate");
  });
});
