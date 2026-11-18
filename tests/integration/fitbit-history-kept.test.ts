/**
 * What a Fitbit user keeps after the integration is gone.
 *
 * Google turned the Fitbit Web API off on 30 October 2026 and HealthLog no
 * longer connects to it. Every reading it imported stays the person's data:
 * the chart reads it, the CSV export carries it with its source, the doctor
 * report draws it, and a full backup brings it back on restore still marked
 * as Fitbit. A backup file written while the integration existed may carry
 * keys for it (the connection, the app credentials); a restore ignores them
 * and brings back everything else.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
import { invalidateUserTimezone } from "@/lib/tz/resolver";
import { parseBackupPayload } from "@/lib/validations/backup";

import { cookieJar, headerJar } from "./mock-next-headers";
import { POST as RESTORE } from "./restore-job-driver";
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

const DAY = 86_400_000;
const prisma = () => getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma());
  cookieJar.clear();
  headerJar.clear();
});

/** An admin owner with a live session and ten days of Fitbit weighings. */
async function seedFitbitHistory(username: string) {
  const owner = await prisma().user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "ADMIN",
      timezone: "UTC",
    },
  });
  invalidateUserTimezone(owner.id);
  const session = await prisma().session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  await prisma().measurement.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      userId: owner.id,
      type: "WEIGHT" as const,
      value: 80 + i / 10,
      unit: "kg",
      source: "FITBIT" as const,
      measuredAt: new Date(noon.getTime() - (i + 1) * DAY),
      externalId: `fitbit:weight:${i}`,
    })),
  });
  await prisma().workout.create({
    data: {
      userId: owner.id,
      source: "FITBIT",
      sportType: "running",
      startedAt: new Date(noon.getTime() - 3 * DAY),
      endedAt: new Date(noon.getTime() - 3 * DAY + 1_800_000),
      durationSec: 1_800,
      externalId: "fitbit:workout:1",
    },
  });
  return owner;
}

async function restore(backupId: string) {
  return RESTORE(
    new Request(`http://localhost/api/admin/backups/${backupId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as unknown as Parameters<typeof RESTORE>[0],
    { params: Promise.resolve({ id: backupId }) },
  );
}

describe("Fitbit history after the integration is gone", () => {
  it("charts, exports and reports the imported readings as Fitbit", async () => {
    const owner = await seedFitbitHistory("fitbit-history-read");

    const { GET: SERIES } = await import("@/app/api/measurements/series/route");
    const seriesRes = await SERIES(
      new NextRequest(
        "http://localhost/api/measurements/series?kind=weight&days=30",
      ),
    );
    expect(seriesRes.status).toBe(200);
    const series = (await seriesRes.json()) as {
      data: { points: unknown[]; stats: { count: number } };
    };
    expect(series.data.stats.count).toBe(10);

    const { GET: EXPORT } = await import("@/app/api/export/measurements/route");
    const exportRes = await EXPORT(
      new Request("http://localhost/api/export/measurements") as Parameters<
        typeof EXPORT
      >[0],
    );
    expect(exportRes.status).toBe(200);
    const csv = await exportRes.text();
    const fitbitLines = csv
      .split("\n")
      .filter((line) => line.includes("FITBIT"));
    expect(fitbitLines).toHaveLength(10);

    const end = new Date();
    const report = await collectDoctorReportData(
      owner.id,
      { start: new Date(end.getTime() - 30 * DAY), end, days: 30 },
      selectionFromLeaves(["WEIGHT"]),
    );
    expect(report.measurements.WEIGHT).toHaveLength(10);
  });

  it("restores the readings and the workout from a full backup, still Fitbit", async () => {
    const owner = await seedFitbitHistory("fitbit-history-backup");

    const { payload } = await buildFullBackupPayload(prisma(), owner.id, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(payload));
    const backup = await prisma().dataBackup.create({
      data: {
        userId: owner.id,
        type: "FITBIT_HISTORY_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });
    await prisma().measurement.deleteMany({ where: { userId: owner.id } });
    await prisma().workout.deleteMany({ where: { userId: owner.id } });

    expect((await restore(backup.id)).status).toBe(200);

    expect(
      await prisma().measurement.count({
        where: { userId: owner.id, source: "FITBIT", deletedAt: null },
      }),
    ).toBe(10);
    expect(
      await prisma().workout.count({
        where: { userId: owner.id, source: "FITBIT" },
      }),
    ).toBe(1);
  });

  it("restores a file written while the integration existed, ignoring its Fitbit keys", async () => {
    const owner = await seedFitbitHistory("fitbit-history-legacy-file");

    const { payload } = await buildFullBackupPayload(prisma(), owner.id, {
      purpose: "disaster-recovery",
    });
    // What an older writer could have left in the file: a connection section
    // and the app credentials beside the account settings.
    const legacy = {
      ...(payload as Record<string, unknown>),
      fitbitConnection: {
        fitbitUserId: "FB-LEGACY",
        accessToken: "sealed-access",
        refreshToken: "sealed-refresh",
        tokenExpiresAt: "2026-10-01T00:00:00.000Z",
      },
      fitbitOAuthStates: [],
      accountSettings: {
        ...((payload as { accountSettings?: Record<string, unknown> })
          .accountSettings ?? {}),
        fitbitClientIdEncrypted: "sealed-client-id",
        fitbitClientSecretEncrypted: "sealed-client-secret",
      },
    };
    const parsed = parseBackupPayload(JSON.stringify(legacy));
    const backup = await prisma().dataBackup.create({
      data: {
        userId: owner.id,
        type: "FITBIT_LEGACY_FILE",
        data: encrypt(JSON.stringify(parsed)),
      },
    });
    await prisma().measurement.deleteMany({ where: { userId: owner.id } });
    await prisma().workout.deleteMany({ where: { userId: owner.id } });

    expect((await restore(backup.id)).status).toBe(200);

    expect(
      await prisma().measurement.count({
        where: { userId: owner.id, source: "FITBIT", deletedAt: null },
      }),
    ).toBe(10);
    expect(
      await prisma().workout.count({
        where: { userId: owner.id, source: "FITBIT" },
      }),
    ).toBe(1);
  });
});
