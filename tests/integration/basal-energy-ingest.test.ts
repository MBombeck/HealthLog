/**
 * Resting energy from HealthKit (#1340), against real Postgres:
 * `HKQuantityTypeIdentifierBasalEnergyBurned` used to sit in the deferred set
 * and was refused per entry. It is a type of its own now. The batch route
 * stores it as `BASAL_ENERGY_BURNED`, apart from active energy, the row comes
 * back out of a full backup restore unchanged, and `GET
 * /api/integrations/healthkit` tells the app the server takes it.
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

const BASAL = "HKQuantityTypeIdentifierBasalEnergyBurned";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "basal-energy-owner",
      email: "basal-energy-owner@example.test",
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

describe("resting energy ingest (#1340)", () => {
  it("lists the identifier in acceptedTypes", async () => {
    await signIn();
    const { GET } = await import("@/app/api/integrations/healthkit/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { acceptedTypes: string[] } };
    expect(body.data.acceptedTypes).toContain(BASAL);
  });

  it("stores a batch entry as BASAL_ENERGY_BURNED and restores it from a backup", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/measurements/batch/route");
    const at = "2026-10-01T10:00:00.000Z";
    const res = await POST(
      new NextRequest("http://localhost/api/measurements/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: BASAL,
              value: 1650,
              unit: "kcal",
              startDate: at,
              endDate: at,
              externalId: `stats:${BASAL}:2026-10-01`,
            },
            {
              hkIdentifier: "HKQuantityTypeIdentifierActiveEnergyBurned",
              value: 420,
              unit: "kcal",
              startDate: at,
              endDate: at,
              externalId:
                "stats:HKQuantityTypeIdentifierActiveEnergyBurned:2026-10-01",
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
    expect(
      stored.map(({ type, value, unit }) => ({ type, value, unit })),
    ).toEqual([
      { type: "ACTIVE_ENERGY_BURNED", value: 420, unit: "kcal" },
      { type: "BASAL_ENERGY_BURNED", value: 1650, unit: "kcal" },
    ]);

    const { payload: built } = await buildFullBackupPayload(prisma, userId, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await prisma.dataBackup.create({
      data: {
        userId,
        type: "BASAL_ENERGY_ROUND_TRIP",
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
});
