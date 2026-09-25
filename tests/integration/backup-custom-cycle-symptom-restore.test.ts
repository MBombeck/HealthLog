/**
 * The seam between the backup writer and the backup reader.
 *
 * Custom cycle symptoms had a green test on every end and shipped broken
 * anyway. `buildCycleBackupSection` returned them, `backupPayloadSchema`
 * declared them, `restoreCycleData` read them, and each of those three was
 * covered. What nothing covered was the assembly in between: the payload was
 * built as an object literal that copied section keys out one at a time, and
 * `customSymptoms` was never on that list. Every backup written carried an
 * empty array, so an account whose day-log referenced a symptom it had created
 * itself could not be restored at all — the restore threw on a key nothing had
 * written back and the route answered 500.
 *
 * So this test asserts on ROWS, never on the payload object. Asserting the
 * payload carries `customSymptoms` would re-test the writer, which was already
 * passing while production was broken. The account is populated, the REAL
 * `buildFullBackupPayload` produces the file, the file is serialised and parsed
 * back through the REAL `parseBackupPayload`, the account's own symptom row is
 * removed so the file is the only place it survives, and the REAL admin restore
 * has to put the row and its day-log link back.
 *
 * Removing the symptom row before restoring is the point, not a contrivance:
 * `restoreCycleData` wipes day-logs, cycles, and the profile, but never the
 * symptom catalogue. Restore onto the same instance and the row is still
 * sitting there to resolve against, which is exactly why the older round-trip
 * test stayed green. The file has to carry the symptom for the case the
 * `customSymptoms` field exists for: a restore onto an instance that never had
 * it.
 *
 * Mutation check: hand-pick the cycle section's keys in
 * `buildFullBackupPayload` instead of spreading it, and this test reproduces
 * the production failure — restore answers 500 on
 * `Unknown cycle symptom keys: custom:sacroiliac-ache`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { decrypt, encrypt } from "@/lib/crypto";
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

/** The user's own words for the symptom, as they are held at rest. */
const SYMPTOM_LABEL = "Sacroiliac ache";
const SYMPTOM_KEY = "custom:sacroiliac-ache";

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

describe("a backup of an account with its own cycle symptom", () => {
  it("restores the symptom and its day-log link onto an instance without it", async () => {
    const prisma = getPrismaClient();

    // The restore writes into the backup's owner, and the route refuses a
    // payload whose declared owner differs from the backup row. Owner and
    // operator are the same account here so the fixture stays about the
    // symptom rather than about the ownership guard.
    const owner = await prisma.user.create({
      data: {
        username: "cycle-symptom-owner",
        email: "cycle-symptom-owner@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const category = await prisma.cycleSymptomCategory.findFirstOrThrow();
    const symptom = await prisma.cycleSymptom.create({
      data: {
        userId: owner.id,
        categoryId: category.id,
        key: SYMPTOM_KEY,
        labelKey: "cycle.symptom.custom",
        labelEncrypted: encrypt(SYMPTOM_LABEL),
        sortOrder: 3,
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
        symptomLinks: { create: { symptomId: symptom.id } },
      },
    });

    // The real writer, the real wire format, the real reader. Nothing is
    // asserted about `built` — the writer was green through the whole defect.
    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await prisma.dataBackup.create({
      data: {
        userId: owner.id,
        type: "CUSTOM_CYCLE_SYMPTOM_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });

    // Model the instance the `customSymptoms` field exists for: one that never
    // had this account's own symptom. The restore clears day-logs, cycles, and
    // the profile itself, but never the symptom catalogue, so the row has to go
    // before the restore runs or the file is not what resolves the link.
    await prisma.cycleDayLog.deleteMany({ where: { userId: owner.id } });
    await prisma.menstrualCycle.deleteMany({ where: { userId: owner.id } });
    await prisma.cycleProfile.deleteMany({ where: { userId: owner.id } });
    await prisma.cycleSymptom.deleteMany({ where: { userId: owner.id } });
    expect(
      await prisma.cycleSymptom.count({ where: { key: SYMPTOM_KEY } }),
    ).toBe(0);

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    expect(response.status).toBe(200);

    // Rows, not payload keys.
    const restoredSymptom = await prisma.cycleSymptom.findUniqueOrThrow({
      where: { key: SYMPTOM_KEY },
    });
    expect(restoredSymptom).toEqual(
      expect.objectContaining({
        userId: owner.id,
        categoryId: category.id,
        labelKey: "cycle.symptom.custom",
        sortOrder: 3,
        isActive: true,
      }),
    );
    // The label is ciphertext on the wire and stays readable after the trip:
    // a restored symptom whose label came back empty is the same lost data in
    // a quieter form.
    expect(decrypt(restoredSymptom.labelEncrypted!)).toBe(SYMPTOM_LABEL);

    const restoredDayLog = await prisma.cycleDayLog.findUniqueOrThrow({
      where: { id: dayLog.id },
    });
    expect(restoredDayLog.date).toBe("2026-07-03");
    expect(
      await prisma.cycleSymptomLink.findMany({
        where: { dayLogId: restoredDayLog.id },
        select: { symptomId: true },
      }),
    ).toEqual([{ symptomId: restoredSymptom.id }]);
  });
});
