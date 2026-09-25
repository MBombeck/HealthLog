/**
 * How hard a symptom hit, through the whole backup pipe.
 *
 * `CycleSymptomLink.severity` is the 1-4 intensity the log-day sheet writes and
 * the day-log DTO reads back. The backup carried only `symptomKeys`, so a day
 * recorded as "cramps, and they were a 4" exported as "cramps" and restored as
 * "cramps". The symptom was there, the number was gone, and nothing failed —
 * which is why it went unnoticed.
 *
 * These tests assert on ROWS, never on the payload object. A writer test and a
 * reader test were both green through the last defect on this exact path while
 * the assembly between them dropped the field, so the only thing worth proving
 * is what ends up in `cycle_symptom_links` after a real export and a real
 * restore: the REAL `buildFullBackupPayload` writes the file, the REAL
 * `parseBackupPayload` reads it back, and the REAL admin restore route puts the
 * rows down.
 *
 * The restore wipes day-logs and recreates them, so the links it writes are new
 * rows. To make that impossible to mistake, the live severities are overwritten
 * with a different number before the restore runs: whatever comes back came out
 * of the file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import { POST } from "./restore-job-driver";
import { invalidateUserData } from "@/lib/cache/invalidate";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

const RATED_KEY = "custom:severity-rated";
const UNRATED_KEY = "custom:severity-unrated";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  vi.mocked(invalidateUserData).mockClear();
});

function makeRequest(id: string) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

/**
 * One account with a day-log carrying two symptoms: one rated 4, one never
 * rated. Returns the ids the assertions read back through.
 */
async function seedAccount(username: string) {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  const category = await prisma.cycleSymptomCategory.findFirstOrThrow();
  const rated = await prisma.cycleSymptom.create({
    data: {
      userId: owner.id,
      categoryId: category.id,
      key: RATED_KEY,
      labelKey: "cycle.symptom.custom",
      labelEncrypted: encrypt("Cramps"),
      sortOrder: 1,
    },
  });
  const unrated = await prisma.cycleSymptom.create({
    data: {
      userId: owner.id,
      categoryId: category.id,
      key: UNRATED_KEY,
      labelKey: "cycle.symptom.custom",
      labelEncrypted: encrypt("Tender skin"),
      sortOrder: 2,
    },
  });
  await prisma.cycleProfile.create({
    data: {
      userId: owner.id,
      goal: "GENERAL_HEALTH",
      cycleTrackingEnabled: true,
      typicalCycleLength: 29,
    },
  });
  const cycle = await prisma.menstrualCycle.create({
    data: {
      userId: owner.id,
      startDate: "2026-07-01",
      periodEndDate: "2026-07-05",
      tz: "Europe/Berlin",
    },
  });
  const dayLog = await prisma.cycleDayLog.create({
    data: {
      userId: owner.id,
      cycleId: cycle.id,
      date: "2026-07-03",
      flow: "MEDIUM",
      source: "MANUAL",
      tz: "Europe/Berlin",
      symptomLinks: {
        create: [
          { symptomId: rated.id, severity: 4 },
          // Never rated. NULL here is the whole point of the second case: it
          // has to come back NULL, not 0 and not 1.
          { symptomId: unrated.id },
        ],
      },
    },
  });

  return { prisma, owner, rated, unrated, dayLog };
}

/**
 * Overwrite the live intensities so a severity that survives the restore cannot
 * have come from a row that was simply left alone.
 */
async function poisonLiveSeverities(userId: string) {
  const prisma = getPrismaClient();
  const links = await prisma.cycleSymptomLink.findMany({
    where: { dayLog: { userId } },
    select: { dayLogId: true, symptomId: true },
  });
  for (const link of links) {
    await prisma.cycleSymptomLink.update({
      where: {
        dayLogId_symptomId: {
          dayLogId: link.dayLogId,
          symptomId: link.symptomId,
        },
      },
      data: { severity: 1 },
    });
  }
}

