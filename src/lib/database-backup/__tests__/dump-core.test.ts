/**
 * The rules of the whole-database dump that need no database: names,
 * retention, the manifest, key fingerprints, row-count comparison, the
 * connection the client tools get, and the off-host envelope read back by the
 * restore's own reader.
 *
 * The fingerprints and the envelope are checked against the app's own code
 * (`src/lib/crypto.ts`, `src/lib/jobs/offhost-backup.ts`), not against a copy
 * of the rule: the restore script cannot import TypeScript, so these are the
 * tests that keep its plain-JS reading of both from drifting.
 */
import {
  mkdtempSync,
  createReadStream,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyRetention,
  buildManifest,
  compareKeyFingerprints,
  compareRowCounts,
  connectionFromUrl,
  decodeKeyMaterial,
  decryptOffhostFile,
  dumpBaseName,
  formatDumpTimestamp,
  keyFingerprints,
  listDumpSets,
  offhostObjectKey,
  parseDumpFileName,
  parseManifest,
  resolveBackupSchedule,
  resolveDailyKeep,
  selectForDeletion,
  type DumpSet,
} from "../dump-core.mjs";
import type { S3Like } from "@/lib/jobs/offhost-backup";

/** Every byte of a stream, in order. */
async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hl-dump-core-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("dump names", () => {
  it("names a dump by its UTC instant and kind", () => {
    const at = new Date("2026-10-25T01:30:07.123Z");
    expect(formatDumpTimestamp(at)).toBe("20261025T013007Z");
    expect(dumpBaseName("daily", at)).toBe("healthlog-20261025T013007Z-daily");
    expect(dumpBaseName("pre-migration", at)).toBe(
      "healthlog-20261025T013007Z-pre-migration",
    );
  });

  it("parses every file it writes, and back to the same instant", () => {
    const base = "healthlog-20261025T013007Z-daily";
    const cases: Array<[string, string, string]> = [
      [`${base}.dump`, "dump", "final"],
      [`${base}.manifest.json`, "manifest", "final"],
      [`${base}.dump.partial`, "dump", "partial"],
      [`${base}.manifest.json.partial`, "manifest", "partial"],
      [`${base}.dump.enc`, "dump", "encrypted"],
      [`${base}.manifest.json.enc`, "manifest", "encrypted"],
    ];
    for (const [name, role, variant] of cases) {
      const parsed = parseDumpFileName(name);
      expect(parsed, name).not.toBeNull();
      expect(parsed?.base).toBe(base);
      expect(parsed?.kind).toBe("daily");
      expect(parsed?.role).toBe(role);
      expect(parsed?.variant).toBe(variant);
      expect(parsed?.timestamp.toISOString()).toBe("2026-10-25T01:30:07.000Z");
    }
    expect(
      parseDumpFileName("healthlog-20261025T013007Z-pre-migration.dump")?.kind,
    ).toBe("pre-migration");
  });

  it("refuses every name it did not write", () => {
    for (const name of [
      "healthlog.dump",
      "backup-20261025T013007Z-daily.dump",
      "healthlog-20261025T013007Z-weekly.dump",
      "healthlog-20261025-daily.dump",
      "healthlog-20261025T013007Z-daily.sql",
      "healthlog-20261025T013007Z-daily.dump.bak",
      "healthlog-20261399T013007Z-daily.dump",
      "notes.txt",
    ]) {
      expect(parseDumpFileName(name), name).toBeNull();
    }
  });
});

