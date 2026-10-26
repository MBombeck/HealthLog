/**
 * Pins the dead-token verdict for WHOOP, the parity mirror of
 * `fitbit/__tests__/sync-dead-token.test.ts`.
 *
 * `getValidToken`'s three null-return paths (credentials missing, refresh
 * failure inside the advisory-lock transaction, and the in-lock vanished
 * connection) must register on the cycle's hard-fail ledger, and a cycle whose
 * token is dead must NOT stamp `recordSyncSuccess`. Otherwise every resource
 * returns 0 without failures, the cycle reads as clean, `recordSyncSuccess`
 * un-parks `error_reauth`, and the hourly cohort hammers the dead refresh token
 * forever while `lastSyncedAt` advances past real data.
 *
 * Includes the WHOOP-specific pin Fitbit has no twin for: the per-resource
 * driver `syncWhoopResourceWithStatus` (the dominant hourly-cron path) must
 * also refuse the success stamp when a hard failure is noted inside `run`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordSyncFailureMock,
  recordSyncSuccessMock,
  isReauthRequiredMock,
  prismaMock,
  getUserWhoopCredentialsMock,
  refreshAccessTokenMock,
  resourceFake,
} = vi.hoisted(() => ({
  recordSyncFailureMock: vi.fn(async () => {}),
  recordSyncSuccessMock: vi.fn(async () => {}),
  isReauthRequiredMock: vi.fn(async () => false),
  prismaMock: {
    whoopConnection: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(),
  },
  getUserWhoopCredentialsMock: vi.fn(async (): Promise<unknown> => null),
  refreshAccessTokenMock: vi.fn(),
  // The dead-token cycle test drives the real `syncUserWhoop`; each resource
  // module resolves the token first — exactly what the real leaves do — so the
  // ledger registration happens inside the cycle's ALS scope.
  resourceFake: async (userId: string): Promise<number> => {
    const { getValidToken } = await import("../sync-core");
    return (await getValidToken(userId)) ? 1 : 0;
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ""),
}));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: isReauthRequiredMock,
  recordSyncFailure: recordSyncFailureMock,
  recordSyncSuccess: recordSyncSuccessMock,
  isSyncFailureRecorded: () => false,
  markSyncFailureRecorded: <T>(err: T) => err,
}));
vi.mock("@/lib/integrations/oauth-refresh", () => ({
  acquireProviderTokenRefreshLock: vi.fn(async () => {}),
  PROVIDER_REFRESH_TRANSACTION_OPTIONS: { maxWait: 10_000, timeout: 60_000 },
}));
vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: vi.fn(),
  MeasurementReconciliationError: class extends Error {},
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn(async () => {}),
}));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => null,
  annotate: () => {},
}));
vi.mock("../credentials", () => ({
  getUserWhoopCredentials: getUserWhoopCredentialsMock,
}));
vi.mock("../oauth", async (orig) => {
  const actual = await orig<typeof import("../oauth")>();
  return {
    ...actual,
    whoopOAuth: { ...actual.whoopOAuth, refresh: refreshAccessTokenMock },
  };
});

// Each resource resolves the token first (the ledger-registration seam).
vi.mock("../sync-recovery", () => ({ syncUserRecovery: resourceFake }));
vi.mock("../sync-sleep", () => ({ syncUserSleep: resourceFake }));
vi.mock("../sync-cycle", () => ({ syncUserCycle: resourceFake }));
vi.mock("../sync-workout", () => ({ syncUserWorkout: resourceFake }));
vi.mock("../sync-body", () => ({ syncUserBody: resourceFake }));

import {
  WHOOP_TOKEN_HARD_FAIL,
  getValidToken,
  hardFailStorage,
  noteHardFailure,
  syncWhoopResourceWithStatus,
} from "../sync-core";
import { syncUserWhoop } from "../sync";
import { WhoopApiError } from "../response-classifier";

/** Run `fn` inside a fresh hard-fail ledger scope and return its failures. */
async function withLedger<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; failures: string[] }> {
  const tracker = { failures: [] as string[] };
  const result = await hardFailStorage.run(tracker, fn);
  return { result, failures: tracker.failures };
}

/** A connection whose access token is inside the 5-min refresh buffer. */
const EXPIRED_CONNECTION = {
  id: "conn-1",
  whoopUserId: "wu-1",
  accessToken: "enc(access)",
  refreshToken: "enc(refresh)",
  tokenExpiresAt: new Date(Date.now() - 60_000),
  lastSyncedAt: new Date("2026-07-01T00:00:00.000Z"),
};

