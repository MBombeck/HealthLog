/**
 * The readiness read leaves accounts pending deletion out, as the weekly and
 * off-host passes do. Their copies stop on purpose; counted, one deletion
 * turned "weekly copy" failing and "off-host copies" stale, and every admin
 * was pushed about a backup that was not broken.
 */
import { describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-10T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const healthy = {
  createdAt: ago(400 * DAY),
  dataBackups: [{ createdAt: ago(2 * DAY) }],
  offhostBackupState: {
    lastAttemptAt: ago(0.4 * DAY),
    lastSuccessAt: ago(0.4 * DAY),
  },
};
// Pending deletion for ten days: both passes have skipped it since.
const pending = {
  createdAt: ago(400 * DAY),
  dataBackups: [{ createdAt: ago(15 * DAY) }],
  offhostBackupState: {
    lastAttemptAt: ago(10.4 * DAY),
    lastSuccessAt: ago(10.4 * DAY),
  },
  deletionRequestedAt: ago(10 * DAY),
};

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findFirst: vi.fn(async () => ({ createdAt: ago(400 * DAY) })),
      findMany: vi.fn(
        async (args: { where?: { deletionRequestedAt?: null } }) =>
          [healthy, pending].filter(
            (a) =>
              !(args.where && "deletionRequestedAt" in args.where) ||
              !("deletionRequestedAt" in a),
          ),
      ),
    },
    restoreDrillOutcome: { findUnique: vi.fn(async () => null) },
    recoveryReadinessNotice: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/jobs/offhost-backup", () => ({
  offhostBackupConfigured: () => true,
  probeOffhostLifecycle: async () => ({
    database: { state: "configured", expirationDays: 30 },
  }),
}));
vi.mock("@/lib/recovery/kit", () => ({
  readRecoveryKit: async () => ({
    confirmedAt: NOW.toISOString(),
    unconfirmed: [],
  }),
}));

const { readRecoveryReadiness } = await import("@/lib/recovery/readiness");

describe("readiness and accounts pending deletion", () => {
  it("judges the weekly and off-host copies of active accounts only", async () => {
    const r = await readRecoveryReadiness({
      now: NOW,
      dumpHealth: async () => null,
    });
    const byId = Object.fromEntries(
      r.signals.map((s) => [s.id, `${s.state}/${s.reason}`]),
    );
    expect(byId.weekly_copy).toMatch(/^ok\//);
    expect(byId.offhost_copies).toMatch(/^ok\//);
  });
});
