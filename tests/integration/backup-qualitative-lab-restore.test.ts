/**
 * A backup holding a qualitative lab marker restores.
 *
 * A qualitative reading ("positive", "trace") has no unit, so its marker is
 * minted with an empty unit and the reading stored under it
 * (`POST /api/labs`, `isQualitative`). The backup schema demanded a non-empty
 * unit on both rows, so the file the account's own backup wrote could not be
 * read back: the parse refused it and the restore never started. Asserted on
 * rows through the real writer, the real wire format, the real parser and the
 * real restore, with the marker removed first so the file is the only copy.
 *
 * The empty unit is accepted for a qualitative reading and a marker none of
 * whose readings is numeric; a numeric reading, or a marker a numeric reading
 * is filed under, still needs its unit.
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("a backup with a qualitative lab marker", () => {
  it("restores the marker and its reading", async () => {
    const prisma = getPrismaClient();
    const owner = await prisma.user.create({
      data: {
        username: "qualitative-lab-owner",
        email: "qualitative-lab-owner@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    // The real write path mints the marker with an empty unit.
    const { POST: CREATE_LAB } = await import("@/app/api/labs/route");
    const created = await CREATE_LAB(
      new NextRequest("http://localhost/api/labs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          analyte: "Urine glucose",
          valueText: "negative",
          takenAt: "2026-07-01T08:00:00.000Z",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const marker = await prisma.biomarker.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(marker.unit).toBe("");

    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });
    // The parse is where the file used to be refused.
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await prisma.dataBackup.create({
      data: {
        userId: owner.id,
        type: "QUALITATIVE_LAB_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });

    await prisma.labResult.deleteMany({ where: { userId: owner.id } });
    await prisma.biomarker.deleteMany({ where: { userId: owner.id } });

    const response = await RESTORE(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof RESTORE>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    const restoredMarker = await prisma.biomarker.findFirstOrThrow({
      where: { userId: owner.id, name: "Urine glucose" },
    });
    expect(restoredMarker.unit).toBe("");
    const restoredReading = await prisma.labResult.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(restoredReading).toMatchObject({
      biomarkerId: restoredMarker.id,
      value: null,
      valueText: "negative",
      unit: "",
    });
  });
});