describe("configuration", () => {
  it("keeps at least one daily dump and ignores what is not a number", () => {
    expect(resolveDailyKeep({})).toBe(7);
    expect(resolveDailyKeep({ DB_BACKUP_KEEP: "14" })).toBe(14);
    expect(resolveDailyKeep({ DB_BACKUP_KEEP: "0" })).toBe(1);
    expect(resolveDailyKeep({ DB_BACKUP_KEEP: "-3" })).toBe(7);
    expect(resolveDailyKeep({ DB_BACKUP_KEEP: "seven" })).toBe(7);
  });

  it("takes a five-field cron and says when it ignored one", () => {
    expect(resolveBackupSchedule({})).toEqual({
      cron: "30 1 * * *",
      valid: true,
      configured: false,
    });
    expect(
      resolveBackupSchedule({ DB_BACKUP_SCHEDULE: " 0  2 * * 1-5 " }),
    ).toEqual({
      cron: "0 2 * * 1-5",
      valid: true,
      configured: true,
    });
    for (const bad of ["daily", "0 2 * *", "0 2 * * * *", "0 2 * * mon; rm"]) {
      expect(resolveBackupSchedule({ DB_BACKUP_SCHEDULE: bad })).toEqual({
        cron: "30 1 * * *",
        valid: false,
        configured: true,
      });
    }
  });
});

/** A dump set as `listDumpSets` reports it, for the pure retention rule. */
function set(
  kind: "daily" | "pre-migration",
  iso: string,
  parts: { dump?: boolean; manifest?: boolean; partialAgeMs?: number } = {},
  now = Date.parse("2026-10-25T12:00:00Z"),
): DumpSet {
  const base = dumpBaseName(kind, new Date(iso));
  return {
    base,
    kind,
    timestamp: new Date(iso),
    dump: parts.dump === false ? null : { path: `/b/${base}.dump`, bytes: 1 },
    manifest: parts.manifest === false ? null : `/b/${base}.manifest.json`,
    encryptedDump: null,
    encryptedManifest: null,
    leftovers:
      parts.partialAgeMs === undefined
        ? []
        : [
            {
              path: `/b/${base}.dump.partial`,
              mtimeMs: now - parts.partialAgeMs,
            },
          ],
  };
}