async function storeBackup(userId: string, parsed: unknown, type: string) {
  const prisma = getPrismaClient();
  return prisma.dataBackup.create({
    data: { userId, type, data: encrypt(JSON.stringify(parsed)) },
  });
}

async function severityByKey(userId: string) {
  const prisma = getPrismaClient();
  const links = await prisma.cycleSymptomLink.findMany({
    where: { dayLog: { userId } },
    select: { severity: true, symptom: { select: { key: true } } },
  });
  return Object.fromEntries(
    links.map((l) => [l.symptom.key, l.severity]),
  ) as Record<string, number | null>;
}

describe("a symptom's recorded intensity across export and restore", () => {
  it("comes back on the row it was recorded against", async () => {
    const { prisma, owner, dayLog } = await seedAccount("cycle-severity-owner");

    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await storeBackup(
      owner.id,
      parsed,
      "CYCLE_SYMPTOM_SEVERITY_ROUND_TRIP",
    );

    await poisonLiveSeverities(owner.id);

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    // Rows, not payload keys.
    const restoredDayLog = await prisma.cycleDayLog.findUniqueOrThrow({
      where: { id: dayLog.id },
    });
    expect(restoredDayLog.date).toBe("2026-07-03");
    expect(await severityByKey(owner.id)).toEqual({
      [RATED_KEY]: 4,
      [UNRATED_KEY]: null,
    });
  });

  it("stays absent when the file was written before intensities were carried", async () => {
    const { prisma, owner } = await seedAccount("cycle-severity-legacy");

    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });

    // A file from the release before this one: the key is not there at all.
    // Not an empty list — absent, the way an older writer left it.
    const legacy = JSON.parse(JSON.stringify(built)) as {
      cycleDayLogs: Array<Record<string, unknown>>;
    };
    for (const day of legacy.cycleDayLogs) delete day.symptomSeverities;
    expect(legacy.cycleDayLogs.some((d) => "symptomSeverities" in d)).toBe(
      false,
    );
    expect(legacy.cycleDayLogs[0].symptomKeys).toEqual(
      expect.arrayContaining([RATED_KEY, UNRATED_KEY]),
    );

    // The old file has to parse, not be refused for the field it never had.
    const parsed = parseBackupPayload(JSON.stringify(legacy));
    const backup = await storeBackup(
      owner.id,
      parsed,
      "CYCLE_SYMPTOM_SEVERITY_LEGACY_FILE",
    );

    await poisonLiveSeverities(owner.id);

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    // Both symptoms survive; neither is given a number the file never held.
    expect(await severityByKey(owner.id)).toEqual({
      [RATED_KEY]: null,
      [UNRATED_KEY]: null,
    });
  });

  it("keeps the symptom and drops an intensity outside the scale", async () => {
    const { prisma, owner } = await seedAccount("cycle-severity-offscale");

    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });

    // A hand-edited file, or one from some later release with a wider scale.
    // Refusing the whole restore over it would cost the account everything to
    // save one number.
    const offScale = JSON.parse(JSON.stringify(built)) as {
      cycleDayLogs: Array<{
        symptomSeverities: Array<{ key: string; severity: number }>;
      }>;
    };
    for (const day of offScale.cycleDayLogs) {
      day.symptomSeverities = [
        { key: RATED_KEY, severity: 9 },
        // Names a symptom this day does not carry — nothing to attach it to.
        { key: "custom:not-on-this-day", severity: 2 },
      ];
    }

    const parsed = parseBackupPayload(JSON.stringify(offScale));
    const backup = await storeBackup(
      owner.id,
      parsed,
      "CYCLE_SYMPTOM_SEVERITY_OFF_SCALE",
    );

    await poisonLiveSeverities(owner.id);

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    expect(await severityByKey(owner.id)).toEqual({
      [RATED_KEY]: null,
      [UNRATED_KEY]: null,
    });
  });
});
