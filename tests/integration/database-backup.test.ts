/**
 * The nightly whole-database dump against a real Postgres: the job writes a
 * dump and its manifest, records the run, copies both off-host in the
 * envelope the restore opens, keeps only what retention allows; and the
 * restore puts the dump into an empty database and refuses one with tables.
 *
 * `pg_dump` and `pg_restore` are the test container's own. A workstation may
 * have none, or one of another major than the server (which `pg_dump`
 * refuses), so the test puts two small forwarders on PATH that run the tool
 * inside the database container with `docker exec`. Everything else, the
 * snapshot, the counts, the manifest, the ledger and the restore's checks,
 * runs exactly as in the image.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import { getDatabaseBackupHealth } from "@/lib/database-backup/health";
import { evaluateDatabaseDump } from "@/lib/recovery/readiness-model";
import { runDatabaseBackup } from "@/lib/database-backup/run";
import {
  connect,
  countRows,
  decryptOffhostFile,
  offhostObjectKey,
  readManifestFile,
} from "@/lib/database-backup/dump-core.mjs";

import { main as restoreMain } from "../../scripts/db-restore.mjs";
import { shippedMigrations } from "../../scripts/pending-migrations.mjs";

const OFFHOST_KEY = "e".repeat(64);
const work = mkdtempSync(join(tmpdir(), "hl-db-backup-"));
const backups = join(work, "backups");
const shims = join(work, "bin");
const originalPath = process.env.PATH;

/** The id of the container that serves DATABASE_URL. */
function containerId(): string {
  const port = new URL(process.env.DATABASE_URL ?? "").port;
  const rows = execFileSync(
    "docker",
    ["ps", "--format", "{{.ID}} {{.Ports}}"],
    {
      encoding: "utf8",
    },
  ).split("\n");
  const row = rows.find((r) => r.includes(`:${port}->5432/tcp`));
  if (!row) throw new Error(`no container publishes port ${port}`);
  return row.split(" ")[0];
}

/**
 * `pg_dump` / `pg_restore` that run inside the database container. The
 * connection comes from the PG* variables the core sets; host and port become
 * the container's own. A file argument that exists on this machine is sent on
 * standard input, which both tools read when no file is named.
 */
