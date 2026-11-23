/**
 * The by-external-ids deletes for workouts, ECG recordings, cycle day-logs,
 * State of Mind entries and Apple Health dose records, against real Postgres.
 *
 * Each route touches only the caller's own `APPLE_HEALTH` rows, deletes them
 * the way its domain's single delete does (removed outright where the model
 * has no tombstone, tombstoned where it has one, with the same follow-up
 * work), answers `{ deletedCount }`, and is idempotent. The re-post legs pin
 * the answer a later post of a deleted id gets, which is what the iPhone app
 * needs to know: a sample the phone reported deleted in Apple Health is
 * written again (it is in HealthKit again), and one the person deleted in
 * HealthLog stays deleted (`tombstone-repost.ts`).
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

  it("writes a workout the phone reported deleted again when the sample is posted again", async () => {
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/workouts/batch/route");
    const { DELETE } = await import("@/app/api/workouts/by-external-ids/route");
    const run = (externalId: string) => ({
      sportType: "running",
      startedAt: at.toISOString(),
      endedAt: new Date(at.getTime() + 1_800_000).toISOString(),
      externalId,
      source: "APPLE_HEALTH",
    });
    const statuses = async (res: Response) =>
      (
        (await res.json()) as {
          data: { entries: Array<{ status: string; reason?: string }> };
        }
      ).data.entries.map((e) => [e.status, e.reason]);

    expect(
      await statuses(
        await POST(post("/api/workouts/batch", { workouts: [run("WK-2")] })),
      ),
    ).toEqual([["inserted", undefined]]);
    expect(
      await deletedCount(
        await DELETE(
          del("/api/workouts/by-external-ids", { externalIds: ["WK-2"] }),
        ),
      ),
    ).toBe(1);

    // The sample is in HealthKit again: only the phone can delete an Apple
    // Health workout, so nothing holds it out.
    expect(
      await statuses(
        await POST(post("/api/workouts/batch", { workouts: [run("WK-2")] })),
      ),
    ).toEqual([["inserted", undefined]]);
    expect(await prisma.workout.count({ where: { userId: OWNER } })).toBe(1);
  });

  it("refuses the person's own delete of an Apple Health workout", async () => {
    const prisma = getPrismaClient();
    const row = await prisma.workout.create({
      data: {
        userId: OWNER,
        sportType: "running",
        startedAt: at,
        endedAt: new Date(at.getTime() + 1_800_000),
        durationSec: 1800,
        source: "APPLE_HEALTH",
        externalId: "WK-3",
      },
    });
    const { DELETE } = await import("@/app/api/workouts/[id]/route");
    const res = await DELETE(
      new NextRequest(`http://localhost/api/workouts/${row.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: row.id }) },
    );
    expect(res.status).toBe(409);
    expect(
      ((await res.json()) as { meta: { errorCode: string } }).meta.errorCode,
    ).toBe("workout.delete.synced_source");
    expect(await prisma.workout.count({ where: { id: row.id } })).toBe(1);
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

  it("writes a recording the phone reported deleted again when it is posted again", async () => {
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/insights/ecg/route");
    const { DELETE } =
      await import("@/app/api/insights/ecg/by-external-ids/route");
    const strip = {
      externalRecordingId: "ECG-2",
      recordedAt: at.toISOString(),
      samplingFrequency: 512,
      samples: [1, 2, 3, 4],
      averageHeartRate: 61,
      classification: "NOT_DETECTED",
      source: "APPLE_HEALTH",
    };

    const first = await POST(post("/api/insights/ecg", strip));
    expect(first.status).toBe(201);
    expect(
      await deletedCount(
        await DELETE(
          del("/api/insights/ecg/by-external-ids", { externalIds: ["ECG-2"] }),
        ),
      ),
    ).toBe(1);

    // Only the phone can delete a recording: back in HealthKit, it lands.
    const replay = await POST(post("/api/insights/ecg", strip));
    expect(replay.status).toBe(201);
    expect(
      ((await replay.json()) as { data: { status: string } }).data.status,
    ).toBe("inserted");
    expect(await prisma.ecgRecording.count({ where: { userId: OWNER } })).toBe(
      1,
    );
  });
});

describe("DELETE /api/cycle/day-logs/by-external-ids", () => {
  beforeEach(async () => {
    // The truncate may take the seeded catalogue with it.
    const prisma = getPrismaClient();
    const cat = await prisma.cycleSymptomCategory.upsert({
      where: { key: "physical" },
      create: { key: "physical", labelKey: "cycle.symptomCategory.physical" },
      update: {},
    });
    await prisma.cycleSymptom.upsert({
      where: { key: "cramps" },
      create: {
        key: "cramps",
        categoryId: cat.id,
        labelKey: "cycle.symptom.cramps",
        isActive: true,
      },
      update: { isActive: true },
    });
  });

  it("tombstones the Apple Health day with the cycle it opened; a bulk re-post writes it again from empty fields", async () => {
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

    // A new sample of the deleted day that names only a symptom: the day
    // comes back, but the deleted flow does not (iOS #191).
    const replay = await bulk.POST(
      post("/api/cycle/day-logs/bulk", {
        entries: [
          {
            date: day.date,
            source: "APPLE_HEALTH",
            externalId: "CYC-1",
            loggedAt: day.loggedAt,
            symptoms: [{ key: "cramps" }],
          },
        ],
      }),
    );
    const replayBody = (await replay.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(replayBody.data.entries[0]?.status).toBe("updated");
    const revived = await prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: OWNER, externalId: "CYC-1" },
      include: { symptomLinks: { include: { symptom: true } } },
    });
    expect(revived.deletedAt).toBeNull();
    expect(revived.flow).toBeNull();
    expect(revived.symptomLinks.map((l) => [l.symptom.key, l.source])).toEqual([
      ["cramps", "APPLE_HEALTH"],
    ]);
  });

  it("keeps an Apple Health day the person deleted in HealthLog out of a bulk re-post", async () => {
    const prisma = getPrismaClient();
    const bulk = await import("@/app/api/cycle/day-logs/bulk/route");
    const day = {
      date: "2026-10-03",
      flow: "LIGHT",
      source: "APPLE_HEALTH",
      externalId: "cycle-hk:2026-10-03",
      loggedAt: "2026-10-03T08:00:00.000Z",
    };
    expect(
      (await bulk.POST(post("/api/cycle/day-logs/bulk", { entries: [day] })))
        .status,
    ).toBe(200);
    const row = await prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: OWNER, externalId: day.externalId },
    });
    const single = await import("@/app/api/cycle/day-logs/[id]/route");
    const removed = await single.DELETE(
      new NextRequest(`http://localhost/api/cycle/day-logs/${row.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: row.id }) },
    );
    expect(removed.status).toBeLessThan(300);

    const replay = await bulk.POST(
      post("/api/cycle/day-logs/bulk", { entries: [day] }),
    );
    const entries = (
      (await replay.json()) as {
        data: { entries: Array<{ status: string; reason?: string }> };
      }
    ).data.entries;
    expect(entries[0]).toMatchObject({
      status: "skipped",
      reason: "deleted_in_healthlog",
    });
    const after = await prisma.cycleDayLog.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.deletedAt).not.toBeNull();

    // The person writing the day again here brings it back.
    const own = await import("@/app/api/cycle/day-logs/route");
    const written = await own.POST(
      post("/api/cycle/day-logs", {
        date: day.date,
        flow: "HEAVY",
        loggedAt: day.loggedAt,
      }),
    );
    expect(written.status).toBeLessThan(300);
    expect(
      await prisma.cycleDayLog.count({
        where: { userId: OWNER, date: day.date, deletedAt: null },
      }),
    ).toBe(1);
  });
});

describe("DELETE /api/mood-entries/by-external-ids", () => {
  it("tombstones State of Mind entries posted as APPLE_HEALTH, keeps the rest, and a re-post writes the entry back", async () => {
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

    // The phone reported it deleted; posted again, it is in HealthKit again.
    const replay = await bulk.POST(
      post("/api/mood-entries/bulk", { entries: [entry("APPLE_HEALTH", 0)] }),
    );
    const replayBody = (await replay.json()) as {
      data: {
        entries: Array<{ status: string; reason?: string; id?: string }>;
      };
    };
    expect(replayBody.data.entries[0]).toMatchObject({ status: "inserted" });
    expect(replayBody.data.entries[0]?.reason).toBeUndefined();
    expect(
      await prisma.moodEntry.count({
        where: { userId: OWNER, deletedAt: null },
      }),
    ).toBe(2);

    // Deleted in HealthLog, the same re-post stays out.
    const revived = await prisma.moodEntry.findFirstOrThrow({
      where: { userId: OWNER, source: "APPLE_HEALTH", externalId: "SOM-1" },
    });
    const single = await import("@/app/api/mood-entries/[id]/route");
    const removed = await single.DELETE(
      new NextRequest(`http://localhost/api/mood-entries/${revived.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: revived.id }) },
    );
    expect(removed.status).toBeLessThan(300);
    const again = await bulk.POST(
      post("/api/mood-entries/bulk", { entries: [entry("APPLE_HEALTH", 0)] }),
    );
    expect(
      ((await again.json()) as typeof replayBody).data.entries[0],
    ).toMatchObject({ status: "skipped", reason: "deleted_in_healthlog" });
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
      data: {
        entries: Array<{ status: string; reason?: string; id?: string }>;
      };
    };
    // The phone reported the dose deleted in Apple Health; posted again, it
    // is in HealthKit again and lands as a new dose.
    expect(replay.status).toBe(200);
    expect(replayBody.data.entries[0]).toMatchObject({
      index: 0,
      status: "inserted",
    });
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { userId: OWNER, externalId: "DOSE-1", deletedAt: null },
      }),
    ).toBe(1);
  });

  it("refuses the re-post of an Apple Health dose deleted in HealthLog, and lands a new one", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: OWNER,
        name: "Ramipril",
        dose: "5 mg",
        externalSource: "APPLE_HEALTH",
      },
    });
    const bulk = await import("@/app/api/medications/intake/bulk/route");
    const dose = (externalId: string, hour: number) => ({
      medicationId: med.id,
      takenAt: new Date(at.getTime() + hour * 3_600_000).toISOString(),
      scheduledFor: new Date(at.getTime() + hour * 3_600_000).toISOString(),
      source: "APPLE_HEALTH",
      externalId,
    });
    const send = async (entries: unknown[]) =>
      (
        (await (
          await bulk.POST(post("/api/medications/intake/bulk", { entries }))
        ).json()) as {
          data: { entries: Array<{ status: string; reason?: string }> };
        }
      ).data.entries.map((e) => [e.status, e.reason]);

    expect(await send([dose("DOSE-H", 0)])).toEqual([["inserted", undefined]]);
    const row = await prisma.medicationIntakeEvent.findFirstOrThrow({
      where: { userId: OWNER, externalId: "DOSE-H" },
    });
    // Deleted the way the web and the app delete one dose.
    const { DELETE } =
      await import("@/app/api/medications/[id]/intake/[eventId]/route");
    const removed = await DELETE(
      new NextRequest(
        `http://localhost/api/medications/${med.id}/intake/${row.id}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: med.id, eventId: row.id }) },
    );
    expect(removed.status).toBeLessThan(300);

    // A fresh install reads the whole history: the deleted dose stays out,
    // a dose it had not sent before lands.
    expect(await send([dose("DOSE-H", 0), dose("DOSE-NEW", 4)])).toEqual([
      ["skipped", "deleted_in_healthlog"],
      ["inserted", undefined],
    ]);
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { userId: OWNER, deletedAt: null },
      }),
    ).toBe(1);
  });
});

describe("DELETE /api/measurements/by-external-ids, then a re-post", () => {
  // One reading per id, each at its own minute (the reading key is unique).
  const weight = (externalId: string, value = 80) => {
    const when = new Date(at.getTime() + (value - 80) * 60_000).toISOString();
    return {
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value,
      unit: "kg",
      startDate: when,
      endDate: when,
      externalId,
    };
  };
  const send = async (entries: unknown[]) => {
    const { POST } = await import("@/app/api/measurements/batch/route");
    const res = await POST(post("/api/measurements/batch", { entries }));
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        data: { entries: Array<{ status: string; reason?: string }> };
      }
    ).data.entries.map((e) => [e.status, e.reason]);
  };

  it("writes a sample the phone reported deleted again, and keeps one the person deleted out", async () => {
    const prisma = getPrismaClient();
    expect(await send([weight("W-AH"), weight("W-PERSON", 81)])).toEqual([
      ["inserted", undefined],
      ["inserted", undefined],
    ]);

    const { DELETE } =
      await import("@/app/api/measurements/by-external-ids/route");
    expect(
      await deletedCount(
        await DELETE(
          del("/api/measurements/by-external-ids", { externalIds: ["W-AH"] }),
        ),
      ),
    ).toBe(1);
    const reported = await prisma.measurement.findFirstOrThrow({
      where: { userId: OWNER, externalId: "W-AH" },
      select: { deletedAt: true, appleHealthDeletedAt: true },
    });
    expect(reported.appleHealthDeletedAt).toEqual(reported.deletedAt);

    const person = await prisma.measurement.findFirstOrThrow({
      where: { userId: OWNER, externalId: "W-PERSON" },
    });
    const single = await import("@/app/api/measurements/[id]/route");
    const removed = await single.DELETE(
      new NextRequest(`http://localhost/api/measurements/${person.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: person.id }) },
    );
    expect(removed.status).toBeLessThan(300);

    // A fresh install reads the whole history again.
    expect(await send([weight("W-AH"), weight("W-PERSON", 81)])).toEqual([
      ["updated", undefined],
      ["skipped", "deleted_in_healthlog"],
    ]);
    const rows = await prisma.measurement.findMany({
      where: { userId: OWNER },
      select: { externalId: true, deletedAt: true, appleHealthDeletedAt: true },
      orderBy: { externalId: "asc" },
    });
    expect(rows.map((r) => [r.externalId, r.deletedAt === null])).toEqual([
      ["W-AH", true],
      ["W-PERSON", false],
    ]);
    expect(rows[0]?.appleHealthDeletedAt).toBeNull();
  });
});