describe("retention", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");

  it("keeps the newest N daily dumps and removes the rest, both files each", () => {
    const sets = [1, 2, 3, 4, 5].map((d) =>
      set("daily", `2026-10-2${d}T01:30:00Z`),
    );
    const doomed = selectForDeletion(sets, {
      keep: { daily: 3, "pre-migration": 2 },
      now,
    });
    expect(doomed.sort()).toEqual(
      [
        "/b/healthlog-20261021T013000Z-daily.dump",
        "/b/healthlog-20261021T013000Z-daily.manifest.json",
        "/b/healthlog-20261022T013000Z-daily.dump",
        "/b/healthlog-20261022T013000Z-daily.manifest.json",
      ].sort(),
    );
  });

  it("never removes the newest good dump, whatever keep says", () => {
    const sets = [
      set("daily", "2026-10-24T01:30:00Z"),
      set("daily", "2026-10-23T01:30:00Z"),
    ];
    const doomed = selectForDeletion(sets, {
      keep: { daily: 0, "pre-migration": 0 },
      now,
    });
    expect(doomed).not.toContain("/b/healthlog-20261024T013000Z-daily.dump");
    expect(doomed).toContain("/b/healthlog-20261023T013000Z-daily.dump");
  });

  it("counts only good dumps: an unfinished newer one does not push out the newest good one", () => {
    const sets = [
      set("daily", "2026-10-25T01:30:00Z", {
        dump: false,
        partialAgeMs: 60_000,
      }),
      set("daily", "2026-10-24T01:30:00Z"),
    ];
    const doomed = selectForDeletion(sets, {
      keep: { daily: 1, "pre-migration": 2 },
      now,
    });
    expect(doomed).toEqual([]);
  });

  it("keeps two pre-migration dumps apart from the daily count", () => {
    const sets = [
      set("pre-migration", "2026-10-20T08:00:00Z"),
      set("pre-migration", "2026-10-10T08:00:00Z"),
      set("pre-migration", "2026-10-01T08:00:00Z"),
      set("daily", "2026-10-24T01:30:00Z"),
    ];
    const doomed = selectForDeletion(sets, {
      keep: { daily: 1, "pre-migration": 2 },
      now,
    });
    expect(doomed).toEqual([
      "/b/healthlog-20261001T080000Z-pre-migration.dump",
      "/b/healthlog-20261001T080000Z-pre-migration.manifest.json",
    ]);
  });

  it("removes a .partial only once it is older than twelve hours", () => {
    const fresh = set("daily", "2026-10-25T01:30:00Z", {
      dump: false,
      manifest: false,
      partialAgeMs: 60 * 60_000,
    });
    const stale = set("daily", "2026-10-23T01:30:00Z", {
      dump: false,
      manifest: false,
      partialAgeMs: 13 * 60 * 60_000,
    });
    const doomed = selectForDeletion([fresh, stale], {
      keep: { daily: 7, "pre-migration": 2 },
      now,
    });
    expect(doomed).toEqual([
      "/b/healthlog-20261023T013000Z-daily.dump.partial",
    ]);
  });

  it("works on a real directory and leaves files it did not write alone", async () => {
    const dir = tempDir();
    const names: string[] = [];
    for (let day = 15; day <= 24; day++) {
      const base = `healthlog-202610${day}T013000Z-daily`;
      names.push(`${base}.dump`, `${base}.manifest.json`);
    }
    // Two that are not ours, and an off-host copy an operator put here.
    names.push(
      "my-own-dump.dump",
      "healthlog-20261001T013000Z-daily.dump.bak",
      "healthlog-20261002T013000Z-daily.dump.enc",
    );
    for (const name of names) writeFileSync(join(dir, name), "x");
    // A crash's leftovers: one old, one from a run that may still be going.
    const oldPartial = join(
      dir,
      "healthlog-20261003T013000Z-daily.dump.partial",
    );
    writeFileSync(oldPartial, "x");
    const day = 24 * 60 * 60;
    utimesSync(oldPartial, Date.now() / 1000 - day, Date.now() / 1000 - day);
    writeFileSync(
      join(dir, "healthlog-20261025T013000Z-daily.dump.partial"),
      "x",
    );

    const removed = await applyRetention(dir, { dailyKeep: 7 });
    expect(removed).toHaveLength(7);
    const left = (await readdir(dir)).sort();
    expect(left).toContain("my-own-dump.dump");
    expect(left).toContain("healthlog-20261001T013000Z-daily.dump.bak");
    expect(left).toContain("healthlog-20261002T013000Z-daily.dump.enc");
    expect(left).toContain("healthlog-20261025T013000Z-daily.dump.partial");
    expect(left).not.toContain("healthlog-20261003T013000Z-daily.dump.partial");
    expect(left.filter((n) => n.endsWith("-daily.dump"))).toEqual(
      [18, 19, 20, 21, 22, 23, 24].map(
        (d) => `healthlog-202610${d}T013000Z-daily.dump`,
      ),
    );
    expect(listDumpSets(dir)[1].base).toBe("healthlog-20261024T013000Z-daily");
  });
});

