/**
 * Both transactions that end in `user.delete` carry the deletion budget.
 *
 * The cascade behind deleting an account row removes everything the account
 * owns, so on a large record it outlives Prisma's 5 s interactive default. The
 * transaction then rolled back and the person got a 500 with nothing deleted,
 * on every retry. Pinned at the call: a budget declared and not passed is the
 * failure this replaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { $transaction: transaction } }));
vi.mock("@/lib/jobs/offhost-purge", () => ({
  kickOffhostPurge: vi.fn(async () => undefined),
  requestOffhostPurge: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn(async () => undefined) }));

import {
  ACCOUNT_DELETION_TRANSACTION_OPTIONS,
  deleteGuardianAccountWithLifecycle,
  deleteManagedProfile,
} from "../lifecycle";
import { WIPE_TRANSACTION_TIMEOUT_MS } from "@/lib/data-wipe/wipe-plan";

/** A transaction client that holds no grants and one managed profile. */
function fakeTx() {
  return {
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    user: {
      findUnique: vi.fn(async () => ({
        id: "profile-1",
        managedProfileAt: new Date(),
      })),
      delete: vi.fn(async () => ({})),
    },
    accountGrant: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: "grant-1" })),
      count: vi.fn(async () => 2),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  transaction.mockReset();
  transaction.mockImplementation(
    async (run: (tx: ReturnType<typeof fakeTx>) => Promise<unknown>) =>
      run(fakeTx()),
  );
});

describe("account deletion transaction budget", () => {
  it("is well past Prisma's 5 s default and matches the wipe's", () => {
    expect(ACCOUNT_DELETION_TRANSACTION_OPTIONS.timeout).toBe(
      WIPE_TRANSACTION_TIMEOUT_MS,
    );
    expect(ACCOUNT_DELETION_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(5_000);
  });

  it("is passed by the guardian account deletion", async () => {
    await deleteGuardianAccountWithLifecycle("guardian-1", async () => "ok");
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][1]).toEqual(
      ACCOUNT_DELETION_TRANSACTION_OPTIONS,
    );
  });

  it("is passed by the managed profile deletion", async () => {
    // The immediate erasure: the transaction that ends in `user.delete`.
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "0");
    await deleteManagedProfile({
      profileId: "profile-1",
      guardianId: "guardian-1",
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][1]).toEqual(
      ACCOUNT_DELETION_TRANSACTION_OPTIONS,
    );
  });
});
