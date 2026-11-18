/**
 * The by-external-ids deletes for workouts, ECG recordings, cycle day-logs,
 * State of Mind entries and Apple Health dose records, against real Postgres.
 *
 * Each route touches only the caller's own `APPLE_HEALTH` rows, deletes them
 * the way its domain's single delete does (removed outright where the model
 * has no tombstone, tombstoned where it has one, with the same follow-up
 * work), answers `{ deletedCount }`, and is idempotent. The re-post legs pin
 * the answer a late outbox replay of a deleted id gets, which is what the
 * iPhone app needs to know.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const OWNER = "user-external-id-owner";
const OTHER = "user-external-id-other";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  for (const id of [OWNER, OTHER]) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        email: `${id}@example.test`,
        timezone: "UTC",
        gender: "FEMALE",
      },
    });
  }
  const session = await prisma.session.create({
    data: { userId: OWNER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

function del(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deletedCount(res: Response): Promise<number> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { deletedCount: number } }).data
    .deletedCount;
}

const at = new Date("2026-10-10T07:00:00.000Z");

describe("DELETE /api/workouts/by-external-ids", () => {
  it("removes the caller's Apple Health workouts and the records they set, nothing else", async () => {
    const prisma = getPrismaClient();
    const workout = (userId: string, source: "APPLE_HEALTH" | "MANUAL") =>
      prisma.workout.create({
        data: {
          userId,
          sportType: "running",
          startedAt: at,
          endedAt: new Date(at.getTime() + 1_800_000),
          durationSec: 1800,
          source,
          externalId: "WK-1",
        },
      });
    await workout(OWNER, "APPLE_HEALTH");
    await workout(OWNER, "MANUAL");
    await workout(OTHER, "APPLE_HEALTH");
    await prisma.personalRecord.create({
      data: {
        userId: OWNER,
        metricType: "ACTIVE_ENERGY_BURNED",
        metricSlot: "running_longest_duration",
        direction: "MAX",
        value: 1800,
        unit: "s",
        achievedAt: at,
        source: "APPLE_HEALTH",
        externalId: "WK-1",
      },
    });

    const { DELETE } = await import("@/app/api/workouts/by-external-ids/route");
    expect(
      await deletedCount(
        await DELETE(
          del("/api/workouts/by-external-ids", {
            externalIds: ["WK-1", "WK-missing"],
          }),
        ),
      ),
    ).toBe(1);
    expect(
      await prisma.workout.findMany({
        select: { userId: true, source: true },
        orderBy: { userId: "asc" },
      }),
    ).toEqual([
      { userId: OTHER, source: "APPLE_HEALTH" },
      { userId: OWNER, source: "MANUAL" },
    ]);
    expect(await prisma.personalRecord.count()).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { userId: OWNER, action: "workout.delete.by_external_ids" },
      }),
    ).toBe(1);

    // Idempotent.
    expect(
      await deletedCount(
        await DELETE(
          del("/api/workouts/by-external-ids", { externalIds: ["WK-1"] }),
        ),
      ),
    ).toBe(0);
  });

  it("refuses more than 500 ids and a malformed body", async () => {
    const { DELETE } = await import("@/app/api/workouts/by-external-ids/route");
    const tooMany = await DELETE(
      del("/api/workouts/by-external-ids", {
        externalIds: Array.from({ length: 501 }, (_, i) => `id-${i}`),
      }),
    );
    expect(tooMany.status).toBe(422);
    expect(
      ((await tooMany.json()) as { meta: { errorCode: string } }).meta
        .errorCode,
    ).toBe("workout.delete.too_large");
    const invalid = await DELETE(
      del("/api/workouts/by-external-ids", { ids: ["a"] }),
    );
    expect(invalid.status).toBe(422);
  });

  it("refuses an anonymous caller", async () => {
    cookieJar.clear();
    const { DELETE } = await import("@/app/api/workouts/by-external-ids/route");
    const res = await DELETE(
      del("/api/workouts/by-external-ids", { externalIds: ["WK-1"] }),
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/insights/ecg/by-external-ids", () => {
  it("removes the caller's Apple Health recordings only", async () => {
    const prisma = getPrismaClient();
    const { persistEcgRecording } = await import("@/lib/ecg/persist-recording");
    const strip = (userId: string, source: "APPLE_HEALTH" | "WITHINGS") =>
      persistEcgRecording(
        {
          userId,
          source,
          externalRecordingId: "ECG-1",
          recordedAt: at,
          samples: [1, 2, 3, 4],
          samplingFrequency: 512,
          lead: null,
          averageHeartRate: 60,
          rhythmClassification: "NOT_DETECTED",
        },
        prisma,
      );
    await strip(OWNER, "APPLE_HEALTH");
    await strip(OWNER, "WITHINGS");
    await strip(OTHER, "APPLE_HEALTH");

    const { DELETE } =
      await import("@/app/api/insights/ecg/by-external-ids/route");
    expect(
      await deletedCount(
        await DELETE(
          del("/api/insights/ecg/by-external-ids", { externalIds: ["ECG-1"] }),
        ),
      ),
    ).toBe(1);
    expect(
      await prisma.ecgRecording.findMany({
        select: { userId: true, source: true },
        orderBy: [{ userId: "asc" }],
      }),
    ).toEqual([
      { userId: OTHER, source: "APPLE_HEALTH" },
      { userId: OWNER, source: "WITHINGS" },
    ]);
  });
});

describe("DELETE /api/cycle/day-logs/by-external-ids", () => {
  it("tombstones the Apple Health day with the cycle it opened; a bulk re-post brings it back", async () => {
    const prisma = getPrismaClient();
    const bulk = await import("@/app/api/cycle/day-logs/bulk/route");
    const day = {
      date: "2026-10-01",
      flow: "MEDIUM",
      source: "APPLE_HEALTH",
      externalId: "CYC-1",
      loggedAt: "2026-10-01T08:00:00.000Z",
    };
    const ingest = await bulk.POST(
      post("/api/cycle/day-logs/bulk", { entries: [day] }),
    );
    expect(ingest.status).toBe(200);
    expect(
      await prisma.menstrualCycle.count({
        where: { userId: OWNER, deletedAt: null },
      }),
    ).toBe(1);

    const { DELETE } =
      await import("@/app/api/cycle/day-logs/by-external-ids/route");
    expect(
      await deletedCount(
        await DELETE(
          del("/api/cycle/day-logs/by-external-ids", {
            externalIds: ["CYC-1"],
          }),
        ),
      ),
    ).toBe(1);
    const row = await prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: OWNER, externalId: "CYC-1" },
      select: { deletedAt: true, syncVersion: true },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(
      await prisma.menstrualCycle.count({
        where: { userId: OWNER, deletedAt: null },
      }),
    ).toBe(0);

    const replay = await bulk.POST(
      post("/api/cycle/day-logs/bulk", { entries: [day] }),
    );
    const replayBody = (await replay.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(replayBody.data.entries[0]?.status).toBe("updated");
    expect(
      (
        await prisma.cycleDayLog.findFirstOrThrow({
          where: { userId: OWNER, externalId: "CYC-1" },
        })
      ).deletedAt,
    ).toBeNull();
  });
});

describe("DELETE /api/mood-entries/by-external-ids", () => {
  it("tombstones State of Mind entries posted as APPLE_HEALTH, keeps the rest, and a re-post stays deleted", async () => {
    const prisma = getPrismaClient();
    const bulk = await import("@/app/api/mood-entries/bulk/route");
    const entry = (source: string, minute: number) => ({
      mood: "GUT",
      moodLoggedAt: new Date(at.getTime() + minute * 60_000).toISOString(),
      source,
      externalId: "SOM-1",
    });
    const ingest = await bulk.POST(
      post("/api/mood-entries/bulk", {
        entries: [entry("APPLE_HEALTH", 0), entry("MANUAL", 5)],
      }),
    );
    expect(ingest.status).toBe(200);
    expect(await prisma.moodEntry.count({ where: { userId: OWNER } })).toBe(2);

    const { DELETE } =
      await import("@/app/api/mood-entries/by-external-ids/route");
    expect(
      await deletedCount(
        await DELETE(
          del("/api/mood-entries/by-external-ids", { externalIds: ["SOM-1"] }),
        ),
      ),
    ).toBe(1);
    expect(
      await prisma.moodEntry.findMany({
        where: { userId: OWNER, deletedAt: null },
        select: { source: true },
      }),
    ).toEqual([{ source: "MANUAL" }]);

    const replay = await bulk.POST(
      post("/api/mood-entries/bulk", { entries: [entry("APPLE_HEALTH", 0)] }),
    );
    const replayBody = (await replay.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(replayBody.data.entries[0]?.status).toBe("duplicate");
    expect(
      await prisma.moodEntry.count({
        where: { userId: OWNER, deletedAt: null },
      }),
    ).toBe(1);
  });
});

describe("DELETE /api/medications/intake/by-external-ids", () => {
  it("tombstones Apple Health doses of the caller only", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: OWNER,
        name: "Ramipril",
        dose: "5 mg",
        externalSource: "APPLE_HEALTH",
      },
    });
    const otherMed = await prisma.medication.create({
      data: { userId: OTHER, name: "Ramipril", dose: "5 mg" },
    });
    const intake = (
      userId: string,
      medicationId: string,
      source: "APPLE_HEALTH" | "WEB",
      externalId: string | null,
      hour: number,
    ) =>
      prisma.medicationIntakeEvent.create({
        data: {
          userId,
          medicationId,
          scheduledFor: new Date(at.getTime() + hour * 3_600_000),
          takenAt: new Date(at.getTime() + hour * 3_600_000),
          source,
          externalId,
        },
      });
    await intake(OWNER, med.id, "APPLE_HEALTH", "DOSE-1", 0);
    await intake(OWNER, med.id, "WEB", null, 2);
    await intake(OTHER, otherMed.id, "APPLE_HEALTH", "DOSE-1", 0);

    const { DELETE } =
      await import("@/app/api/medications/intake/by-external-ids/route");
    expect(
      await deletedCount(
        await DELETE(
          del("/api/medications/intake/by-external-ids", {
            externalIds: ["DOSE-1"],
          }),
        ),
      ),
    ).toBe(1);
    expect(
      await prisma.medicationIntakeEvent.findMany({
        where: { deletedAt: null },
        select: { userId: true, source: true },
        orderBy: { userId: "asc" },
      }),
    ).toEqual([
      { userId: OTHER, source: "APPLE_HEALTH" },
      { userId: OWNER, source: "WEB" },
    ]);
    const tomb = await prisma.medicationIntakeEvent.findFirstOrThrow({
      where: { userId: OWNER, externalId: "DOSE-1" },
      select: { deletedAt: true, syncVersion: true },
    });
    expect(tomb.deletedAt).not.toBeNull();
    expect(tomb.syncVersion).toBe(1);

    expect(
      await deletedCount(
        await DELETE(
          del("/api/medications/intake/by-external-ids", {
            externalIds: ["DOSE-1"],
          }),
        ),
      ),
    ).toBe(0);

    // A late replay of the deleted dose through the bulk ingest.
    const bulk = await import("@/app/api/medications/intake/bulk/route");
    const replay = await bulk.POST(
      post("/api/medications/intake/bulk", {
        entries: [
          {
            medicationId: med.id,
            takenAt: at.toISOString(),
            source: "APPLE_HEALTH",
            externalId: "DOSE-1",
          },
        ],
      }),
    );
    const replayBody = (await replay.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    // The live-row unique (migration 0239) lets a tombstone never block the
    // ledger, so the replay lands as a new dose rather than reviving the old.
    expect(replay.status).toBe(200);
    expect(replayBody.data.entries.map((e) => e.status)).toEqual(["inserted"]);
  });
});
