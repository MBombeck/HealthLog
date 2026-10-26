/**
 * The dump-retention signal through the real readiness reader against
 * Postgres: the reader asks the bucket's lifecycle rules for `database/` the
 * way the backups page does, only while a bucket is configured, and the model
 * turns a missing rule into attention.
 *
 * The bucket call itself is stubbed (`probeOffhostLifecycle`); the parsing of
 * the rules it returns is covered by the lifecycle unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseBackupHealth } from "@/lib/database-backup/health";
import type { OffhostLifecycle } from "@/lib/jobs/offhost-lifecycle";

const probe = vi.fn<() => Promise<OffhostLifecycle>>();

vi.mock("@/lib/jobs/offhost-backup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/offhost-backup")>()),
  probeOffhostLifecycle: () => probe(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { getPrismaClient, truncateAllTables } from "./setup";

const NOW = new Date();

/** A dump that went to the bucket an hour ago. */
const dumpGoingOffhost = async (): Promise<DatabaseBackupHealth> => ({
  enabled: true,
  directory: "/var/lib/healthlog/backups",
  keepNightly: 7,
  localDirWritable: true,
  localPersistent: true,
  localReason: "volume",
  offhostConfigured: true,
  lastGood: {
    at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    fileName: "healthlog-20261025T013000Z-daily.dump",
    sizeBytes: 1024,
    local: true,
    offhost: true,
  },
  lastFailure: null,
  offhost: {
    lastUploadAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    failure: null,
  },
});

function useBucket(): void {
  vi.stubEnv("BACKUP_S3_ENDPOINT", "https://bucket.invalid");
  vi.stubEnv("BACKUP_S3_BUCKET", "b");
  vi.stubEnv("BACKUP_S3_ACCESS_KEY", "a");
  vi.stubEnv("BACKUP_S3_SECRET_KEY", "s");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "e".repeat(64));
}

async function retentionSignal() {
  const { readRecoveryReadiness } = await import("@/lib/recovery/readiness");
  const readiness = await readRecoveryReadiness({
    now: NOW,
    dumpHealth: dumpGoingOffhost,
  });
  return {
    overall: readiness.state,
    signal: readiness.signals.find((s) => s.id === "dump_retention"),
  };
}

beforeEach(async () => {
  probe.mockReset();
  for (const name of [
    "BACKUP_S3_ENDPOINT",
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_ACCESS_KEY",
    "BACKUP_S3_SECRET_KEY",
    "BACKUP_ENCRYPTION_KEY",
  ]) {
    vi.stubEnv(name, "");
  }
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: "user-retention-admin",
      username: "retention-admin",
      role: "ADMIN",
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dump retention in the readiness verdict (real Postgres)", () => {
  it("calls a bucket with no rule for database/ attention", async () => {
    useBucket();
    probe.mockResolvedValue({
      state: "configured",
      expirationDays: 30,
      database: { state: "missing", expirationDays: null },
    });
    const { signal } = await retentionSignal();
    expect(signal).toMatchObject({
      state: "attention",
      reason: "missing",
      fixPath: "/admin/backups",
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("is ok with the rule's expiry once one covers database/", async () => {
    useBucket();
    probe.mockResolvedValue({
      state: "configured",
      expirationDays: 30,
      database: { state: "configured", expirationDays: 45 },
    });
    expect((await retentionSignal()).signal).toMatchObject({
      state: "ok",
      reason: "configured",
      params: { days: 45 },
    });
  });

  it("does not ask a bucket that is not configured", async () => {
    const { signal } = await retentionSignal();
    expect(signal).toMatchObject({
      state: "inactive",
      reason: "not_configured",
    });
    expect(probe).not.toHaveBeenCalled();
  });
});
