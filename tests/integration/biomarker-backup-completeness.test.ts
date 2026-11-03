/**
 * A marker's other spellings and the merge ledger survive a backup and a
 * restore, in both kinds of file (D1223).
 *
 * Without the aliases a restored account is asked again at the next scan
 * which marker each spelling belongs to; without the ledger a link to a
 * merged marker reads as a plain 404. Every column of both tables is compared
 * after a disaster-recovery round trip, and the portable file, which carries
 * no ids, is checked for what the resolver and the 404 actually use: the
 * spelling, its fold, where it came from and which marker it belongs to, and
 * which marker a merged id went into.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { loadMarkerIndex, resolveInIndex } from "@/lib/labs/biomarker-resolve";
import { mergedInto } from "@/lib/labs/biomarker-merge";
import { parseBackupPayload } from "@/lib/validations/backup";
import { legacyStreamedBlobFrom } from "@/__tests__/helpers/legacy-backup-blob";

import { cookieJar } from "./mock-next-headers";
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

vi.mock("@/lib/cache/invalidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache/invalidate")>()),
  invalidateUserData: vi.fn(),
}));

const OWNER = "biomarker-backup-owner";

async function createOwner() {
  await getPrismaClient().user.create({
    data: {
      id: OWNER,
      username: "biomarker-backup-owner",
      email: "biomarker-backup-owner@example.test",
    },
  });
}

async function seedAdmin() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "biomarker-backup-admin",
      email: "biomarker-backup-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

/** Two markers, an alias from each source, and a two-step merge ledger. */
async function seed() {
  const prisma = getPrismaClient();
  const alp = await prisma.biomarker.create({
    data: { userId: OWNER, name: "Alkaline Phosphatase", unit: "U/L" },
  });
  const bili = await prisma.biomarker.create({
    data: { userId: OWNER, name: "Bilirubin (Total)", unit: "mg/dL" },
  });
  await prisma.labResult.create({
    data: {
      userId: OWNER,
      biomarkerId: alp.id,
      analyte: "Alk.P",
      value: 80,
      unit: "U/L",
      takenAt: new Date("2026-05-01T08:00:00.000Z"),
    },
  });
  await prisma.biomarkerAlias.createMany({
    data: [
      {
        userId: OWNER,
        biomarkerId: alp.id,
        name: "Alk.P",
        nameFolded: "alk.p",
        source: "MERGE",
        createdAt: new Date("2026-05-02T10:00:00.000Z"),
      },
      {
        userId: OWNER,
        biomarkerId: alp.id,
        name: "AP",
        nameFolded: "ap",
        source: "MANUAL",
        createdAt: new Date("2026-05-03T10:00:00.000Z"),
      },
      {
        userId: OWNER,
        biomarkerId: bili.id,
        name: "Bilirubin ges.",
        nameFolded: "bilirubin ges.",
        source: "IMPORT_CHOICE",
        createdAt: new Date("2026-05-04T10:00:00.000Z"),
      },
    ],
  });
  await prisma.biomarkerMerge.createMany({
    data: [
      {
        userId: OWNER,
        targetBiomarkerId: alp.id,
        sourceBiomarkerId: "merged-alk-p",
        sourceName: "Alk.P",
        readingCount: 12,
        mergedAt: new Date("2026-05-02T10:00:00.000Z"),
      },
      {
        userId: OWNER,
        targetBiomarkerId: bili.id,
        sourceBiomarkerId: "merged-t-bili",
        sourceName: "T.Bili",
        readingCount: 0,
        mergedAt: new Date("2026-05-05T10:00:00.000Z"),
      },
    ],
  });
  return { alp, bili };
}

