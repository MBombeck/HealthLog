/**
 * A backup written before migration 0420 restores Fitbit and Google Health
 * HRV as RMSSD.
 *
 * Both providers report a nightly RMSSD, which their mappers used to file as
 * `HEART_RATE_VARIABILITY` (the SDNN series). Migration 0420 moved those rows
 * to `HRV_RMSSD`; a file written before it still carries them under the old
 * type, and a verbatim restore would undo the migration for the account. The
 * file here is built by the real writer from rows filed the old way, so it is
 * the shape such a backup has.
 */
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("restoring a backup written before migration 0420", () => {
  it("files Fitbit and Google Health HRV as RMSSD and keeps Apple SDNN", async () => {
    const prisma = getPrismaClient();
    const owner = await prisma.user.create({
      data: {
        username: "legacy-rmssd-owner",
        email: "legacy-rmssd-owner@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const row = (
      type: "HEART_RATE_VARIABILITY" | "HRV_RMSSD",
      source: "FITBIT" | "GOOGLE_HEALTH" | "APPLE_HEALTH",
      day: string,
      value: number,
    ) => ({
      userId: owner.id,
      type,
      source,
      value,
      unit: "ms",
      measuredAt: new Date(`${day}T06:00:00.000Z`),
      externalId: `${source.toLowerCase()}:${day}:hrv`,
    });
    await prisma.measurement.createMany({
      data: [
        // Filed the old way.
        row("HEART_RATE_VARIABILITY", "FITBIT", "2026-09-01", 41),
        row("HEART_RATE_VARIABILITY", "GOOGLE_HEALTH", "2026-09-02", 38),
        // A Fitbit night the file holds under both types: the RMSSD twin wins.
        row("HEART_RATE_VARIABILITY", "FITBIT", "2026-09-03", 99),
        row("HRV_RMSSD", "FITBIT", "2026-09-03", 44),
        // A real SDNN reading stays where it is.
        row("HEART_RATE_VARIABILITY", "APPLE_HEALTH", "2026-09-01", 52),
        // No externalId: twinned with a live RMSSD row only by night.
        {
          ...row("HEART_RATE_VARIABILITY", "GOOGLE_HEALTH", "2026-09-04", 77),
          externalId: null,
        },
        row("HRV_RMSSD", "GOOGLE_HEALTH", "2026-09-04", 36),
        // Twinned only with a tombstone: the live row wins the night.
        row("HEART_RATE_VARIABILITY", "FITBIT", "2026-09-05", 45),
        {
          ...row("HRV_RMSSD", "FITBIT", "2026-09-05", 1),
          // Recent, so the tombstone horizon does not drop it first.
          deletedAt: new Date(Date.now() - 86_400_000),
        },
      ],
    });
    const legacyBest = await prisma.measurement.findFirstOrThrow({
      where: { userId: owner.id, source: "FITBIT", value: 99 },
    });
    await prisma.personalRecord.create({
      data: {
        userId: owner.id,
        metricType: "HEART_RATE_VARIABILITY",
        direction: "MAX",
        value: 99,
        unit: "ms",
        achievedAt: legacyBest.measuredAt,
        sourceMeasurementId: legacyBest.id,
        source: "FITBIT",
      },
    });

    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await prisma.dataBackup.create({
      data: {
        userId: owner.id,
        type: "LEGACY_RMSSD_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });
    await prisma.personalRecord.deleteMany({ where: { userId: owner.id } });
    await prisma.measurement.deleteMany({ where: { userId: owner.id } });

    const response = await RESTORE(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof RESTORE>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    const restored = await prisma.measurement.findMany({
      where: { userId: owner.id, deletedAt: null },
      select: { type: true, source: true, value: true },
      orderBy: [{ source: "asc" }, { measuredAt: "asc" }],
    });
    expect(restored).toEqual([
      { type: "HEART_RATE_VARIABILITY", source: "APPLE_HEALTH", value: 52 },
      { type: "HRV_RMSSD", source: "FITBIT", value: 41 },
      { type: "HRV_RMSSD", source: "FITBIT", value: 44 },
      { type: "HRV_RMSSD", source: "FITBIT", value: 45 },
      { type: "HRV_RMSSD", source: "GOOGLE_HEALTH", value: 38 },
      { type: "HRV_RMSSD", source: "GOOGLE_HEALTH", value: 36 },
    ]);
    // The tombstone that shared the live row's night is the one left out.
    expect(
      await prisma.measurement.count({
        where: { userId: owner.id, deletedAt: { not: null } },
      }),
    ).toBe(0);
    // The SDNN best an RMSSD reading set does not come back.
    expect(
      await prisma.personalRecord.count({ where: { userId: owner.id } }),
    ).toBe(0);
  });
});
