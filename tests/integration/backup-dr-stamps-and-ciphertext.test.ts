/**
 * A disaster-recovery restore gives back the timestamps and the ciphertext the
 * account had, and still takes a recovery file written before it did.
 *
 *   - The row stamps of the medication rows (the drug, its courses,
 *     composition, category and category label), of the mood day context and
 *     tag links, of the illness and cycle symptom links and of the nutrient
 *     days used to come back as the restore's own time. The file now carries
 *     them and the restore writes them back.
 *   - A custom category's label, a course note and a marker's context rode a
 *     recovery file as readable text and were sealed again under whatever key
 *     was active; the file now carries the ciphertext and the restore writes
 *     the bytes back unchanged.
 *   - A recovery file without the new fields (any written before) restores
 *     the way it always did: the readable values sealed here, the stamps the
 *     restore's own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import {
  decryptContextFromBytes,
  encryptContextToBytes,
} from "@/lib/labs/biomarker-store";

import {
  createOwner,
  OWNER_ID,
  seedAdminSession,
  seedEveryTwoEndedModel,
} from "./backup-fixture";
import { cookieJar, headerJar } from "./mock-next-headers";
import { POST } from "./restore-job-driver";
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

const prisma = getPrismaClient();
const CREATED = new Date("2026-03-03T03:03:03.000Z");
const UPDATED = new Date("2026-04-04T04:04:04.000Z");
const CONTEXT = "fasted, morning draw";

beforeEach(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
});

/** Give every tracked row a historical stamp, and the marker a context. */
async function seed(): Promise<void> {
  await seedAdminSession(prisma);
  await createOwner(prisma);
  await seedEveryTwoEndedModel(prisma);
  const owner = { userId: OWNER_ID };
  const both = { createdAt: CREATED, updatedAt: UPDATED };
  await prisma.biomarker.updateMany({
    where: owner,
    data: { contextEncrypted: encryptContextToBytes(CONTEXT), ...both },
  });
  await prisma.medicationCategoryLabel.updateMany({ where: owner, data: both });
  await prisma.medicationCourse.updateMany({ where: owner, data: both });
  await prisma.medicationIngredient.updateMany({ where: owner, data: both });
  await prisma.medicationCategoryAssignment.updateMany({
    where: { medication: owner },
    data: { updatedAt: UPDATED },
  });
  await prisma.moodContext.updateMany({ where: owner, data: both });
  await prisma.moodEntryTagLink.updateMany({
    where: { moodEntry: owner },
    data: { createdAt: CREATED },
  });
  await prisma.illnessSymptomLink.updateMany({
    where: { dayLog: owner },
    data: { createdAt: CREATED },
  });
  await prisma.cycleSymptomLink.updateMany({
    where: { dayLog: owner },
    data: { createdAt: CREATED },
  });
  await prisma.nutrientIntakeDay.updateMany({ where: owner, data: both });
  // Last: the writes above do not touch the drug, this pins its own stamp.
  await prisma.medication.updateMany({
    where: owner,
    data: { updatedAt: UPDATED },
  });
}

const b64 = (bytes: Uint8Array | null) =>
  bytes ? Buffer.from(bytes).toString("base64") : null;

/** The tracked stamps and ciphertext of the account, in a stable order. */
async function tracked(client: PrismaClient) {
  const owner = { userId: OWNER_ID };
  return {
    medication: await client.medication.findMany({
      where: owner,
      orderBy: { name: "asc" },
      select: { updatedAt: true },
    }),
    assignment: await client.medicationCategoryAssignment.findMany({
      where: { medication: owner },
      select: { updatedAt: true },
    }),
    labels: (
      await client.medicationCategoryLabel.findMany({
        where: owner,
        select: { labelEncrypted: true, createdAt: true, updatedAt: true },
      })
    ).map((r) => ({ ...r, labelEncrypted: b64(r.labelEncrypted) })),
    courses: (
      await client.medicationCourse.findMany({
        where: owner,
        orderBy: { startsOn: "asc" },
        select: { noteEncrypted: true, createdAt: true, updatedAt: true },
      })
    ).map((r) => ({ ...r, noteEncrypted: b64(r.noteEncrypted) })),
    ingredients: await client.medicationIngredient.findMany({
      where: owner,
      select: { createdAt: true, updatedAt: true },
    }),
    moodContexts: await client.moodContext.findMany({
      where: owner,
      select: { createdAt: true, updatedAt: true },
    }),
    moodLinks: await client.moodEntryTagLink.findMany({
      where: { moodEntry: owner },
      select: { createdAt: true },
    }),
    illnessLinks: await client.illnessSymptomLink.findMany({
      where: { dayLog: owner },
      select: { createdAt: true },
    }),
    cycleLinks: await client.cycleSymptomLink.findMany({
      where: { dayLog: owner },
      select: { createdAt: true },
    }),
    nutrients: await client.nutrientIntakeDay.findMany({
      where: owner,
      select: { createdAt: true, updatedAt: true },
    }),
    markers: (
      await client.biomarker.findMany({
        where: owner,
        select: { contextEncrypted: true },
      })
    ).map((r) => ({ contextEncrypted: b64(r.contextEncrypted) })),
  };
}