async function snapshot() {
  const prisma = getPrismaClient();
  const markers = await prisma.biomarker.findMany({
    where: { userId: OWNER },
    select: { id: true, name: true },
  });
  const nameOf = new Map(markers.map((m) => [m.id, m.name]));
  const aliases = (
    await prisma.biomarkerAlias.findMany({ where: { userId: OWNER } })
  )
    .map((a) => ({ ...a, marker: nameOf.get(a.biomarkerId) }))
    .sort((a, b) => a.nameFolded.localeCompare(b.nameFolded));
  const merges = (
    await prisma.biomarkerMerge.findMany({ where: { userId: OWNER } })
  )
    .map((m) => ({ ...m, target: nameOf.get(m.targetBiomarkerId) }))
    .sort((a, b) => a.sourceBiomarkerId.localeCompare(b.sourceBiomarkerId));
  return { aliases, merges };
}

/** Empty the account, store `data` as a backup row, and restore it. */
async function restore(
  data: Awaited<ReturnType<typeof legacyStreamedBlobFrom>> | string,
  type: string,
) {
  const prisma = getPrismaClient();
  await prisma.user.delete({ where: { id: OWNER } });
  await createOwner();
  const backup = await prisma.dataBackup.create({
    data: { userId: OWNER, type, data },
  });
  const response = await POST(
    new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as never,
    { params: Promise.resolve({ id: backup.id }) },
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await seedAdmin();
  await createOwner();
});

describe("biomarker aliases and merges in a backup", () => {
  it("come back column for column from a disaster-recovery file", async () => {
    const prisma = getPrismaClient();
    await seed();
    const before = await snapshot();
    expect(before.aliases).toHaveLength(3);
    expect(before.merges).toHaveLength(2);

    let json = "";
    await streamFullBackupJson(
      prisma,
      OWNER,
      (chunk) => {
        json += chunk;
      },
      { purpose: "disaster-recovery", exportedAt: new Date() },
    );
    await restore(
      await legacyStreamedBlobFrom(async (write) => {
        await write(json);
      }),
      "BIOMARKER_DR_ROUND_TRIP",
    );

    // Every column, ids and stamps included.
    expect(await snapshot()).toEqual(before);
  });

  it("come back from a portable file with every value the resolver and the 404 read", async () => {
    const prisma = getPrismaClient();
    const { alp, bili } = await seed();
    const before = await snapshot();

    const { payload } = await buildFullBackupPayload(prisma, OWNER);
    const parsed = parseBackupPayload(JSON.stringify(payload));
    expect(
      parsed.biomarkers.find((b) => b.name === "Alkaline Phosphatase")?.aliases,
    ).toHaveLength(2);
    expect(parsed.biomarkerMerges).toHaveLength(2);
    // Stored the way an uploaded portable file is: encrypted JSON.
    await restore(
      encrypt(JSON.stringify(parsed)),
      "BIOMARKER_PORTABLE_ROUND_TRIP",
    );

    const after = await snapshot();
    const portable = (s: typeof before) => ({
      aliases: s.aliases.map((a) => ({
        name: a.name,
        nameFolded: a.nameFolded,
        source: a.source,
        marker: a.marker,
        userId: a.userId,
      })),
      merges: s.merges.map((m) => ({
        sourceBiomarkerId: m.sourceBiomarkerId,
        sourceName: m.sourceName,
        readingCount: m.readingCount,
        mergedAt: m.mergedAt,
        target: m.target,
        userId: m.userId,
      })),
    });
    expect(portable(after)).toEqual(portable(before));

    // What the values are for: the spellings resolve again, and the merged
    // ids still name the marker they went into.
    const index = await loadMarkerIndex(prisma, OWNER);
    const restoredAlp = index.markers.find((m) => m.name === alp.name)!;
    const restoredBili = index.markers.find((m) => m.name === bili.name)!;
    expect(resolveInIndex(index, "AP")).toEqual({
      marker: restoredAlp,
      matchKind: "alias",
    });
    expect(resolveInIndex(index, "bilirubin ges.")?.marker).toEqual(
      restoredBili,
    );
    expect(await mergedInto(OWNER, "merged-t-bili")).toBe(restoredBili.id);
  });
});