describe("key fingerprints", () => {
  it("are the fingerprints the app's own key code gives, for the map and the single key", async () => {
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: HEX_A, v2: HEX_B }));
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v2");
    vi.stubEnv("ENCRYPTION_KEY", "");
    const crypto = await import("@/lib/crypto");
    crypto._resetCryptoCacheForTests();
    const prints = keyFingerprints(process.env);
    expect(prints.encryption.activeKeyId).toBe("v2");
    expect(prints.encryption.keys).toEqual([
      { id: "v1", fingerprint: crypto.getKeyFingerprint("v1") },
      { id: "v2", fingerprint: crypto.getKeyFingerprint("v2") },
    ]);

    vi.stubEnv("ENCRYPTION_KEYS", "");
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
    const base64 = Buffer.from(HEX_C, "hex").toString("base64");
    vi.stubEnv("ENCRYPTION_KEY", base64);
    crypto._resetCryptoCacheForTests();
    const single = keyFingerprints(process.env);
    expect(single.encryption).toEqual({
      activeKeyId: "v1",
      keys: [{ id: "v1", fingerprint: crypto.getKeyFingerprint("v1") }],
    });
    crypto._resetCryptoCacheForTests();
  });

  it("names the off-host key the way an off-host object records it", async () => {
    const { offhostKeyId } = await import("@/lib/jobs/offhost-backup");
    const prints = keyFingerprints({
      ENCRYPTION_KEY: HEX_A,
      BACKUP_ENCRYPTION_KEY: HEX_D,
      BACKUP_ENCRYPTION_PREVIOUS_KEYS: ` ${HEX_C} ,`,
      API_TOKEN_HMAC_KEY: "hmac-secret-of-some-length-0123456789",
    });
    expect(prints.backupEncryptionKey).toBe(
      offhostKeyId(Buffer.from(HEX_D, "hex")),
    );
    expect(prints.backupEncryptionPreviousKeys).toEqual([
      offhostKeyId(Buffer.from(HEX_C, "hex")),
    ]);
    expect(prints.apiTokenHmacKey).toMatch(/^[0-9a-f]{12}$/);
  });

  it("never carries key material", () => {
    const env = {
      ENCRYPTION_KEYS: JSON.stringify({ v1: HEX_A }),
      BACKUP_ENCRYPTION_KEY: HEX_B,
      API_TOKEN_HMAC_KEY: HEX_C,
    };
    const text = JSON.stringify(keyFingerprints(env));
    for (const secret of [HEX_A, HEX_B, HEX_C]) {
      expect(text).not.toContain(secret.slice(0, 16));
    }
  });

  it("decodes keys the way the app does, and nothing that is not a key", () => {
    expect(decodeKeyMaterial(HEX_A)?.length).toBe(32);
    expect(
      decodeKeyMaterial(Buffer.alloc(32, 7).toString("base64"))?.length,
    ).toBe(32);
    expect(decodeKeyMaterial("")).toBeNull();
    expect(decodeKeyMaterial("not a key!")).toBeNull();
  });
});

describe("comparing a dump's keys with the environment's", () => {
  const written = keyFingerprints({
    ENCRYPTION_KEYS: JSON.stringify({ v1: HEX_A, v2: HEX_B }),
    ENCRYPTION_ACTIVE_KEY_ID: "v2",
    BACKUP_ENCRYPTION_KEY: HEX_C,
    API_TOKEN_HMAC_KEY: "hmac-one",
  });

  it("finds nothing when every key is there", () => {
    const same = keyFingerprints({
      ENCRYPTION_KEYS: JSON.stringify({ v2: HEX_B, v1: HEX_A }),
      ENCRYPTION_ACTIVE_KEY_ID: "v2",
      BACKUP_ENCRYPTION_KEY: HEX_C,
      API_TOKEN_HMAC_KEY: "hmac-one",
    });
    expect(compareKeyFingerprints(written, same)).toEqual({
      findings: [],
      refuse: false,
    });
  });

  it("refuses when the active key is different, and says which", () => {
    const wrong = keyFingerprints({
      ENCRYPTION_KEYS: JSON.stringify({ v1: HEX_A, v2: HEX_D }),
      ENCRYPTION_ACTIVE_KEY_ID: "v2",
      BACKUP_ENCRYPTION_KEY: HEX_C,
      API_TOKEN_HMAC_KEY: "hmac-one",
    });
    const result = compareKeyFingerprints(written, wrong);
    expect(result.refuse).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      key: "ENCRYPTION_KEYS[v2]",
      state: "different",
      severity: "refuse",
    });
  });

  it("refuses when the active key is missing, warns for a retired one", () => {
    const onlyOld = keyFingerprints({ ENCRYPTION_KEY: HEX_A });
    const result = compareKeyFingerprints(written, onlyOld);
    expect(result.refuse).toBe(true);
    const byKey = Object.fromEntries(result.findings.map((f) => [f.key, f]));
    expect(byKey["ENCRYPTION_KEYS[v2]"]).toMatchObject({
      state: "missing",
      severity: "refuse",
    });
    expect(byKey["ENCRYPTION_KEYS[v1]"]).toBeUndefined();
    expect(byKey.BACKUP_ENCRYPTION_KEY).toMatchObject({
      state: "missing",
      severity: "warn",
    });
    expect(byKey.API_TOKEN_HMAC_KEY).toMatchObject({
      state: "missing",
      severity: "warn",
    });

    const noRetired = keyFingerprints({
      ENCRYPTION_KEYS: JSON.stringify({ v2: HEX_B }),
      BACKUP_ENCRYPTION_KEY: HEX_C,
      API_TOKEN_HMAC_KEY: "hmac-two",
    });
    const second = compareKeyFingerprints(written, noRetired);
    expect(second.refuse).toBe(false);
    expect(second.findings.map((f) => [f.key, f.severity])).toEqual([
      ["ENCRYPTION_KEYS[v1]", "warn"],
      ["API_TOKEN_HMAC_KEY", "warn"],
    ]);
  });
});

