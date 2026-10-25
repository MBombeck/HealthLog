/**
 * One account whose erasure throws must not hold up any other erasure, the
 * sweep of expired pre-wipe copies, or the off-host kick; and it goes behind
 * the other due accounts next time.
 *
 * Mutations that turn this red: rethrow a non-Guardian error from the loop
 * (b and c stay, the sweep never runs); move the sweep out of the `finally`;
 * drop the attempt marks or `orderInterruptedLast` (the failing account is
 * first again in the second run).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Attempt = {
  userId: string;
  pass: string;
  startedAt: Date;
  finishedAt: Date | null;
};

const state = vi.hoisted(() => ({
  due: [] as Array<{ id: string; managedProfileAt: Date | null }>,
  poison: new Set<string>(),
  refuse: new Set<string>(),
  attempted: [] as string[],
  erased: [] as string[],
  preWipeSweeps: 0,
  attempts: [] as Attempt[],
  workerErrors: [] as unknown[],
  notices: [] as Array<Record<string, unknown>>,
  audits: [] as Array<{ action: string; userId: string }>,
  clock: 0,
}));

vi.mock("@/lib/db", () => {
  const tick = () => new Date(1_000_000 + ++state.clock);
  return {
    prisma: {
      user: {
        findMany: vi.fn(async (args: { where?: { role?: string } }) =>
          args.where?.role ? [{ id: "admin" }] : state.due,
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          username: where.id,
          deletionRequestedAt: new Date(0),
        })),
      },
      auditLog: {
        count: vi.fn(
          async ({ where }: { where: { userId: string; action: string } }) =>
            state.audits.filter(
              (a) => a.userId === where.userId && a.action === where.action,
            ).length,
        ),
      },
      backupRestoreJob: { findMany: vi.fn(async () => []) },
      dataBackup: {
        deleteMany: vi.fn(async () => {
          state.preWipeSweeps++;
          return { count: 3 };
        }),
      },
      backupPassAttempt: {
        upsert: vi.fn(
          async ({ create }: { create: { userId: string; pass: string } }) => {
            const row = state.attempts.find(
              (a) => a.userId === create.userId && a.pass === create.pass,
            );
            if (row) row.startedAt = tick();
            else
              state.attempts.push({
                ...create,
                startedAt: tick(),
                finishedAt: null,
              });
          },
        ),
        updateMany: vi.fn(
          async ({ where }: { where: { userId: string; pass: string } }) => {
            for (const a of state.attempts) {
              if (a.userId === where.userId && a.pass === where.pass) {
                a.finishedAt = tick();
              }
            }
          },
        ),
        findMany: vi.fn(async ({ where }: { where: { pass: string } }) =>
          state.attempts.filter((a) => a.pass === where.pass),
        ),
      },
      $transaction: vi.fn(),
    },
  };
});
vi.mock("@/lib/managed-profiles/lifecycle", () => {
  class LastManagedGuardianError extends Error {}
  return {
    ACCOUNT_DELETION_TRANSACTION_OPTIONS: {},
    LastManagedGuardianError,
    withManagedProfileLock: vi.fn(),
    deleteGuardianAccountWithLifecycle: vi.fn(
      async (id: string, fn: (tx: unknown) => Promise<void>) => {
        state.attempted.push(id);
        if (state.poison.has(id)) {
          throw new Error(
            "Transaction already closed: timeout 120000ms exceeded",
          );
        }
        if (state.refuse.has(id)) throw new LastManagedGuardianError();
        await fn({});
      },
    ),
  };
});
vi.mock("@/lib/account-deletion/lifecycle", () => ({
  lockPendingAccount: vi.fn(async () => ({
    pending: true,
    purgeAt: new Date(0),
  })),
  eraseAccount: vi.fn(async (_tx: unknown, id: string) => {
    state.erased.push(id);
  }),
}));
vi.mock("@/lib/jobs/offhost-purge", () => ({ kickOffhostPurge: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn(async (action: string, opts: { userId: string }) => {
    state.audits.push({ action, userId: opts.userId });
  }),
}));
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(async (o: Record<string, unknown>) => {
    state.notices.push(o);
  }),
}));
vi.mock("@/lib/jobs/report-worker-error", () => ({
  reportWorkerError: vi.fn(async (_q: string, err: unknown) => {
    state.workerErrors.push(err);
  }),
}));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: (_n: string, f: (e: unknown) => unknown) =>
    f({ addMeta() {}, addWarning() {} }),
}));

const { processDueAccountDeletions, handleAccountDeletionPurge } =
  await import("@/lib/jobs/account-deletion-purge");
const { kickOffhostPurge } = await import("@/lib/jobs/offhost-purge");

const account = (id: string) => ({ id, managedProfileAt: null });

beforeEach(() => {
  state.due = [account("poison"), account("b"), account("c")];
  state.poison = new Set(["poison"]);
  state.refuse = new Set();
  state.attempted = [];
  state.erased = [];
  state.preWipeSweeps = 0;
  state.attempts = [];
  state.workerErrors = [];
  state.notices = [];
  state.audits = [];
  vi.mocked(kickOffhostPurge).mockClear();
});

describe("the account purge with one erasure that keeps failing", () => {
  it("erases every other due account, sweeps pre-wipe copies and kicks the off-host purge", async () => {
    const report = await processDueAccountDeletions(new Date());
    expect(state.erased).toEqual(["b", "c"]);
    expect(report).toMatchObject({ purged: 2, failed: 1, refused: 0 });
    expect(state.preWipeSweeps).toBe(1);
    expect(kickOffhostPurge).toHaveBeenCalledTimes(1);
  });

  it("takes the failing account after the others in the next run", async () => {
    await processDueAccountDeletions(new Date());
    state.due = [account("poison"), account("d")];
    state.attempted = [];
    await processDueAccountDeletions(new Date());
    expect(state.attempted).toEqual(["d", "poison"]);
  });

  it("puts refused accounts behind the others too, longest waiting first", async () => {
    state.poison = new Set();
    state.refuse = new Set(["r1", "r2"]);
    state.due = [account("r1"), account("r2")];
    await processDueAccountDeletions(new Date());
    state.due = [account("r1"), account("r2"), account("e")];
    state.attempted = [];
    await processDueAccountDeletions(new Date());
    expect(state.attempted).toEqual(["e", "r1", "r2"]);
  });

  it("sweeps pre-wipe copies even when the due accounts cannot be read", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.user.findMany).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    await expect(processDueAccountDeletions(new Date())).rejects.toThrow(
      /connection reset/,
    );
    expect(state.preWipeSweeps).toBe(1);
  });

  it("stops starting accounts when its budget is spent, and says how many it left", async () => {
    let calls = 0;
    const report = await processDueAccountDeletions(new Date(), {
      shouldStop: () => ++calls > 1,
    });
    expect(state.attempted).toEqual(["poison"]);
    expect(report.deferred).toBe(2);
    expect(state.preWipeSweeps).toBe(1);
  });

  it("reports the failure through the worker error path and tells the admins once", async () => {
    const outcome = await handleAccountDeletionPurge([]);
    expect(outcome).toMatchObject({ ok: true });
    expect(String(state.workerErrors[0])).toMatch(
      /1 account erasure\(s\) failed.*timeout 120000ms/,
    );
    expect(state.notices).toEqual([
      expect.objectContaining({
        userId: "admin",
        messageKey: "notifications.admin.accountErasureFailedBody",
        params: { username: "poison" },
      }),
    ]);
    await handleAccountDeletionPurge([]);
    expect(state.notices).toHaveLength(1);
  });
});
