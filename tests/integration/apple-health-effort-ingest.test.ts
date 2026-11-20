/**
 * Apple effort from HealthKit, against real Postgres.
 *
 * The logged workout-effort score, the watch's estimate and physical effort
 * used to sit in the deferred set and were refused per entry. They are three
 * types now, so a day mean of the logged score cannot blend in the estimate.
 * Physical effort is a rate in kcal/(hr·kg), never added to energy. The batch
 * route stores them, a full backup brings the same rows back, and
 * `GET /api/integrations/healthkit` tells the app the server takes them.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import { POST as RESTORE } from "./restore-job-driver";

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

vi.mock("@/lib/cache/invalidate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cache/invalidate")>();
  return { ...actual, invalidateUserData: vi.fn() };
});

const LOGGED = "HKQuantityTypeIdentifierWorkoutEffortScore";
const ESTIMATED = "HKQuantityTypeIdentifierEstimatedWorkoutEffortScore";
const PHYSICAL = "HKQuantityTypeIdentifierPhysicalEffort";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "apple-effort-owner",
      email: "apple-effort-owner@example.test",
      timezone: "UTC",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return owner.id;
}

describe("Apple effort ingest", () => {
  it("lists the three identifiers in acceptedTypes", async () => {
    await signIn();
    const { GET } = await import("@/app/api/integrations/healthkit/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { acceptedTypes: string[] } };
    expect(body.data.acceptedTypes).toEqual(
      expect.arrayContaining([LOGGED, ESTIMATED, PHYSICAL]),
    );
  });

  it("stores the logged score, the estimate and the rate as three types", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/measurements/batch/route");
    const at = "2026-06-01T08:00:00.000Z";
    const res = await POST(
      new NextRequest("http://localhost/api/measurements/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: LOGGED,
              value: 7,
              unit: "count",
              startDate: at,
              endDate: at,
              externalId: "sample:workout-effort-logged",
            },
            {
              hkIdentifier: ESTIMATED,
              value: 6.4,
              unit: "count",
              startDate: at,
              endDate: at,
              externalId: "sample:workout-effort-estimated",
            },
            {
              hkIdentifier: PHYSICAL,
              value: 8.5,
              unit: "kcal/(hr*kg)",
              startDate: at,
              endDate: at,
              externalId: "sample:physical-effort",
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries.map((e) => e.status)).toEqual([
      "inserted",
      "inserted",
      "inserted",
    ]);

    const select = {
      type: true,
      value: true,
      unit: true,
      source: true,
      externalId: true,
      measuredAt: true,
    } as const;
    const stored = await prisma.measurement.findMany({
      where: { userId, deletedAt: null },
      orderBy: { type: "asc" },
      select,
    });
    // Prisma orders an enum column by the enum's declaration order in
    // PostgreSQL, not alphabetically, so sort by name before comparing.
    expect(
      stored
        .map(({ type, value, unit }) => ({ type, value, unit }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    ).toEqual([
      {
        type: "ESTIMATED_WORKOUT_EFFORT_SCORE",
        value: 6.4,
        unit: "score",
      },
      { type: "PHYSICAL_EFFORT", value: 8.5, unit: "kcal/(hr·kg)" },
      { type: "WORKOUT_EFFORT_SCORE", value: 7, unit: "score" },
    ]);

    const { payload: built } = await buildFullBackupPayload(prisma, userId, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await prisma.dataBackup.create({
      data: {
        userId,
        type: "APPLE_EFFORT_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });
    await prisma.measurement.deleteMany({ where: { userId } });

    const restore = await RESTORE(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof RESTORE>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(restore.status).toBe(200);

    const restored = await prisma.measurement.findMany({
      where: { userId, deletedAt: null },
      orderBy: { type: "asc" },
      select,
    });
    expect(restored).toEqual(stored);
  });

  it("refuses a score and a rate outside the plausibility band", async () => {
    await signIn();
    const { POST } = await import("@/app/api/measurements/batch/route");
    const at = "2026-06-01T08:00:00.000Z";
    const res = await POST(
      new NextRequest("http://localhost/api/measurements/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: LOGGED,
              value: 11,
              unit: "count",
              startDate: at,
              endDate: at,
              externalId: "sample:workout-effort-too-high",
            },
            {
              hkIdentifier: ESTIMATED,
              value: 11,
              unit: "count",
              startDate: at,
              endDate: at,
              externalId: "sample:estimated-effort-too-high",
            },
            {
              hkIdentifier: PHYSICAL,
              value: 80,
              unit: "kcal/(hr*kg)",
              startDate: at,
              endDate: at,
              externalId: "sample:physical-effort-too-high",
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries.map((e) => e.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);
  });
});