describe("the manifest", () => {
  const manifest = buildManifest({
    kind: "daily",
    file: "healthlog-20261025T013000Z-daily.dump",
    createdAt: new Date("2026-10-25T01:30:00Z"),
    appVersion: "1.46.0",
    buildSha: "abc1234",
    latestMigration: "0486_database_backup_runs",
    server: { version: "18.6", versionNum: 180006 },
    pgDump: "pg_dump (PostgreSQL) 18.6",
    archive: { bytes: 1234, sha256: "f".repeat(64), entries: 900 },
    rowCounts: { "public.users": 3, "pgboss.job": 12, "public.a": 0 },
    env: { ENCRYPTION_KEY: HEX_A, API_TOKEN_HMAC_KEY: "h" },
  });

  it("carries what a restore and an operator need", () => {
    expect(manifest).toMatchObject({
      format: "healthlog-database-dump",
      formatVersion: 1,
      kind: "daily",
      file: "healthlog-20261025T013000Z-daily.dump",
      createdAt: "2026-10-25T01:30:00.000Z",
      appVersion: "1.46.0",
      buildSha: "abc1234",
      latestMigration: "0486_database_backup_runs",
      postgres: { serverVersion: "18.6", serverVersionNum: 180006 },
      dump: { bytes: 1234, sha256: "f".repeat(64), entries: 900 },
    });
    expect(Object.keys(manifest.rowCounts)).toEqual([
      "pgboss.job",
      "public.a",
      "public.users",
    ]);
    expect(manifest.keys.encryption.keys[0].id).toBe("v1");
  });

  it("reads back, and refuses anything else", () => {
    expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
      manifest,
    );
    expect(() => parseManifest({ format: "something-else" })).toThrow(
      /not a HealthLog/,
    );
    expect(() => parseManifest({ ...manifest, formatVersion: 2 })).toThrow();
    expect(() => parseManifest(null)).toThrow();
  });
});

describe("row counts after a restore", () => {
  it("names every table that is missing, extra or different", () => {
    expect(
      compareRowCounts(
        { "public.a": 1, "public.b": 2 },
        { "public.a": 1, "public.b": 2 },
      ),
    ).toEqual([]);
    expect(
      compareRowCounts(
        { "public.a": 1, "public.b": 2, "public.c": 5 },
        { "public.a": 1, "public.b": 0, "public.d": 1 },
      ),
    ).toEqual([
      "public.b: 2 rows in the dump, 0 restored",
      "public.c: in the dump with 5 rows, missing now",
      "public.d: restored but not in the dump's manifest",
    ]);
  });
});

