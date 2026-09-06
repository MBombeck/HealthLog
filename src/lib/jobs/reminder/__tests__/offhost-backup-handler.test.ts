/**
 * What the nightly off-host pass tells the queue about itself.
 *
 * The rule under test is the one the weekly in-database pass already carries:
 * a run that put nothing off-host protected nobody, and `ok: true` about that
 * is how a bucket stays empty while the jobs page reads healthy. Wrong
 * credentials, a bucket that does not exist and a target that refuses the
 * signature all fail every account rather than one, so they land in exactly
 * that arm — with the target's own sentence as the cause, not a stack.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runOffhostBackup: vi.fn(),
  getWorkerPrisma: vi.fn(() => ({})),
}));

vi.mock("@/lib/jobs/offhost-backup", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/jobs/offhost-backup")
  >("@/lib/jobs/offhost-backup");
  return {
    // The real error class, so the handler's `instanceof` arm is the one that
    // runs rather than a look-alike.
    OffhostBackupNotConfiguredError: actual.OffhostBackupNotConfiguredError,
    runOffhostBackup: mocks.runOffhostBackup,
  };
});

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: vi.fn(
    async (_name: string, run: (event: object) => Promise<unknown>) =>
      run({
        addMeta: vi.fn(),
        addWarning: vi.fn(),
        setBackground: vi.fn(),
        setError: vi.fn(),
      }),
  ),
}));

vi.mock("../shared", () => ({ getWorkerPrisma: mocks.getWorkerPrisma }));

import { OffhostBackupNotConfiguredError } from "@/lib/jobs/offhost-backup";
import { handleOffhostBackup } from "../backup-handlers";

function report(over: Partial<Record<string, unknown>> = {}) {
  return {
    config: { endpoint: "https://r2.example", bucket: "hl", region: "auto" },
    uploaded: 2,
    failed: 0,
    failures: [],
    totalUsers: 2,
    largestObjectBytes: 9_000,
    oversized: 0,
    ...over,
  };
}

describe("handleOffhostBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("succeeds when every account reached the bucket", async () => {
    mocks.runOffhostBackup.mockResolvedValue(report());
    const outcome = await handleOffhostBackup([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.did).toEqual({
      offhost_backup_uploaded: 2,
      offhost_backup_failed: 0,
      offhost_backup_total_users: 2,
      offhost_backup_oversized: 0,
    });
  });

  it("fails the run when no account could be uploaded", async () => {
    mocks.runOffhostBackup.mockResolvedValue(
      report({
        uploaded: 0,
        failed: 2,
        failures: [
          {
            userId: "u1",
            message:
              "The request signature we calculated does not match the signature you provided.",
          },
          { userId: "u2", message: "same" },
        ],
        largestObjectBytes: 0,
      }),
    );

    const outcome = await handleOffhostBackup([]);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("no account could be uploaded");
    // The target's own words, so an operator reads what to fix.
    expect(!outcome.ok && outcome.cause).toContain(
      "The request signature we calculated",
    );
    expect(!outcome.ok && outcome.did).toMatchObject({
      offhost_backup_uploaded: 0,
      offhost_backup_failed: 2,
    });
  });

  it("still succeeds when some account got a copy", async () => {
    mocks.runOffhostBackup.mockResolvedValue(
      report({
        uploaded: 1,
        failed: 1,
        failures: [{ userId: "u2", message: "db gone" }],
      }),
    );
    const outcome = await handleOffhostBackup([]);
    // Fanning the whole cohort out again over one object would re-upload
    // everybody's.
    expect(outcome.ok).toBe(true);
  });

  it("does not fail a host that has no accounts at all", async () => {
    mocks.runOffhostBackup.mockResolvedValue(
      report({ uploaded: 0, failed: 0, totalUsers: 0, largestObjectBytes: 0 }),
    );
    const outcome = await handleOffhostBackup([]);
    // Absence of work is not failure.
    expect(outcome.ok).toBe(true);
  });

  it("stays quiet on the self-hosts that never configured a bucket", async () => {
    mocks.runOffhostBackup.mockRejectedValue(
      new OffhostBackupNotConfiguredError("nope"),
    );
    const outcome = await handleOffhostBackup([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.did).toEqual({
      offhost_backup_configured: false,
    });
  });
});
