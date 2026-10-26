/**
 * A stored backup records the keys its content needs, and the encryption view
 * says a retired key is still needed while any backup lists it.
 *
 * Both ends and the pipe: the copy is written by the real `storeBackupBlob`,
 * the key ids are read from the JSON on its way into the pieces, and the
 * admin status route reads them back. The case the view used to get wrong is
 * the one asserted: every row rotated, the badge said the old key was safe to
 * drop, and a backup still needed it.
 *
 * Mutations that must turn this red: drop the scanner from `storeBackupBlob`
 * (nothing is recorded, the view has no key to name), or leave
 * `retiredKeysStillNeeded` out of `safeToDropRetiredKeys` (the badge says
 * safe again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const saved = {
  key: process.env.ENCRYPTION_KEY,
  keys: process.env.ENCRYPTION_KEYS,
  active: process.env.ENCRYPTION_ACTIVE_KEY_ID,
};

function useKeys(active: string) {
  process.env.ENCRYPTION_KEY = "";
  process.env.ENCRYPTION_KEYS = JSON.stringify({
    old: "11".repeat(32),
    cur: "22".repeat(32),
  });
  process.env.ENCRYPTION_ACTIVE_KEY_ID = active;
  _resetCryptoCacheForTests();
}

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

describe("the keys stored backups still need", () => {
  it("names a retired key a backup's content was written under", async () => {
    const prisma = getPrismaClient();
    const admin = await prisma.user.create({
      data: { username: "keys-admin", email: "k@example.test", role: "ADMIN" },
    });
    const session = await prisma.session.create({
      data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { storeBackupBlob } = await import("@/lib/export/store-backup-blob");
    // A copy taken before the rotation: its note was written under "old".
    useKeys("old");
    const note = Buffer.from(encrypt("before"), "utf8").toString("base64");
    // The copy itself is stored after the rotation, so its envelope is
    // sealed under "cur" and only its content needs "old".
    useKeys("cur");
    await storeBackupBlob(
      prisma,
      { userId: admin.id, type: "MANUAL_UPLOAD_KEYS" },
      async (write) => {
        await write('{"userId":"x","measurements":[{"notesEncrypted":');
        await write(`"${note}"}]}`);
      },
    );
    const row = await prisma.dataBackup.findFirstOrThrow({
      where: { type: "MANUAL_UPLOAD_KEYS" },
    });
    expect(row.innerKeyIds).toEqual(["old"]);
    expect(row.innerKeyIdsRecorded).toBe(true);

    const { GET } = await import("@/app/api/admin/encryption/status/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()).data as {
      rotationComplete: boolean;
      safeToDropRetiredKeys: boolean;
      backups: {
        stored: Array<{ keyId: string; copies: number }>;
        retiredKeysStillNeeded: string[];
      };
    };
    expect(body.backups.stored).toEqual([
      expect.objectContaining({ keyId: "old", copies: 1 }),
    ]);
    expect(body.backups.retiredKeysStillNeeded).toEqual(["old"]);
    expect(body.safeToDropRetiredKeys).toBe(false);
  });
});

describe("the keys the database dumps still need", () => {
  // Every row rotated and no stored copy on the old key: the view called the
  // old key safe to drop while the dumps from before the rotation, the
  // pre-migration one that is the way back from an update among them, could
  // only be restored with it.
  it("names the key a dump on this server or in the bucket was written under", async () => {
    const prisma = getPrismaClient();
    const admin = await prisma.user.create({
      data: { username: "dump-admin", email: "d@example.test", role: "ADMIN" },
    });
    const session = await prisma.session.create({
      data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildManifest, dumpBaseName } =
      await import("@/lib/database-backup/dump-core.mjs");
    const dir = mkdtempSync(join(tmpdir(), "hl-key-needs-"));
    const savedDir = process.env.DB_BACKUP_DIR;
    process.env.DB_BACKUP_DIR = dir;
    try {
      // A pre-migration dump taken while "old" was the active key.
      useKeys("old");
      const base = dumpBaseName(
        "pre-migration",
        new Date(Date.now() - 86_400_000),
      );
      writeFileSync(join(dir, `${base}.dump`), "PGDMP");
      writeFileSync(
        join(dir, `${base}.manifest.json`),
        JSON.stringify(
          buildManifest({
            kind: "pre-migration",
            file: `${base}.dump`,
            createdAt: new Date(),
            latestMigration: null,
            server: { version: "18", versionNum: 180000 },
            pgDump: null,
            archive: { bytes: 5, sha256: "x", entries: 1 },
            rowCounts: {},
            env: process.env,
          }),
        ),
      );
      useKeys("cur");

      const { GET } = await import("@/app/api/admin/encryption/status/route");
      const read = async () =>
        (await (await GET()).json()).data as {
          safeToDropRetiredKeys: boolean;
          backups: {
            dumps: Array<{ keyId: string; local: number }>;
            retiredKeysStillNeeded: string[];
          };
        };
      const local = await read();
      expect(local.backups.dumps).toEqual([
        expect.objectContaining({ keyId: "old", local: 1 }),
      ]);
      expect(local.backups.retiredKeysStillNeeded).toEqual(["old"]);
      expect(local.safeToDropRetiredKeys).toBe(false);

      // Gone from this server; its off-host copy, written under "old", is
      // still in a bucket whose rule for database/ nobody could read.
      rmSync(join(dir, `${base}.dump`));
      rmSync(join(dir, `${base}.manifest.json`));
      await prisma.databaseBackupRun.create({
        data: {
          startedAt: new Date(Date.now() - 86_400_000),
          finishedAt: new Date(Date.now() - 86_000_000),
          status: "succeeded",
          fileName: "healthlog-x-daily.dump",
          localResult: "not_persistent",
          offhostResult: "uploaded",
          activeKeyId: "old",
        },
      });
      const offhost = await read();
      expect(offhost.backups.dumps).toEqual([
        expect.objectContaining({ keyId: "old", local: 0 }),
      ]);
      expect(offhost.backups.retiredKeysStillNeeded).toEqual(["old"]);
    } finally {
      process.env.DB_BACKUP_DIR = savedDir ?? "";
      if (savedDir === undefined) delete process.env.DB_BACKUP_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
