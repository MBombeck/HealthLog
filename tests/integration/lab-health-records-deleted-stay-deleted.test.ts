/**
 * A Health Records lab result the person deleted stays deleted.
 *
 * The Apple Health export carries the whole clinical history every time, and
 * the phone resends what it holds, so the import recognises a reading by the
 * identity it arrived under. That memory lived only on the reading's own row,
 * and three ways of losing the row brought the reading back on the next
 * import:
 *
 *   - deleting the whole marker, which removes its readings outright;
 *   - the nightly purge, which removes a deleted reading for good once its
 *     tombstone has aged out;
 *   - a portable backup, which leaves deleted readings out, restored onto an
 *     instance that has never seen the account.
 *
 * The identity of a deleted reading is now kept in the import ledger
 * (`LabResultImportKey`) the moment it is deleted, and taken out again when
 * the deletion is undone. Against Postgres, through the real routes.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { purgeSoftDeletedTable } from "@/lib/jobs/soft-delete-retention";
import { writeFhirLabReadings } from "@/lib/labs/fhir-import/write";
import type { MappedFhirLab } from "@/lib/labs/fhir-import/types";
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

const prisma = getPrismaClient();
let USER = "";

beforeEach(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  const user = await prisma.user.create({
    data: {
      username: "deleted-stays-deleted",
      email: "deleted-stays-deleted@example.test",
      role: "ADMIN",
      timezone: "UTC",
      modulePreferencesJson: { labs: true },
    },
  });
  USER = user.id;
  await signIn();
});

async function signIn() {
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

function reading(n: number, over: Partial<MappedFhirLab> = {}): MappedFhirLab {
  return {
    externalId: `fhir:clinic:obs-${n}`,
    analyte: "Ferritin",
    loinc: null,
    catalogKey: null,
    value: 80 + n,
    valueText: null,
    unit: "ng/mL",
    takenAt: new Date(Date.UTC(2026, 5, n, 7)),
    sourceReferenceLow: 30,
    sourceReferenceHigh: 400,
    sourceReferenceText: null,
    panel: null,
    note: null,
    ...over,
  };
}

const BATCH = [reading(1), reading(2), reading(3, { analyte: "Glucose" })];

async function importBatch() {
  return writeFhirLabReadings({
    userId: USER,
    tz: "UTC",
    readings: BATCH,
    prisma,
  });
}

async function liveReadings() {
  return prisma.labResult.findMany({
    where: { userId: USER, deletedAt: null },
    select: { analyte: true, externalId: true },
    orderBy: { externalId: "asc" },
  });
}

async function deleteMarker(name: string) {
  const marker = await prisma.biomarker.findFirstOrThrow({
    where: { userId: USER, name },
  });
  const { DELETE } = await import("@/app/api/biomarkers/[id]/route");
  const res = await DELETE(
    new NextRequest(`http://localhost/api/biomarkers/${marker.id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: marker.id }) },
  );
  expect(res.status).toBe(200);
}

async function deleteReading(externalId: string) {
  const row = await prisma.labResult.findFirstOrThrow({
    where: { userId: USER, externalId },
  });
  const { DELETE } = await import("@/app/api/labs/[id]/route");
  const res = await DELETE(
    new NextRequest(`http://localhost/api/labs/${row.id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: row.id }) },
  );
  expect(res.status).toBe(200);
  return row.id;
}

describe("a deleted Health Records reading", () => {
  it("does not come back after its whole marker is deleted", async () => {
    expect((await importBatch()).inserted).toBe(3);
    await deleteMarker("Ferritin");
    expect(await liveReadings()).toEqual([
      { analyte: "Glucose", externalId: "fhir:clinic:obs-3" },
    ]);

    const again = await importBatch();
    expect(again.inserted).toBe(0);
    expect(again.duplicate).toBe(3);
    expect(await liveReadings()).toHaveLength(1);
    expect(
      await prisma.biomarker.count({
        where: { userId: USER, name: "Ferritin" },
      }),
    ).toBe(0);
  });

  it("does not come back once the purge has removed its tombstone", async () => {
    await importBatch();
    await deleteReading("fhir:clinic:obs-1");
    // Long past the retention horizon.
    const later = new Date(Date.now() + 400 * 86_400_000);
    const purged = await purgeSoftDeletedTable(prisma, "LabResult", later);
    expect(purged.deleted).toBe(1);
    expect(
      await prisma.labResult.count({
        where: { userId: USER, externalId: "fhir:clinic:obs-1" },
      }),
    ).toBe(0);

    const again = await importBatch();
    expect(again.inserted).toBe(0);
    expect(await liveReadings()).toHaveLength(2);
  });

  it("comes back to life only through its own undo", async () => {
    await importBatch();
    const id = await deleteReading("fhir:clinic:obs-1");
    const { POST } = await import("@/app/api/labs/restore/route");
    const res = await POST(
      new NextRequest("http://localhost/api/labs/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await liveReadings()).toHaveLength(3);

    // Deleted again later, it stays deleted again, purge or not.
    await deleteReading("fhir:clinic:obs-1");
    await purgeSoftDeletedTable(
      prisma,
      "LabResult",
      new Date(Date.now() + 400 * 86_400_000),
    );
    expect((await importBatch()).inserted).toBe(0);
    expect(await liveReadings()).toHaveLength(2);
  });

  it("stays deleted through a portable backup restored onto a fresh instance", async () => {
    await importBatch();
    await deleteReading("fhir:clinic:obs-1");
    await deleteMarker("Glucose");

    const { payload: built } = await buildFullBackupPayload(prisma, USER, {
      purpose: "portable-export",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));

    // The fresh instance: the account as the file brings it, nothing else.
    await prisma.labResult.deleteMany({ where: { userId: USER } });
    await prisma.biomarker.deleteMany({ where: { userId: USER } });
    await prisma.labResultImportKey.deleteMany({ where: { userId: USER } });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: USER,
        type: "LAB_IMPORT_LEDGER_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });
    await signIn();
    const response = await RESTORE(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof RESTORE>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);
    expect(await liveReadings()).toEqual([
      { analyte: "Ferritin", externalId: "fhir:clinic:obs-2" },
    ]);

    const again = await importBatch();
    expect(again.inserted).toBe(0);
    expect(await liveReadings()).toHaveLength(1);
  });
});
