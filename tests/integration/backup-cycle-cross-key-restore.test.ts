/**
 * A portable file's cycle free text survives a move to a host with other keys.
 *
 * The day-log note, the sensitive-category envelope and a custom symptom's
 * label are sealed under the writing host's key. A portable file used to carry
 * those three as the stored ciphertext, so a restore onto a host with a
 * different key either refused the whole file at the key check or, with a
 * matching key id over different key material, wrote rows nobody could open.
 *
 * Both ends and the pipe: the file is built by the real `buildFullBackupPayload`
 * under key A, stored and restored through the real route under key B, and
 * the restored rows are opened under key B.
 *
 * The second case is the file written before the fix, which still carries
 * ciphertext. A value this host's keys open comes back; a value they cannot
 * open is kept out of the row and named in the skip report, rather than
 * written back as ciphertext no reader can open.
 *
 * Mutation: restore the verbatim copy of `notesEncrypted` in
 * `restoreCycleData` and the legacy case writes the foreign ciphertext back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests, decrypt, encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

const saved = {
  key: process.env.ENCRYPTION_KEY,
  keys: process.env.ENCRYPTION_KEYS,
  active: process.env.ENCRYPTION_ACTIVE_KEY_ID,
};

/** Make this process the host holding exactly `keys`, writing under `active`. */
function useKeys(keys: Record<string, string>, active: string) {
  process.env.ENCRYPTION_KEY = "";
  process.env.ENCRYPTION_KEYS = JSON.stringify(keys);
  process.env.ENCRYPTION_ACTIVE_KEY_ID = active;
  _resetCryptoCacheForTests();
}

const HOST_A = { a: "11".repeat(32) };
const HOST_B = { b: "22".repeat(32) };
/** Same key id as host B, different key material. */
const HOST_B_IMPOSTOR = { b: "33".repeat(32) };

const NOTE = "Cramps woke me at four";
const SENSITIVE = {
  sexualActivity: true,
  protectedSex: false,
  pregnancyTest: "NEGATIVE",
  progesteroneTest: null,
  contraceptive: "ORAL",
};
const LABEL = "Lower back ache";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  process.env.ENCRYPTION_KEY = saved.key ?? "";
  process.env.ENCRYPTION_KEYS = saved.keys ?? "";
  process.env.ENCRYPTION_ACTIVE_KEY_ID = saved.active ?? "";
  _resetCryptoCacheForTests();
});

function makeRequest(id: string) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

async function seedOwner() {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "cycle-cross-key-owner",
      email: "cycle-cross-key-owner@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return owner;
}

/** Store `payload` as a backup on this host and run the real restore. */
async function restore(ownerId: string, payload: unknown) {
  const prisma = getPrismaClient();
  const backup = await prisma.dataBackup.create({
    data: {
      userId: ownerId,
      type: "CYCLE_CROSS_KEY_RESTORE",
      data: encrypt(JSON.stringify(payload)),
    },
  });
  return POST(makeRequest(backup.id) as unknown as Parameters<typeof POST>[0], {
    params: Promise.resolve({ id: backup.id }),
  });
}