async function restore(payload: unknown): Promise<Date> {
  await prisma.user.delete({ where: { id: OWNER_ID } });
  await createOwner(prisma);
  const backup = await prisma.dataBackup.create({
    data: {
      userId: OWNER_ID,
      type: "DR_STAMPS",
      data: encrypt(JSON.stringify(payload)),
    },
  });
  const startedAt = new Date();
  const response = await POST(
    new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as never,
    { params: Promise.resolve({ id: backup.id }) },
  );
  expect(response.status, JSON.stringify(await response.json())).toBe(200);
  return startedAt;
}

type Payload = Record<string, unknown> & {
  customMedicationCategories: Array<Record<string, unknown>>;
  medications: Array<Record<string, unknown>>;
  moodEntries: Array<Record<string, unknown>>;
  illnessEpisodes: Array<Record<string, unknown>>;
  cycleDayLogs: Array<Record<string, unknown>>;
  nutrientDays: Array<Record<string, unknown>>;
  biomarkers: Array<Record<string, unknown>>;
};

/** The same file as a release before this one wrote it. */
function asOlderRecoveryFile(payload: Payload): Payload {
  const older = structuredClone(payload);
  for (const c of older.customMedicationCategories) {
    c.label = decryptFromBytes(
      Buffer.from(c.labelEncrypted as string, "base64"),
    );
    delete c.labelEncrypted;
    delete c.updatedAt;
  }
  for (const m of older.medications) {
    delete m.categoryUpdatedAt;
    for (const i of m.ingredients as Array<Record<string, unknown>>) {
      delete i.updatedAt;
    }
    for (const c of m.courses as Array<Record<string, unknown>>) {
      c.note = c.noteEncrypted
        ? decryptFromBytes(Buffer.from(c.noteEncrypted as string, "base64"))
        : null;
      delete c.noteEncrypted;
      delete c.updatedAt;
    }
  }
  for (const e of older.moodEntries) {
    delete e.linkCreatedAt;
    const context = e.context as Record<string, unknown> | null;
    if (context) {
      delete context.createdAt;
      delete context.updatedAt;
    }
  }
  for (const episode of older.illnessEpisodes) {
    for (const day of episode.dayLogs as Array<Record<string, unknown>>) {
      for (const s of day.symptoms as Array<Record<string, unknown>>) {
        delete s.createdAt;
      }
    }
  }
  for (const day of older.cycleDayLogs) delete day.symptomLinkCreatedAt;
  for (const n of older.nutrientDays) delete n.updatedAt;
  for (const marker of older.biomarkers) {
    marker.context = marker.contextEncrypted
      ? decryptContextFromBytes(
          Buffer.from(marker.contextEncrypted as string, "base64"),
        )
      : null;
    delete marker.contextEncrypted;
  }
  return older;
}

describe("a disaster-recovery restore", () => {
  it("gives back the row stamps and the ciphertext as they were", async () => {
    await seed();
    const before = await tracked(prisma);
    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const file = JSON.stringify(payload);
    // None of the three sealed values rides the file readable.
    expect(file).not.toContain("Heart and circulation");
    expect(file).not.toContain("the March flu");
    expect(file).not.toContain(CONTEXT);

    await restore(payload);
    const after = await tracked(prisma);
    expect(after).toEqual(before);
    // The comparison saw rows, not two empty lists.
    for (const rows of Object.values(after))
      expect(rows.length).toBeGreaterThan(0);
  });

  it("takes an older recovery file the way it always did", async () => {
    await seed();
    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const startedAt = await restore(asOlderRecoveryFile(payload as Payload));

    const label = await prisma.medicationCategoryLabel.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect(decryptFromBytes(label.labelEncrypted)).toBe(
      "Heart and circulation",
    );
    const course = await prisma.medicationCourse.findFirstOrThrow({
      where: { userId: OWNER_ID, noteEncrypted: { not: null } },
    });
    expect(decryptFromBytes(course.noteEncrypted!)).toBe("the March flu");
    const marker = await prisma.biomarker.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect(decryptContextFromBytes(marker.contextEncrypted!)).toBe(CONTEXT);

    const after = await tracked(prisma);
    const restamped = [
      ...after.labels.map((r) => r.updatedAt),
      ...after.courses.map((r) => r.updatedAt),
      ...after.ingredients.map((r) => r.updatedAt),
      ...after.assignment.map((r) => r.updatedAt),
      ...after.moodContexts.map((r) => r.createdAt),
      ...after.moodLinks.map((r) => r.createdAt),
      ...after.illnessLinks.map((r) => r.createdAt),
      ...after.cycleLinks.map((r) => r.createdAt),
      ...after.nutrients.map((r) => r.updatedAt),
    ];
    expect(restamped.length).toBeGreaterThan(8);
    for (const at of restamped) {
      expect(at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 1000);
    }
  });
});
