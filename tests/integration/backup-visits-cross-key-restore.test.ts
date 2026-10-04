/**
 * A portable file's visit and vaccination free text survives a move to a host
 * with other keys.
 *
 * A practitioner's note, a visit's reason, outcome and body site and a
 * vaccination's note are sealed under the writing host's key. A portable file
 * used to carry them as the stored ciphertext, so a restore onto a host with
 * a different key refused the file at the key check, or with a matching key id
 * over other key material wrote values nobody could open.
 *
 * Both ends and the pipe: built by the real `buildFullBackupPayload` under key
 * A, restored through the real route under key B, opened under key B. The
 * second case is a file written before the fix: a value this host opens comes
 * back, one it cannot open stays out and is named in the skip report.
 */
import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";
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

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

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
      username: "visits-cross-key-owner",
      email: "visits-cross-key-owner@example.test",
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
      type: "VISITS_CROSS_KEY_RESTORE",
      data: encrypt(JSON.stringify(payload)),
    },
  });
  return POST(makeRequest(backup.id) as unknown as Parameters<typeof POST>[0], {
    params: Promise.resolve({ id: backup.id }),
  });
}

describe("visit and vaccination free text restored under another key", () => {
  it("comes back readable under the receiving host's key", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner();

    useKeys(HOST_A, "a");
    const practitioner = await prisma.practitioner.create({
      data: {
        userId: owner.id,
        name: "Practice",
        noteEncrypted: encryptToBytes("ring the upper bell"),
        locationEncrypted: encryptToBytes("Main street 1"),
      },
    });
    const encounter = await prisma.encounter.create({
      data: {
        userId: owner.id,
        occurredAt: new Date("2026-06-30T08:00:00.000Z"),
        status: "DONE",
        kind: "ROUTINE",
        practitionerId: practitioner.id,
        reasonEncrypted: encryptToBytes("annual check"),
        outcomeEncrypted: encryptToBytes("all fine"),
        bodySiteEncrypted: encryptToBytes("left knee"),
      },
    });
    const vaccination = await prisma.vaccinationRecord.create({
      data: {
        userId: owner.id,
        occurredAt: new Date("2026-05-14T00:00:00.000Z"),
        vaccineName: "Tetanus",
        noteEncrypted: encryptToBytes("sore arm for a day"),
      },
    });
    const { payload: built } = await buildFullBackupPayload(prisma, owner.id);
    const file = JSON.parse(JSON.stringify(built)) as unknown;

    useKeys(HOST_B, "b");
    const response = await restore(owner.id, file);
    expect(response.status).toBe(200);

    const p = await prisma.practitioner.findUniqueOrThrow({
      where: { id: practitioner.id },
    });
    expect(decryptFromBytes(p.noteEncrypted!)).toBe("ring the upper bell");
    expect(decryptFromBytes(p.locationEncrypted!)).toBe("Main street 1");
    const e = await prisma.encounter.findUniqueOrThrow({
      where: { id: encounter.id },
    });
    expect(decryptFromBytes(e.reasonEncrypted!)).toBe("annual check");
    expect(decryptFromBytes(e.outcomeEncrypted!)).toBe("all fine");
    expect(decryptFromBytes(e.bodySiteEncrypted!)).toBe("left knee");
    const v = await prisma.vaccinationRecord.findUniqueOrThrow({
      where: { id: vaccination.id },
    });
    expect(decryptFromBytes(v.noteEncrypted!)).toBe("sore arm for a day");

    const body = (await response.json()) as {
      data: { skipped: { links: number } };
    };
    expect(body.data.skipped.links).toBe(0);
  });

  it("restores a legacy file's ciphertext only where this host can open it", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner();

    useKeys(HOST_B, "b");
    const ownReason = b64(encryptToBytes("annual check"));
    useKeys(HOST_A, "a");
    const foreignNote = b64(encryptToBytes("written under key a"));
    useKeys(HOST_B_IMPOSTOR, "b");
    const impostorOutcome = b64(encryptToBytes("same id, other key"));
    const impostorVaccination = b64(encryptToBytes("same id, other key"));

    // The shape a portable file had before the fix: ciphertext, no text.
    useKeys(HOST_B, "b");
    const { payload: built } = await buildFullBackupPayload(prisma, owner.id);
    const file = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
    const at = "2026-06-30T08:00:00.000Z";
    file.practitioners = [
      {
        id: "legacy-practitioner",
        name: "Practice",
        specialty: null,
        practice: null,
        location: null,
        phone: null,
        noteEncrypted: foreignNote,
        createdAt: at,
        updatedAt: at,
      },
    ];
    file.encounters = [
      {
        id: "legacy-encounter",
        occurredAt: at,
        status: "DONE",
        kind: "ROUTINE",
        practitionerId: "legacy-practitioner",
        reasonEncrypted: ownReason,
        outcomeEncrypted: impostorOutcome,
        bodySiteEncrypted: null,
        laterality: null,
        reminderId: null,
        createdAt: at,
        updatedAt: at,
      },
    ];
    file.vaccinations = [
      {
        id: "legacy-vaccination",
        occurredAt: at,
        vaccineName: "Tetanus",
        noteEncrypted: impostorVaccination,
        createdAt: at,
        updatedAt: at,
      },
    ];
    parseBackupPayload(JSON.stringify(file));

    const response = await restore(owner.id, file);
    expect(response.status).toBe(200);

    const p = await prisma.practitioner.findUniqueOrThrow({
      where: { id: "legacy-practitioner" },
    });
    expect(p.noteEncrypted).toBeNull();
    const e = await prisma.encounter.findUniqueOrThrow({
      where: { id: "legacy-encounter" },
    });
    expect(decryptFromBytes(e.reasonEncrypted!)).toBe("annual check");
    expect(e.outcomeEncrypted).toBeNull();
    const v = await prisma.vaccinationRecord.findUniqueOrThrow({
      where: { id: "legacy-vaccination" },
    });
    expect(v.vaccineName).toBe("Tetanus");
    expect(v.noteEncrypted).toBeNull();

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
        catalogue: "vaccinationCiphertext",
        key: "vaccinations.legacy-vaccination.noteEncrypted",
        links: 1,
      },
      {
        catalogue: "visitCiphertext",
        key: "encounters.legacy-encounter.outcomeEncrypted",
        links: 1,
      },
      {
        catalogue: "visitCiphertext",
        key: "practitioners.legacy-practitioner.noteEncrypted",
        links: 1,
      },
    ]);
  });
});