const CREDS = { clientId: "id", clientSecret: "secret" };

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequiredMock.mockResolvedValue(false);
  prismaMock.whoopConnection.findUnique.mockReset();
  prismaMock.whoopConnection.update.mockReset().mockResolvedValue({});
  prismaMock.whoopConnection.updateMany
    .mockReset()
    .mockResolvedValue({ count: 1 });
  getUserWhoopCredentialsMock.mockReset().mockResolvedValue(null);
  refreshAccessTokenMock.mockReset();
  // The advisory-lock transaction runs its callback against the same mock.
  prismaMock.$transaction
    .mockReset()
    .mockImplementation(async (run: (tx: unknown) => unknown) =>
      run(prismaMock),
    );
});

describe("getValidToken — dead-token cycle verdict", () => {
  it("registers the credentials-missing path on the hard-fail ledger", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserWhoopCredentialsMock.mockResolvedValue(null);

    const { result, failures } = await withLedger(() =>
      getValidToken("user-1"),
    );

    expect(result).toBeNull();
    expect(failures).toEqual([WHOOP_TOKEN_HARD_FAIL]);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "whoop",
        kind: "reauth_required",
        errorCode: "credentials_missing",
      }),
    );
  });

  it("registers a refresh failure on the hard-fail ledger", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserWhoopCredentialsMock.mockResolvedValue(CREDS);
    refreshAccessTokenMock.mockRejectedValue(
      new WhoopApiError({
        verb: "refreshToken",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "invalid_grant",
      }),
    );

    const { result, failures } = await withLedger(() =>
      getValidToken("user-1"),
    );

    expect(result).toBeNull();
    expect(failures).toEqual([WHOOP_TOKEN_HARD_FAIL]);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "whoop",
        kind: "reauth_required",
      }),
    );
  });

  it("registers an in-lock vanished connection on the ledger", async () => {
    // The connection was deleted between the first read and the in-lock re-read
    // (disconnect / webhook race).
    prismaMock.whoopConnection.findUnique
      .mockResolvedValueOnce(EXPIRED_CONNECTION as never) // initial read
      .mockResolvedValueOnce(null as never); // in-lock re-read: row gone
    getUserWhoopCredentialsMock.mockResolvedValue(CREDS);

    const { result, failures } = await withLedger(() =>
      getValidToken("user-1"),
    );

    expect(result).toBeNull();
    expect(failures).toEqual([WHOOP_TOKEN_HARD_FAIL]);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  it("a successful refresh leaves the ledger empty", async () => {
    // Guard against over-failing: a healthy refresh must not touch the ledger.
    prismaMock.whoopConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserWhoopCredentialsMock.mockResolvedValue(CREDS);
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });

    const { result, failures } = await withLedger(() =>
      getValidToken("user-1"),
    );

    expect(result?.accessToken).toBe("new-access");
    expect(failures).toEqual([]);
  });
});

describe("syncUserWhoop — dead-token cycle refuses the success stamp", () => {
  it("a dead-token cycle returns { imported: 0, failed: true } and never stamps success", async () => {
    // Every resource resolves the token; the refresh fails each time — before
    // the ledger fix the cycle read as CLEAN (all resources returned 0 without
    // throwing), stamped success, and un-parked error_reauth.
    prismaMock.whoopConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserWhoopCredentialsMock.mockResolvedValue(CREDS);
    refreshAccessTokenMock.mockRejectedValue(
      new WhoopApiError({
        verb: "refreshToken",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "invalid_grant",
      }),
    );

    const res = await syncUserWhoop("user-1");

    expect(res).toEqual({ imported: 0, failed: true });
    expect(recordSyncSuccessMock).not.toHaveBeenCalled();
  });
});

describe("syncWhoopResourceWithStatus — dominant per-resource cron path", () => {
  it("does NOT stamp success when a hard failure is noted inside run", async () => {
    // The hourly-cron arm Fitbit has no twin for: a dead token noted by
    // `getValidToken` inside `run` must block the per-resource success stamp,
    // or the release is inert on the path that runs most often.
    const imported = await syncWhoopResourceWithStatus(
      "user-1",
      "recovery",
      async () => {
        noteHardFailure(WHOOP_TOKEN_HARD_FAIL);
        return 0;
      },
    );

    expect(imported).toBe(0);
    expect(recordSyncSuccessMock).not.toHaveBeenCalled();
  });

  it("stamps success on a clean per-resource run (no hard failure)", async () => {
    const imported = await syncWhoopResourceWithStatus(
      "user-1",
      "recovery",
      async () => 3,
    );

    expect(imported).toBe(3);
    expect(recordSyncSuccessMock).toHaveBeenCalledWith("user-1", "whoop", {
      leg: "recovery",
    });
  });
});