describe("cycle free text in a portable file restored under another key", () => {
  it("comes back readable under the receiving host's key", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner();

    /* ── host A writes the account and exports it ─────────────────────── */
    useKeys(HOST_A, "a");
    const category = await prisma.cycleSymptomCategory.findFirstOrThrow();
    await prisma.cycleSymptom.create({
      data: {
        userId: owner.id,
        categoryId: category.id,
        key: "custom:cross-key-ache",
        labelKey: "cycle.symptom.custom",
        labelEncrypted: encrypt(LABEL),
      },
    });
    await prisma.cycleDayLog.create({
      data: {
        userId: owner.id,
        date: "2026-06-02",
        flow: "MEDIUM",
        notesEncrypted: encrypt(NOTE),
        sensitiveEncrypted: encrypt(JSON.stringify(SENSITIVE)),
      },
    });
    const { payload: built } = await buildFullBackupPayload(prisma, owner.id);
    const file = JSON.parse(JSON.stringify(built)) as unknown;

    /* ── host B, which has never held key A, restores it ──────────────── */
    useKeys(HOST_B, "b");
    // Host B is another database: the account's own symptom row from host A
    // is not there (the restore upserts by key and keeps an existing row).
    await prisma.cycleDayLog.deleteMany({ where: { userId: owner.id } });
    await prisma.cycleSymptom.deleteMany({ where: { userId: owner.id } });
    const response = await restore(owner.id, file);
    expect(response.status).toBe(200);

    const day = await prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(day.flow).toBe("MEDIUM");
    expect(day.notesEncrypted).not.toBeNull();
    expect(decrypt(day.notesEncrypted!)).toBe(NOTE);
    expect(day.sensitiveEncrypted).not.toBeNull();
    expect(JSON.parse(decrypt(day.sensitiveEncrypted!))).toEqual(SENSITIVE);

    const symptom = await prisma.cycleSymptom.findUniqueOrThrow({
      where: { key: "custom:cross-key-ache" },
    });
    expect(decrypt(symptom.labelEncrypted!)).toBe(LABEL);

    const body = (await response.json()) as {
      data: { skipped: { links: number } };
    };
    expect(body.data.skipped.links).toBe(0);
  });

  it("restores a legacy file's ciphertext only where this host can open it", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner();

    // Written under host B's own key: opens here.
    useKeys(HOST_B, "b");
    const ownNote = encrypt(NOTE);
    // Written elsewhere: an id host B does not hold, and host B's id over
    // different key material.
    useKeys(HOST_A, "a");
    const foreignNote = encrypt("written under key a");
    const foreignLabel = encrypt("label under key a");
    useKeys(HOST_B_IMPOSTOR, "b");
    const impostorSensitive = encrypt(JSON.stringify(SENSITIVE));

    // The shape a portable file had before the fix: every free-text field as
    // the stored ciphertext, no plaintext beside it.
    useKeys(HOST_B, "b");
    const { payload: built } = await buildFullBackupPayload(prisma, owner.id);
    const file = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
    const category = await prisma.cycleSymptomCategory.findFirstOrThrow();
    file.customSymptoms = [
      {
        key: "custom:legacy-foreign",
        labelKey: "cycle.symptom.custom",
        categoryId: category.id,
        icon: null,
        sortOrder: 0,
        isActive: true,
        labelEncrypted: foreignLabel,
      },
    ];
    const day = (
      date: string,
      notes: string | null,
      sensitive: string | null,
    ) => ({
      date,
      flow: "LIGHT",
      intermenstrualBleeding: false,
      basalBodyTempC: null,
      temperatureExcluded: false,
      ovulationTest: null,
      cervicalMucus: null,
      cervixPosition: null,
      cervixFirmness: null,
      cervixOpening: null,
      sexualActivity: false,
      protectedSex: null,
      pregnancyTest: null,
      progesteroneTest: null,
      contraceptive: null,
      sensitiveEncrypted: sensitive,
      notesEncrypted: notes,
      source: "MANUAL",
      externalId: null,
      tz: null,
      symptomKeys: [],
      symptomSeverities: [],
    });
    file.cycleDayLogs = [
      day("2026-06-01", ownNote, null),
      day("2026-06-02", foreignNote, impostorSensitive),
    ];
    // Still a file this release accepts.
    parseBackupPayload(JSON.stringify(file));

    const response = await restore(owner.id, file);
    expect(response.status).toBe(200);

    const days = await prisma.cycleDayLog.findMany({
      where: { userId: owner.id },
      orderBy: { date: "asc" },
    });
    expect(days.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-02"]);
    expect(decrypt(days[0].notesEncrypted!)).toBe(NOTE);
    // The day itself comes back; only what cannot be opened stays out.
    expect(days[1].flow).toBe("LIGHT");
    expect(days[1].notesEncrypted).toBeNull();
    expect(days[1].sensitiveEncrypted).toBeNull();

    const symptom = await prisma.cycleSymptom.findUniqueOrThrow({
      where: { key: "custom:legacy-foreign" },
    });
    expect(symptom.labelEncrypted).toBeNull();

    const body = (await response.json()) as {
      data: {
        skipped: {
          links: number;
          catalogueKeys: Array<{
            catalogue: string;
            key: string;
            links: number;
          }>;
        };
      };
    };
    expect(body.data.skipped.catalogueKeys).toEqual([
      {
        catalogue: "cycleCiphertext",
        key: "customSymptoms.custom:legacy-foreign.labelEncrypted",
        links: 1,
      },
      {
        catalogue: "cycleCiphertext",
        key: "cycleDayLogs.2026-06-02.notesEncrypted",
        links: 1,
      },
      {
        catalogue: "cycleCiphertext",
        key: "cycleDayLogs.2026-06-02.sensitiveEncrypted",
        links: 1,
      },
    ]);
    expect(body.data.skipped.links).toBe(3);
  });
});
