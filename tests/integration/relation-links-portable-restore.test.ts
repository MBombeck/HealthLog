/**
 * The five relation link tables survive a PORTABLE export and restore.
 *
 * A portable file carries no row id for a medication or a lab result: the
 * restore mints fresh ones, because the file may land on another instance or
 * another account where the original ids mean nothing. The link tables name
 * both of their ends by id, so a link that rode the file under the OLD id of
 * either end used to point at nothing after the restore, and the restore's
 * own placement check dropped it as "end is gone". Four of the five tables
 * have a medication or a lab result at one end; only the visit to dose link
 * came back.
 *
 * Driven through the real restore route. A portable file with documents is
 * refused (no document bytes, see `backup-portable-file-restore.test.ts`), so
 * the file restored here is the portable payload with the document entries
 * taken from the disaster-recovery build of the same account: everything else
 * (medications, lab results, links) is the portable bytes exactly as the
 * export writes them.
 *
 * Mutation check: drop the `exportRef` from the portable medication or lab
 * result entry and the matching link count goes to zero.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { linkTargets } from "@/lib/links";
import { parseBackupPayload } from "@/lib/validations/backup";
import { POST } from "./restore-job-driver";

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

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seed() {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "portable-links-owner",
      email: "portable-links-owner@example.test",
      role: "ADMIN",
    },
  });
  const userId = owner.id;
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  const encounter = await prisma.encounter.create({
    data: {
      userId,
      occurredAt: new Date("2026-07-01T09:00:00.000Z"),
      status: "DONE",
      kind: "ROUTINE",
    },
  });
  const document = await prisma.inboundDocument.create({
    data: {
      userId,
      kind: "LAB_RESULT",
      title: "Thyroid panel",
      mimeType: "application/pdf",
      byteSize: 12,
      contentEncrypted: new Uint8Array([1, 2, 3]),
      contentCodec: "binary2",
      documentDate: new Date("2026-06-30T00:00:00.000Z"),
    },
  });
  const biomarker = await prisma.biomarker.create({
    data: { userId, name: "TSH", unit: "mU/L" },
  });
  const labResult = await prisma.labResult.create({
    data: {
      userId,
      biomarkerId: biomarker.id,
      analyte: "TSH",
      value: 2.1,
      unit: "mU/L",
      takenAt: new Date("2026-06-30T09:00:00.000Z"),
    },
  });
  const episode = await prisma.illnessEpisode.create({
    data: {
      userId,
      label: "Thyroid",
      type: "CHRONIC",
      onsetAt: new Date("2026-01-20T00:00:00.000Z"),
    },
  });
  const medication = await prisma.medication.create({
    data: { userId, name: "Levothyroxine", dose: "50 µg" },
  });
  // A second drug with no links, so a restore that bound every link to the
  // first medication it found would be told apart from one that maps by key.
  await prisma.medication.create({
    data: { userId, name: "Vitamin D", dose: "1000 IU" },
  });
  const vaccination = await prisma.vaccinationRecord.create({
    data: {
      userId,
      occurredAt: new Date("2026-05-14T00:00:00.000Z"),
      antigenSlug: "tdap",
      vaccineName: "Tdap",
    },
  });

  const link = (
    sourceKind: Parameters<typeof linkTargets>[1]["sourceKind"],
    sourceId: string,
    targetKind: Parameters<typeof linkTargets>[1]["targetKind"],
    targetId: string,
  ) =>
    linkTargets(prisma, {
      userId,
      sourceKind,
      sourceId,
      targetKind,
      targetIds: [targetId],
    });
  await link("labResult", labResult.id, "document", document.id);
  await link("encounter", encounter.id, "medication", medication.id);
  await link("encounter", encounter.id, "vaccination", vaccination.id);
  await link("medication", medication.id, "document", document.id);
  await link("medication", medication.id, "conditionEpisode", episode.id);

  return { userId, medication, labResult };
}

describe("a portable restore of the five relation link tables", () => {
  it("brings every link back, bound to the records the restore wrote", async () => {
    const prisma = getPrismaClient();
    const { userId, medication, labResult } = await seed();

    const portable = parseBackupPayload(
      JSON.stringify((await buildFullBackupPayload(prisma, userId)).payload),
    );
    const dr = parseBackupPayload(
      JSON.stringify(
        (
          await buildFullBackupPayload(prisma, userId, {
            purpose: "disaster-recovery",
          })
        ).payload,
      ),
    );
    // The premise: the portable file names no medication or lab result id.
    expect(portable.medications.every((m) => m.id === undefined)).toBe(true);
    expect(portable.labResults.every((l) => l.id === undefined)).toBe(true);

    const file = parseBackupPayload(
      JSON.stringify({ ...portable, documents: dr.documents }),
    );
    const backup = await prisma.dataBackup.create({
      data: {
        userId,
        type: "PORTABLE_LINKS_RESTORE",
        data: encrypt(JSON.stringify(file)),
      },
    });

    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status, await response.clone().text()).toBe(200);

    // The ends were re-minted, so the old ids are gone.
    const restoredMed = await prisma.medication.findFirstOrThrow({
      where: { userId, name: "Levothyroxine" },
    });
    const restoredLab = await prisma.labResult.findFirstOrThrow({
      where: { userId, analyte: "TSH" },
    });
    expect(restoredMed.id).not.toBe(medication.id);
    expect(restoredLab.id).not.toBe(labResult.id);

    const where = { userId };
    const [labDocs, encMeds, encDoses, medDocs, medConds] = await Promise.all([
      prisma.labResultDocumentLink.findMany({ where }),
      prisma.encounterMedicationLink.findMany({ where }),
      prisma.encounterVaccinationLink.findMany({ where }),
      prisma.medicationDocumentLink.findMany({ where }),
      prisma.medicationConditionLink.findMany({ where }),
    ]);
    expect(labDocs.map((r) => r.labResultId)).toEqual([restoredLab.id]);
    expect(encMeds.map((r) => r.medicationId)).toEqual([restoredMed.id]);
    expect(encDoses).toHaveLength(1);
    expect(medDocs.map((r) => r.medicationId)).toEqual([restoredMed.id]);
    expect(medConds.map((r) => r.medicationId)).toEqual([restoredMed.id]);
  });
});
