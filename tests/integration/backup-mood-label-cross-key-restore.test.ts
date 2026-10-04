/**
 * A portable file's custom mood labels survive a move to a host with other
 * keys.
 *
 * The labels of the mood tags and mood tag categories a person created are
 * sealed under the writing host's key. A portable file used to carry them as
 * the stored ciphertext, so a restore onto a host with a different key
 * refused the file at the key check, or with a matching key id over other key
 * material wrote labels nobody could open.
 *
 * Both ends and the pipe: built by the real `buildFullBackupPayload` under key
 * A, restored through the real route under key B, opened under key B. The
 * second case is a file written before the fix: a label this host opens comes
 * back, one it cannot open stays out and is named in the skip report.
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

const CATEGORY_LABEL = "Evenings";
const TAG_LABEL = "Migraine";

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
      username: "mood-cross-key-owner",
      email: "mood-cross-key-owner@example.test",
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
      type: "MOOD_CROSS_KEY_RESTORE",
      data: encrypt(JSON.stringify(payload)),
    },
  });
  return POST(makeRequest(backup.id) as unknown as Parameters<typeof POST>[0], {
    params: Promise.resolve({ id: backup.id }),
  });
}

/**
 * One mood entry. The restore writes the account's own tags and categories
 * inside its mood-entry branch, so a file without entries never reaches them.
 */
async function seedMoodEntry(userId: string) {
  await getPrismaClient().moodEntry.create({
    data: {
      userId,
      date: "2026-07-01",
      mood: "GUT",
      score: 4,
      source: "MOODLOG",
      moodLoggedAt: new Date("2026-07-01T20:00:00.000Z"),
    },
  });
}

describe("custom mood labels in a portable file restored under another key", () => {
  it("come back readable under the receiving host's key", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner();

    useKeys(HOST_A, "a");
    await seedMoodEntry(owner.id);
    const category = await prisma.moodTagCategory.create({
      data: {
        userId: owner.id,
        key: "customcat:cross-key",
        labelKey: "mood.category.custom",
        labelEncrypted: encrypt(CATEGORY_LABEL),
      },
    });
    await prisma.moodTag.create({
      data: {
        userId: owner.id,
        categoryId: category.id,
        key: "custom:cross-key",
        labelKey: "mood.tag.custom",
        kind: "BINARY",
        labelEncrypted: encrypt(TAG_LABEL),
      },
    });
    const { payload: built } = await buildFullBackupPayload(prisma, owner.id);
    const file = JSON.parse(JSON.stringify(built)) as unknown;

    // Host B is another database: the rows host A wrote are not there.
    useKeys(HOST_B, "b");
    await prisma.moodTag.deleteMany({ where: { userId: owner.id } });
    await prisma.moodTagCategory.deleteMany({ where: { userId: owner.id } });
    const response = await restore(owner.id, file);
    expect(response.status).toBe(200);

    const restoredCategory = await prisma.moodTagCategory.findUniqueOrThrow({
      where: { key: "customcat:cross-key" },
    });
    expect(decrypt(restoredCategory.labelEncrypted!)).toBe(CATEGORY_LABEL);
    const restoredTag = await prisma.moodTag.findUniqueOrThrow({
      where: { key: "custom:cross-key" },
    });
    expect(decrypt(restoredTag.labelEncrypted!)).toBe(TAG_LABEL);

    const body = (await response.json()) as {
      data: { skipped: { links: number } };
    };
    expect(body.data.skipped.links).toBe(0);
  });

  it("restores a legacy file's label ciphertext only where this host can open it", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner();

    useKeys(HOST_B, "b");
    const ownLabel = encrypt(TAG_LABEL);
    useKeys(HOST_B_IMPOSTOR, "b");
    const impostorLabel = encrypt(CATEGORY_LABEL);

    // The shape a portable file had before the fix: labels as ciphertext.
    useKeys(HOST_B, "b");
    await seedMoodEntry(owner.id);
    const { payload: built } = await buildFullBackupPayload(prisma, owner.id);
    const file = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
    file.customMoodTagCategories = [
      {
        id: "legacy-category-id",
        key: "customcat:legacy",
        labelKey: "mood.category.custom",
        icon: null,
        sortOrder: 0,
        isActive: true,
        labelEncrypted: impostorLabel,
      },
    ];
    file.customMoodTags = [
      {
        key: "custom:legacy",
        labelKey: "mood.tag.custom",
        categoryId: "legacy-category-id",
        kind: "BINARY",
        isActive: true,
        icon: null,
        sortOrder: 0,
        labelEncrypted: ownLabel,
        scaleMin: 1,
        scaleMax: 5,
        inverse: false,
      },
    ];
    parseBackupPayload(JSON.stringify(file));

    const response = await restore(owner.id, file);
    expect(response.status).toBe(200);

    const category = await prisma.moodTagCategory.findUniqueOrThrow({
      where: { key: "customcat:legacy" },
    });
    expect(category.labelEncrypted).toBeNull();
    const tag = await prisma.moodTag.findUniqueOrThrow({
      where: { key: "custom:legacy" },
    });
    expect(decrypt(tag.labelEncrypted!)).toBe(TAG_LABEL);

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
        catalogue: "moodLabelCiphertext",
        key: "customMoodTagCategories.customcat:legacy.labelEncrypted",
        links: 1,
      },
    ]);
  });
});
