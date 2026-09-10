/**
 * The off-host ledger, end to end against real Postgres.
 *
 * Both ends and the pipe: the nightly job is what writes the row, the admin
 * console is what reads it, and a unit test that mocks Prisma proves neither
 * the migration nor the shape they agree on. Here the real
 * `runOffhostBackup()` uploads into an in-memory bucket double, the row lands
 * in the real table, and the verdict the console shows is computed from what
 * came back out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";

import {
  classifyOffhostBackup,
  OFFHOST_BACKUP_GRACE_HOURS,
  OFFHOST_BACKUP_PERIOD_HOURS,
} from "@/lib/jobs/offhost-backup-freshness";
import {
  offhostBackupConfigured,
  runOffhostBackup,
  type S3Like,
} from "@/lib/jobs/offhost-backup";
import { getPrismaClient, truncateAllTables } from "./setup";

const HOUR = 3_600_000;

/** The five variables the job insists on, none of which reach a network here. */
const ENV: Record<string, string> = {
  BACKUP_S3_ENDPOINT: "http://bucket.invalid",
  BACKUP_S3_BUCKET: "healthlog-test",
  BACKUP_S3_ACCESS_KEY: "test-access-key",
  BACKUP_S3_SECRET_KEY: "test-secret-key",
  BACKUP_ENCRYPTION_KEY:
    "1111111111111111111111111111111111111111111111111111111111111111",
};

function makeBucket(): S3Like & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    putObject: async (key, body) => {
      store.set(key, Buffer.from(body));
    },
    putStream: async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      store.set(key, Buffer.concat(chunks));
    },
    getObject: async (key) => store.get(key) ?? Buffer.alloc(0),
    headObject: async (key) => store.has(key),
    listObjects: async () => [],
    deleteObject: async (key) => {
      store.delete(key);
    },
  };
}

async function seedUser(id: string): Promise<void> {
  await getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
});

describe("off-host backup ledger (real Postgres)", () => {
  it("writes one row per uploaded account and reads back as fresh", async () => {
    const prisma = getPrismaClient();
    await seedUser("account-one");
    await seedUser("account-two");

    expect(offhostBackupConfigured()).toBe(true);

    const bucket = makeBucket();
    const report = await runOffhostBackup(prisma, bucket, new Date());
    expect(report.uploaded).toBe(2);
    expect(report.failed).toBe(0);

    const rows = await prisma.offhostBackupState.findMany({
      orderBy: { userId: "asc" },
    });
    expect(rows.map((row) => row.userId)).toEqual([
      "account-one",
      "account-two",
    ]);

    for (const row of rows) {
      // The size the ledger claims is the size of the object that landed, not
      // an estimate: an operator sizing a bucket reads this column.
      const object = bucket.store.get(
        `${new Date().toISOString().slice(0, 10)}/user-${row.userId}.json.enc`,
      );
      expect(object).toBeDefined();
      expect(Number(row.sizeBytes)).toBe(object?.byteLength);

      expect(
        classifyOffhostBackup({
          lastAttemptAt: row.lastAttemptAt,
          lastSuccessAt: row.lastSuccessAt,
          now: new Date(),
        }).freshness,
      ).toBe("fresh");
    }
  });

  it("keeps one row per account across runs and ages into stale", async () => {
    const prisma = getPrismaClient();
    await seedUser("account-one");

    const bucket = makeBucket();
    await runOffhostBackup(prisma, bucket, new Date());
    await runOffhostBackup(prisma, bucket, new Date());

    expect(await prisma.offhostBackupState.count()).toBe(1);

    // Age the row past two nightly runs — the state the console must not miss,
    // because the run that skipped this account still reported a success for
    // everybody else.
    const aged = new Date(
      Date.now() -
        (OFFHOST_BACKUP_PERIOD_HOURS * 2 + OFFHOST_BACKUP_GRACE_HOURS + 1) *
          HOUR,
    );
    await prisma.offhostBackupState.update({
      where: { userId: "account-one" },
      data: { lastSuccessAt: aged },
    });

    const row = await prisma.offhostBackupState.findUniqueOrThrow({
      where: { userId: "account-one" },
    });
    expect(
      classifyOffhostBackup({
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        now: new Date(),
      }).freshness,
    ).toBe("stale");
  });

  it("separates an account no run has recorded from one a run found nothing for", async () => {
    const prisma = getPrismaClient();
    await seedUser("account-one");

    // Before any run: the ledger is empty, which is what every account on a
    // host that has been uploading for months looks like the moment this
    // table ships. It must not read as "nothing has ever reached the bucket".
    expect(
      classifyOffhostBackup({
        lastAttemptAt: null,
        lastSuccessAt: null,
        now: new Date(),
      }).freshness,
    ).toBe("unknown");

    // A run that reaches the account and produces no object records the walk
    // and leaves the success columns alone.
    const bucket = makeBucket();
    bucket.putStream = async () => {
      throw new Error("bucket refused the signature");
    };
    const report = await runOffhostBackup(prisma, bucket, new Date());
    expect(report.uploaded).toBe(0);
    expect(report.failed).toBe(1);

    const row = await prisma.offhostBackupState.findUniqueOrThrow({
      where: { userId: "account-one" },
    });
    expect(row.lastSuccessAt).toBeNull();
    expect(row.sizeBytes).toBeNull();
    expect(
      classifyOffhostBackup({
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        now: new Date(),
      }).freshness,
    ).toBe("never");
  });

  it("keeps the last good copy on the row when a later run fails", async () => {
    const prisma = getPrismaClient();
    await seedUser("account-one");

    const bucket = makeBucket();
    await runOffhostBackup(prisma, bucket, new Date());
    const good = await prisma.offhostBackupState.findUniqueOrThrow({
      where: { userId: "account-one" },
    });
    expect(good.lastSuccessAt).not.toBeNull();

    bucket.putStream = async () => {
      throw new Error("bucket refused the signature");
    };
    await runOffhostBackup(prisma, bucket, new Date());

    const after = await prisma.offhostBackupState.findUniqueOrThrow({
      where: { userId: "account-one" },
    });
    // The failed run moved the walk instant and nothing else: yesterday's
    // copy is still the copy this account has off-host.
    expect(after.lastSuccessAt?.getTime()).toBe(good.lastSuccessAt?.getTime());
    expect(after.sizeBytes).toBe(good.sizeBytes);
    expect(after.lastAttemptAt.getTime()).toBeGreaterThanOrEqual(
      good.lastAttemptAt.getTime(),
    );
  });

  it("goes with the account it describes", async () => {
    const prisma = getPrismaClient();
    await seedUser("account-one");
    await runOffhostBackup(prisma, makeBucket(), new Date());
    expect(await prisma.offhostBackupState.count()).toBe(1);

    await prisma.user.delete({ where: { id: "account-one" } });
    expect(await prisma.offhostBackupState.count()).toBe(0);
  });
});