describe("the connection the client tools get", () => {
  it("drops Prisma's parameters and keeps the password out of the arguments", () => {
    const c = connectionFromUrl(
      "postgresql://health%40log:p%40ss%2Fw@db:6543/hl?schema=app&connection_limit=20&pool_timeout=20&sslmode=require",
    );
    expect(c.pgEnv).toEqual({
      PGHOST: "db",
      PGPORT: "6543",
      PGUSER: "health@log",
      PGPASSWORD: "p@ss/w",
      PGDATABASE: "hl",
      PGSSLMODE: "require",
    });
    expect(c.schema).toBe("app");
    const cs = String(c.clientConfig.connectionString);
    expect(cs).not.toContain("connection_limit");
    expect(cs).not.toContain("schema=");
    expect(cs).toContain("sslmode=require");
  });
});

describe("an off-host copy read back by the restore", () => {
  /** The uploader the job uses, into memory. */
  async function upload(objectKey: string, key: Buffer, body: Buffer) {
    const { uploadEncryptedBackup } = await import("@/lib/jobs/offhost-backup");
    const stored = new Map<string, Buffer>();
    const s3: S3Like = {
      putStream: async (k: string, stream: Readable) => {
        stored.set(k, await collect(stream));
      },
      putObject: async () => {},
      getObject: async () => Buffer.alloc(0),
      headObject: async () => false,
      listObjects: async () => [],
      deleteObject: async () => {},
    };
    await uploadEncryptedBackup(s3, objectKey, key, async (write) => {
      // Several pieces, as the job streams the file.
      for (let i = 0; i < body.length; i += 1000) {
        await write(body.subarray(i, i + 1000));
      }
    });
    return stored.get(objectKey) as Buffer;
  }

  it("opens what the job's uploader sealed, byte for byte", async () => {
    const dir = tempDir();
    const key = Buffer.from(HEX_D, "hex");
    const body = Buffer.from(Array.from({ length: 50_000 }, (_, i) => i % 251));
    const name = "healthlog-20261025T013000Z-daily.dump.enc";
    const sealed = await upload(offhostObjectKey(name), key, body);
    writeFileSync(join(dir, name), sealed);

    await decryptOffhostFile({
      inPath: join(dir, name),
      outPath: join(dir, "opened.dump"),
      objectKey: offhostObjectKey(name),
      keys: [Buffer.from(HEX_A, "hex"), key],
    });
    expect(
      (await collect(createReadStream(join(dir, "opened.dump")))).equals(body),
    ).toBe(true);
  });

  it("refuses a copy renamed, altered or under a key it does not hold, and leaves nothing", async () => {
    const dir = tempDir();
    const key = Buffer.from(HEX_D, "hex");
    const body = Buffer.from("PGDMP fake archive bytes".repeat(100));
    const name = "healthlog-20261025T013000Z-daily.dump.enc";
    const sealed = await upload(offhostObjectKey(name), key, body);
    writeFileSync(join(dir, name), sealed);
    const out = join(dir, "opened.dump");

    // Renamed: the object key is bound as associated data.
    await expect(
      decryptOffhostFile({
        inPath: join(dir, name),
        outPath: out,
        objectKey: offhostObjectKey(
          "healthlog-20261024T013000Z-daily.dump.enc",
        ),
        keys: [key],
      }),
    ).rejects.toThrow(/does not open/);
    expect(await readdir(dir)).toEqual([name]);

    // Altered.
    const altered = Buffer.from(sealed);
    altered[altered.length - 40] ^= 1;
    writeFileSync(join(dir, name), altered);
    await expect(
      decryptOffhostFile({
        inPath: join(dir, name),
        outPath: out,
        objectKey: offhostObjectKey(name),
        keys: [key],
      }),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([name]);

    // A key it was not written under.
    writeFileSync(join(dir, name), sealed);
    await expect(
      decryptOffhostFile({
        inPath: join(dir, name),
        outPath: out,
        objectKey: offhostObjectKey(name),
        keys: [Buffer.from(HEX_A, "hex")],
      }),
    ).rejects.toThrow(/neither BACKUP_ENCRYPTION_KEY nor/);
    expect(await readdir(dir)).toEqual([name]);
  });
});
