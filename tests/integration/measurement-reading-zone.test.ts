/**
 * The time zone per reading (iOS #181), against real Postgres.
 *
 * The batch route stores the IANA zone a sample was taken in, refuses to
 * store a name the database cannot read (the entry still lands), and a full
 * backup brings the zone back. A night slept abroad files under its own
 * zone's wake day in the night view and in the SQL page of the sleep list,
 * and the day view counts a reading on its own zone's day.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import {
  readNightSessions,
  sleepNightPage,
} from "@/lib/measurements/list/sleep-nights";
import { resolveDayReadings } from "@/lib/mood/linked-context";
import { localDayWindow } from "@/lib/tz/local-day";
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

const PROFILE_ZONE = "Europe/Berlin";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "reading-zone-owner",
      email: "reading-zone-owner@example.test",
      timezone: PROFILE_ZONE,
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
  const res = await POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    data: { entries: Array<{ status: string }> };
  };
}

/** A sleep stage sample ending at `end`, `minutes` long. */
function stage(end: string, value: number, minutes: number, timeZone?: string) {
  const endMs = Date.parse(end);
  return {
    hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
    value: minutes,
    unit: "min",
    sleepStage: value,
    startDate: new Date(endMs - minutes * 60_000).toISOString(),
    endDate: end,
    externalId: `sleep-${end}`,
    ...(timeZone ? { timeZone } : {}),
  };
}

describe("time zone per reading", () => {
  it("stores the zone, keeps an unreadable one out, and restores it", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    // One minute apart: the same instant would be one reading.
    const weight = (externalId: string, minute: number, timeZone?: string) => ({
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value: 80,
      unit: "kg",
      startDate: `2026-06-02T03:3${minute}:00.000Z`,
      endDate: `2026-06-02T03:3${minute}:00.000Z`,
      externalId,
      ...(timeZone ? { timeZone } : {}),
    });
    const body = await postBatch([
      weight("w-ny", 0, "America/New_York"),
      weight("w-bad", 1, "Mars/Olympus_Mons"),
      weight("w-none", 2),
    ]);
    expect(body.data.entries.map((e) => e.status)).toEqual([
      "inserted",
      "inserted",
      "inserted",
    ]);
    const select = { externalId: true, timeZone: true } as const;
    const stored = await prisma.measurement.findMany({
      where: { userId },
      orderBy: { externalId: "asc" },
      select,
    });
    expect(stored).toEqual([
      { externalId: "w-bad", timeZone: null },
      { externalId: "w-none", timeZone: null },
      { externalId: "w-ny", timeZone: "America/New_York" },
    ]);

    const { payload } = await buildFullBackupPayload(prisma, userId, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(payload));
    const backup = await prisma.dataBackup.create({
      data: {
        userId,
        type: "READING_ZONE_ROUND_TRIP",
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
    expect(
      await prisma.measurement.findMany({
        where: { userId },
        orderBy: { externalId: "asc" },
        select,
      }),
    ).toEqual(stored);
  });

  it("files a night slept abroad under its own wake day, in the view and the list", async () => {
    const userId = await signIn();
    // 16:30 to 21:30 in New York on 1 June: ends 01:30 UTC on 2 June, which
    // is 03:30 on 2 June in Berlin. HK sleep values: 3 core, 4 deep, 5 REM.
    await postBatch([
      stage("2026-06-01T22:30:00.000Z", 3, 120, "America/New_York"),
      stage("2026-06-02T00:00:00.000Z", 4, 90, "America/New_York"),
      stage("2026-06-02T01:30:00.000Z", 5, 90, "America/New_York"),
    ]);
    const abroad = await readNightSessions(
      userId,
      "2026-06-01",
      PROFILE_ZONE,
      null,
    );
    expect(abroad.sessions).toHaveLength(1);
    expect(abroad.sessions[0]!.timeZone).toBe("America/New_York");
    expect(
      (await readNightSessions(userId, "2026-06-02", PROFILE_ZONE, null))
        .sessions,
    ).toHaveLength(0);
    const page = await sleepNightPage(userId, PROFILE_ZONE, {
      sortDir: "desc",
      limit: 10,
      offset: 0,
    });
    expect(page.nights.map((n) => n.night)).toEqual(["2026-06-01"]);
  });

  it("counts a reading on its own zone's day in the day view", async () => {
    const userId = await signIn();
    // 03:30 UTC on 2 June: 1 June in New York, 2 June in Berlin.
    const at = "2026-06-02T03:30:00.000Z";
    await postBatch([
      {
        hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
        value: 80,
        unit: "kg",
        startDate: at,
        endDate: at,
        externalId: "w-abroad",
        timeZone: "America/New_York",
      },
    ]);
    const read = (day: string) =>
      resolveDayReadings(
        userId,
        day,
        PROFILE_ZONE,
        localDayWindow(day, PROFILE_ZONE),
        () => true,
        null,
      );
    expect((await read("2026-06-01")).rowsByType.get("WEIGHT")).toHaveLength(1);
    expect((await read("2026-06-02")).rowsByType.get("WEIGHT")).toBeUndefined();
  });
});