function writeShims(container: string): void {
  for (const tool of ["pg_dump", "pg_restore"]) {
    const path = join(shims, tool);
    writeFileSync(
      path,
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { createReadStream, existsSync } = require("node:fs");
const args = process.argv.slice(2);
let input = null;
if (args.length && !args[args.length - 1].startsWith("-") && existsSync(args[args.length - 1])) {
  input = args.pop();
}
const env = [];
for (const name of ["PGUSER", "PGPASSWORD", "PGDATABASE"]) {
  if (process.env[name] !== undefined) env.push("-e", name + "=" + process.env[name]);
}
env.push("-e", "PGHOST=127.0.0.1", "-e", "PGPORT=5432");
const child = spawn("docker", ["exec", "-i", ...env, ${JSON.stringify(container)}, ${JSON.stringify(tool)}, ...args], {
  stdio: ["pipe", "inherit", "inherit"],
});
(input ? createReadStream(input) : process.stdin).pipe(child.stdin);
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`,
    );
    chmodSync(path, 0o755);
  }
}

/** A bucket in memory, with the one call the job's uploader uses. */
function memoryBucket() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putStream: async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(c as Buffer);
      objects.set(key, Buffer.concat(chunks));
    },
  };
}

function backupEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, DB_BACKUP_DIR: backups, ...extra };
}

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(shims, { recursive: true });
  mkdirSync(backups, { recursive: true });
  writeShims(containerId());
  process.env.PATH = `${shims}:${originalPath}`;
  for (const name of ["dump-a", "dump-b", "dump-c"]) {
    await prisma.user.create({
      data: { username: `${name}-${Date.now()}` },
    });
  }
});

afterAll(() => {
  process.env.PATH = originalPath;
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

describe("the nightly database dump", () => {
  let dumpFile = "";

  it("writes a checked dump and manifest, records the run and copies both off-host", async () => {
    vi.stubEnv("BACKUP_S3_ENDPOINT", "https://bucket.invalid");
    vi.stubEnv("BACKUP_S3_BUCKET", "b");
    vi.stubEnv("BACKUP_S3_ACCESS_KEY", "a");
    vi.stubEnv("BACKUP_S3_SECRET_KEY", "s");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", OFFHOST_KEY);
    const bucket = memoryBucket();
    const now = new Date("2026-10-20T01:30:00Z");

    const report = await runDatabaseBackup(prisma, {
      now,
      env: backupEnv(),
      s3: bucket as never,
    });
    expect(report).toMatchObject({
      status: "succeeded",
      local: "written",
      offhost: "uploaded",
      error: null,
      fileName: "healthlog-20261020T013000Z-daily.dump",
    });
    dumpFile = join(backups, report.fileName ?? "");

    // Both files, under their final names, and nothing half-written.
    expect(readdirSync(backups).sort()).toEqual([
      "healthlog-20261020T013000Z-daily.dump",
      "healthlog-20261020T013000Z-daily.manifest.json",
    ]);
    expect(readFileSync(dumpFile).subarray(0, 5).toString("latin1")).toBe(
      "PGDMP",
    );

    const manifest = await readManifestFile(
      join(backups, "healthlog-20261020T013000Z-daily.manifest.json"),
    );
    expect(manifest.kind).toBe("daily");
    expect(manifest.dump.bytes).toBe(report.dumpBytes);
    expect(manifest.latestMigration).toBe(
      shippedMigrations(join(process.cwd(), "prisma", "migrations")).at(-1),
    );
    expect(manifest.postgres.serverVersionNum).toBeGreaterThanOrEqual(160000);
    expect(manifest.rowCounts["public.users"]).toBe(await prisma.user.count());
    expect(Object.keys(manifest.rowCounts).length).toBeGreaterThan(100);
    expect(manifest.keys.encryption.keys.length).toBeGreaterThan(0);
    expect(manifest.keys.backupEncryptionKey).toMatch(/^[0-9a-f]{12}$/);

    // The ledger row and what the admin page reads from it.
    const runs = await prisma.databaseBackupRun.findMany({
      where: { startedAt: now },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "succeeded",
      fileName: "healthlog-20261020T013000Z-daily.dump",
      localResult: "written",
      offhostResult: "uploaded",
      error: null,
    });
    expect(Number(runs[0].dumpBytes)).toBe(manifest.dump.bytes);
    const health = await getDatabaseBackupHealth(
      new Date("2026-10-20T02:00:00Z"),
      backupEnv(),
    );
    expect(health).toMatchObject({
      enabled: true,
      localDirWritable: true,
      offhostConfigured: true,
      lastGood: {
        fileName: "healthlog-20261020T013000Z-daily.dump",
        sizeBytes: manifest.dump.bytes,
        local: true,
        offhost: true,
      },
    });

    // The off-host pair opens, with the restore's own reader, to the very
    // bytes on disk.
    expect([...bucket.objects.keys()].sort()).toEqual([
      "database/healthlog-20261020T013000Z-daily.dump.enc",
      "database/healthlog-20261020T013000Z-daily.manifest.json.enc",
    ]);
    const opened = join(work, "opened");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(opened);
    for (const name of [
      "healthlog-20261020T013000Z-daily.dump",
      "healthlog-20261020T013000Z-daily.manifest.json",
    ]) {
      writeFileSync(
        join(opened, `${name}.enc`),
        bucket.objects.get(offhostObjectKey(`${name}.enc`)) as Buffer,
      );
      await decryptOffhostFile({
        inPath: join(opened, `${name}.enc`),
        outPath: join(opened, name),
        objectKey: offhostObjectKey(`${name}.enc`),
        keys: [Buffer.from(OFFHOST_KEY, "hex")],
      });
      expect(
        readFileSync(join(opened, name)).equals(
          readFileSync(join(backups, name)),
        ),
      ).toBe(true);
    }
    vi.unstubAllEnvs();
  });

  it("keeps DB_BACKUP_KEEP nightly dumps and removes the oldest", async () => {
    for (const day of ["21", "22", "23"]) {
      const report = await runDatabaseBackup(prisma, {
        now: new Date(`2026-10-${day}T01:30:00Z`),
        env: backupEnv({ DB_BACKUP_KEEP: "2" }),
      });
      expect(report.status).toBe("succeeded");
      expect(report.offhost).toBe("not_configured");
    }
    expect(readdirSync(backups).filter((n) => n.endsWith(".dump"))).toEqual([
      "healthlog-20261022T013000Z-daily.dump",
      "healthlog-20261023T013000Z-daily.dump",
    ]);
  });

  it("records a failed dump, leaves nothing that looks good, and the page says so", async () => {
    const before = readdirSync(backups).sort();
    const url = new URL(process.env.DATABASE_URL ?? "");
    url.password = "not-the-password";
    const now = new Date("2026-10-24T01:30:00Z");
    const report = await runDatabaseBackup(prisma, {
      now,
      env: backupEnv({ DATABASE_URL: url.toString() }),
    });
    expect(report.status).toBe("failed");
    expect(report.local).toBe("failed");
    expect(report.error).toMatch(/password authentication failed/);
    expect(readdirSync(backups).sort()).toEqual(before);
    const health = await getDatabaseBackupHealth(
      new Date("2026-10-24T02:00:00Z"),
      backupEnv(),
    );
    expect(health.lastFailure?.error).toMatch(/password authentication/);
    expect(health.lastGood?.fileName).toBe(
      "healthlog-20261023T013000Z-daily.dump",
    );
  });

  it("skips, and says why, with nowhere to put a dump", async () => {
    const report = await runDatabaseBackup(prisma, {
      now: new Date("2026-10-24T03:00:00Z"),
      env: backupEnv({ DB_BACKUP_DIR: "/proc/healthlog-cannot-write-here" }),
    });
    expect(report).toMatchObject({
      status: "skipped",
      local: "no_directory",
      offhost: "not_configured",
    });
    expect(report.error).toMatch(/no writable backup directory/);
    const off = await runDatabaseBackup(prisma, {
      now: new Date("2026-10-24T04:00:00Z"),
      env: backupEnv({ DB_BACKUP_ENABLED: "false" }),
    });
    expect(off).toMatchObject({
      status: "skipped",
      local: "skipped",
      offhost: "skipped",
    });
  });

  it("keeps nothing in a directory inside the container, and stops counting what was written there", async () => {
    const { mkdirSync } = await import("node:fs");
    const layerDir = join(work, "container-layer");
    mkdirSync(layerDir);
    // The image's own directory without the volume: writable, and thrown
    // away with the container at the next update.
    const layer = () =>
      ({
        writable: true,
        persistent: false,
        reason: "container_layer",
      }) as const;
    const env = backupEnv({ DB_BACKUP_DIR: layerDir });

    const skipped = await runDatabaseBackup(prisma, {
      now: new Date("2026-10-24T05:00:00Z"),
      env,
      directoryStatus: layer,
    });
    expect(skipped).toMatchObject({
      status: "skipped",
      local: "not_persistent",
      offhost: "not_configured",
    });
    expect(skipped.error).toMatch(/not on persistent storage/);
    expect(readdirSync(layerDir)).toEqual([]);

    // Read as keeping nothing, the newest dump that still exists is the one
    // that reached the bucket on the 20th, not the local-only one of the
    // 23rd; read as a volume, it is the 23rd's.
    const asLayer = await getDatabaseBackupHealth(
      new Date("2026-10-24T05:30:00Z"),
      env,
      layer,
    );
    expect(asLayer).toMatchObject({
      localDirWritable: true,
      localPersistent: false,
      localReason: "container_layer",
      lastGood: {
        fileName: "healthlog-20261020T013000Z-daily.dump",
        local: false,
        offhost: true,
      },
    });
    const asVolume = await getDatabaseBackupHealth(
      new Date("2026-10-24T05:30:00Z"),
      backupEnv(),
    );
    expect(asVolume.localPersistent).toBe(true);
    expect(asVolume.lastGood).toMatchObject({
      fileName: "healthlog-20261023T013000Z-daily.dump",
      local: true,
    });

    vi.stubEnv("BACKUP_S3_ENDPOINT", "https://bucket.invalid");
    vi.stubEnv("BACKUP_S3_BUCKET", "b");
    vi.stubEnv("BACKUP_S3_ACCESS_KEY", "a");
    vi.stubEnv("BACKUP_S3_SECRET_KEY", "s");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", OFFHOST_KEY);
    const bucket = memoryBucket();
    const uploaded = await runDatabaseBackup(prisma, {
      now: new Date("2026-10-24T06:00:00Z"),
      env: backupEnv({ DB_BACKUP_DIR: layerDir }),
      s3: bucket as never,
      directoryStatus: layer,
    });
    vi.unstubAllEnvs();
    expect(uploaded).toMatchObject({
      status: "succeeded",
      local: "not_persistent",
      offhost: "uploaded",
      removed: 0,
    });
    expect(readdirSync(layerDir)).toEqual([]);
    expect([...bucket.objects.keys()].sort()).toEqual([
      "database/healthlog-20261024T060000Z-daily.dump.enc",
      "database/healthlog-20261024T060000Z-daily.manifest.json.enc",
    ]);
    const row = await prisma.databaseBackupRun.findFirst({
      where: { startedAt: new Date("2026-10-24T06:00:00Z") },
    });
    expect(row).toMatchObject({
      localResult: "not_persistent",
      offhostResult: "uploaded",
    });
  });

  // A dump kept on the volume and refused by the bucket is the newest good
  // dump and the newest failure at once. Read as only those two it looked
  // healthy, night after night, while nothing left the host.
  it("does not read a kept dump as healthy when the bucket refused it", async () => {
    const { mkdirSync } = await import("node:fs");
    const dir = join(work, "upload-refused");
    mkdirSync(dir);
    vi.stubEnv("BACKUP_S3_ENDPOINT", "https://bucket.invalid");
    vi.stubEnv("BACKUP_S3_BUCKET", "b");
    vi.stubEnv("BACKUP_S3_ACCESS_KEY", "a");
    vi.stubEnv("BACKUP_S3_SECRET_KEY", "s");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", OFFHOST_KEY);
    const refusing = {
      putStream: async (_key: string, body: Readable) => {
        for await (const _ of body) void _;
        throw new Error("AccessDenied on database/");
      },
    };
    const report = await runDatabaseBackup(prisma, {
      now: new Date("2026-10-24T07:00:00Z"),
      env: backupEnv({ DB_BACKUP_DIR: dir }),
      s3: refusing as never,
    });
    vi.unstubAllEnvs();
    expect(report).toMatchObject({
      status: "failed",
      local: "written",
      offhost: "failed",
    });

    const health = await getDatabaseBackupHealth(
      new Date(),
      backupEnv({ DB_BACKUP_DIR: dir }),
    );
    expect(health.lastGood).toMatchObject({
      fileName: "healthlog-20261024T070000Z-daily.dump",
      local: true,
      offhost: false,
    });
    expect(health.offhostConfigured).toBe(true);
    expect(health.offhost.lastUploadAt).not.toBeNull();
    expect(health.offhost.failure?.error).toMatch(/AccessDenied/);
    expect(
      evaluateDatabaseDump({
        now: new Date(),
        dump: health,
        dumpWatchedSince: null,
      }),
    ).toMatchObject({
      state: "attention",
      reason: "offhost_failed",
      detail: expect.stringMatching(/AccessDenied/),
    });
  });

  describe("restoring it", () => {
    const target = `restore_${process.pid}_${Date.now()}`;
    let targetUrl = "";

    beforeAll(async () => {
      const admin = await connect(process.env.DATABASE_URL ?? "");
      await admin.query(`CREATE DATABASE ${target}`);
      await admin.end();
      const url = new URL(process.env.DATABASE_URL ?? "");
      url.pathname = `/${target}`;
      targetUrl = url.toString();
    });

    afterAll(async () => {
      const admin = await connect(process.env.DATABASE_URL ?? "");
      await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
      await admin.end();
    });

    it("refuses the database the dump came from, which has tables", async () => {
      const errors: string[] = [];
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation((l: string) => void errors.push(String(l)));
      const code = await restoreMain(["latest"], backupEnv());
      spy.mockRestore();
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/only into an empty database/);
    });

    it("restores the newest dump into an empty database with every row count", async () => {
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((l: string) => void lines.push(String(l)));
      const code = await restoreMain(
        ["latest"],
        backupEnv({ DATABASE_URL: targetUrl }),
      );
      spy.mockRestore();
      expect(code, lines.join("\n")).toBe(0);
      expect(lines.join("\n")).toMatch(
        /all \d+ tables hold the row counts the manifest names/,
      );

      const manifest = await readManifestFile(
        join(backups, "healthlog-20261023T013000Z-daily.manifest.json"),
      );
      const client = await connect(targetUrl);
      try {
        expect(await countRows(client)).toEqual(manifest.rowCounts);
        const { rows } = await client.query(
          "SELECT count(*)::int AS n FROM users WHERE username LIKE 'dump-%'",
        );
        expect(rows[0].n).toBeGreaterThanOrEqual(3);
      } finally {
        await client.end();
      }
      // Restoring again into the now full database is refused.
      const again = await restoreMain(
        ["latest"],
        backupEnv({ DATABASE_URL: targetUrl }),
      );
      expect(again).toBe(1);
      expect(existsSync(dumpFile)).toBe(false); // the first dump aged out
    });
  });
});

describe("the dump before migrating", () => {
  const preDir = join(work, "pre");
  const appDir = join(work, "app");
  const failing = join(work, "failing-bin");
  let cwd = "";

  beforeAll(async () => {
    const { cpSync, mkdirSync } = await import("node:fs");
    // An image that ships one migration the database has not applied.
    mkdirSync(join(appDir, "prisma"), { recursive: true });
    cpSync(
      join(process.cwd(), "prisma", "migrations"),
      join(appDir, "prisma", "migrations"),
      { recursive: true },
    );
    mkdirSync(join(appDir, "prisma", "migrations", "9999_not_applied_yet"));
    writeFileSync(
      join(
        appDir,
        "prisma",
        "migrations",
        "9999_not_applied_yet",
        "migration.sql",
      ),
      "",
    );
    mkdirSync(preDir, { recursive: true });
    mkdirSync(failing, { recursive: true });
    writeFileSync(
      join(failing, "pg_dump"),
      "#!/bin/sh\necho 'pg_dump: error: could not write to output file: No space left on device' >&2\nexit 1\n",
    );
    chmodSync(join(failing, "pg_dump"), 0o755);
    cwd = process.cwd();
    process.chdir(appDir);
  });

  afterAll(() => {
    process.chdir(cwd);
    process.env.PATH = `${shims}:${originalPath}`;
  });

  async function preMigration(env: Record<string, string>) {
    const { preMigrationDump } = await import("../../scripts/db-dump.mjs");
    const errors: string[] = [];
    const spyErr = vi
      .spyOn(console, "error")
      .mockImplementation((l: string) => void errors.push(String(l)));
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await preMigrationDump({ ...process.env, ...env });
      return { code, errors: errors.join("\n") };
    } finally {
      spyErr.mockRestore();
      spyLog.mockRestore();
    }
  }

  it("writes a checked dump with its manifest, and keeps the last two", async () => {
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1100));
      const { code } = await preMigration({ DB_BACKUP_DIR: preDir });
      expect(code).toBe(0);
    }
    const names = readdirSync(preDir).sort();
    expect(names).toHaveLength(4);
    expect(names.filter((n) => n.endsWith("-pre-migration.dump"))).toHaveLength(
      2,
    );
    const manifest = await readManifestFile(
      join(preDir, names.find((n) => n.endsWith(".manifest.json")) ?? ""),
    );
    expect(manifest.kind).toBe("pre-migration");
    expect(manifest.rowCounts["public.users"]).toBe(await prisma.user.count());
  });

  it("does nothing when switched off", async () => {
    const before = readdirSync(preDir);
    const { code } = await preMigration({
      DB_BACKUP_DIR: preDir,
      DB_BACKUP_BEFORE_MIGRATE: "false",
    });
    expect(code).toBe(0);
    expect(readdirSync(preDir)).toEqual(before);
  });

  it("warns and lets the boot go on without a writable directory", async () => {
    const { code, errors } = await preMigration({
      DB_BACKUP_DIR: "/proc/healthlog-cannot-write-here",
    });
    expect(code).toBe(0);
    expect(errors).toMatch(
      /is not writable, so no dump is taken before the 1 pending migration/,
    );
  });

  it("takes no dump into a directory inside the container, says why, and lets the boot go on", async () => {
    const { preMigrationDump } = await import("../../scripts/db-dump.mjs");
    const before = readdirSync(preDir).sort();
    const errors: string[] = [];
    const spyErr = vi
      .spyOn(console, "error")
      .mockImplementation((l: string) => void errors.push(String(l)));
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await preMigrationDump(
        { ...process.env, DB_BACKUP_DIR: preDir },
        {
          directoryStatus: () => ({
            writable: true,
            persistent: false,
            reason: "container_layer",
          }),
        },
      );
      expect(code).toBe(0);
    } finally {
      spyErr.mockRestore();
      spyLog.mockRestore();
    }
    expect(errors.join("\n")).toMatch(
      /is inside the container, not on a mounted volume, and would not keep a dump past this update, so no dump is taken before the 1 pending migration/,
    );
    expect(readdirSync(preDir).sort()).toEqual(before);
  });

  it("stops the boot when the dump fails on a writable directory, and leaves no dump behind", async () => {
    // A second of its own, so the name cannot meet the last dump's.
    await new Promise((r) => setTimeout(r, 1100));
    const before = readdirSync(preDir).sort();
    process.env.PATH = `${failing}:${originalPath}`;
    const { code, errors } = await preMigration({ DB_BACKUP_DIR: preDir });
    process.env.PATH = `${shims}:${originalPath}`;
    expect(code).toBe(1);
    expect(errors).toMatch(
      /the database dump before migrating failed: .*No space left/,
    );
    expect(readdirSync(preDir).sort()).toEqual(before);
  });
});

describe("two dumps in the same second", () => {
  it("refuses the second and leaves the first whole", async () => {
    const { createDatabaseDump } =
      await import("@/lib/database-backup/dump-core.mjs");
    const dir = join(work, "same-second");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir);
    const now = new Date("2026-10-26T01:30:00Z");
    const options = {
      databaseUrl: process.env.DATABASE_URL ?? "",
      dir,
      kind: "daily" as const,
      now,
    };
    await createDatabaseDump(options);
    const before = readdirSync(dir)
      .sort()
      .map((n) => [n, readFileSync(join(dir, n)).length]);
    await expect(createDatabaseDump(options)).rejects.toThrow(/already exists/);
    expect(
      readdirSync(dir)
        .sort()
        .map((n) => [n, readFileSync(join(dir, n)).length]),
    ).toEqual(before);
  });
});
