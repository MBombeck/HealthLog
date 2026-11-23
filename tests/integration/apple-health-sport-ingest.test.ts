/**
 * Apple sport quantities from HealthKit, against real Postgres (#1415).
 *
 * Cycling and rowing distance, rowing speed and the running dynamics used to
 * sit in the deferred set and were refused per entry. They are eight types
 * now: the batch route stores them in their canonical unit, a full backup
 * brings the same rows back, and `GET /api/integrations/healthkit` tells the
 * app the server takes them.
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

const SPORT = [
  ["HKQuantityTypeIdentifierDistanceCycling", 18250, "m", "CYCLING_DISTANCE"],
  ["HKQuantityTypeIdentifierDistanceRowing", 5200, "m", "ROWING_DISTANCE"],
  ["HKQuantityTypeIdentifierRowingSpeed", 3.4, "m/s", "ROWING_SPEED"],
  ["HKQuantityTypeIdentifierRunningSpeed", 3.1, "m/s", "RUNNING_SPEED"],
  ["HKQuantityTypeIdentifierRunningPower", 262, "W", "RUNNING_POWER"],
  [
    "HKQuantityTypeIdentifierRunningGroundContactTime",
    248,
    "ms",
    "RUNNING_GROUND_CONTACT_TIME",
  ],
  [
    "HKQuantityTypeIdentifierRunningVerticalOscillation",
    8.6,
    "cm",
    "RUNNING_VERTICAL_OSCILLATION",
  ],
  [
    "HKQuantityTypeIdentifierRunningStrideLength",
    1.12,
    "m",
    "RUNNING_STRIDE_LENGTH",
  ],
] as const;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "apple-sport-owner",
      email: "apple-sport-owner@example.test",
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

async function postBatch(entries: unknown[]) {
  const { POST } = await import("@/app/api/measurements/batch/route");
  return POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
}

describe("Apple sport quantity ingest", () => {
  it("lists the eight identifiers in acceptedTypes", async () => {
    await signIn();
    const { GET } = await import("@/app/api/integrations/healthkit/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { acceptedTypes: string[] } };
    expect(body.data.acceptedTypes).toEqual(
      expect.arrayContaining(SPORT.map(([hk]) => hk)),
    );
  });

  it("stores each quantity as its own type and restores it from a backup", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    const at = "2026-06-02T07:00:00.000Z";
    const res = await postBatch(
      SPORT.map(([hk, value, unit]) => ({
        hkIdentifier: hk,
        value,
        unit,
        startDate: at,
        endDate: at,
        externalId: `sample:${hk}`,
      })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries.map((e) => e.status)).toEqual(
      SPORT.map(() => "inserted"),
    );

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
      orderBy: { externalId: "asc" },
      select,
    });
    expect(
      stored
        .map(({ type, value, unit }) => ({ type, value, unit }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    ).toEqual(
      SPORT.map(([, value, unit, type]) => ({ type, value, unit })).sort(
        (a, b) => a.type.localeCompare(b.type),
      ),
    );

    const { payload: built } = await buildFullBackupPayload(prisma, userId, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await prisma.dataBackup.create({
      data: {
        userId,
        type: "APPLE_SPORT_ROUND_TRIP",
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
      orderBy: { externalId: "asc" },
      select,
    });
    expect(restored).toEqual(stored);
  });

  it("overwrites a day total of cycling distance sent again", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    const day = "2026-06-02";
    const entry = (value: number) => ({
      hkIdentifier: "HKQuantityTypeIdentifierDistanceCycling",
      value,
      unit: "m",
      startDate: `${day}T00:00:00.000Z`,
      endDate: `${day}T23:59:59.000Z`,
      externalId: `stats:HKQuantityTypeIdentifierDistanceCycling:${day}`,
    });
    expect((await postBatch([entry(12000)])).status).toBe(200);
    expect((await postBatch([entry(18250)])).status).toBe(200);
    const rows = await prisma.measurement.findMany({
      where: { userId, type: "CYCLING_DISTANCE", deletedAt: null },
      select: { value: true },
    });
    expect(rows).toEqual([{ value: 18250 }]);
  });

  it("refuses a stride measure that slipped a unit", async () => {
    await signIn();
    const at = "2026-06-03T05:30:00.000Z";
    const res = await postBatch([
      {
        hkIdentifier: "HKQuantityTypeIdentifierRunningVerticalOscillation",
        value: 86,
        unit: "cm",
        startDate: at,
        endDate: at,
        externalId: "sample:vertical-oscillation-mm",
      },
      {
        hkIdentifier: "HKQuantityTypeIdentifierRunningSpeed",
        value: 30,
        unit: "m/s",
        startDate: at,
        endDate: at,
        externalId: "sample:running-speed-car",
      },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries.map((e) => e.status)).toEqual([
      "skipped",
      "skipped",
    ]);
  });
});
