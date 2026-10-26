/**
 * Pins the dead-token verdict for Fitbit — the parity mirror of
 * `google-health/__tests__/sync-failsoft.test.ts`'s "getValidToken —
 * dead-token cycle verdict" block.
 *
 * `getValidToken`'s three null-return paths (credentials missing, refresh
 * failure, and the Fitbit-only vanished-connection CAS loss) must register on
 * the cycle's hard-fail ledger, and a cycle whose token is dead must NOT stamp
 * `markSynced` / `recordSyncSuccess`. Otherwise every resource returns 0
 * without failures, the cycle reads as clean, `recordSyncSuccess` un-parks
 * `error_reauth`, and the hourly cohort hammers the dead refresh token forever
 * while `lastSyncedAt` advances past real data.
 *
 * Fitbit has no one-shot leaf job, so no `runWith…HardFailLedger` wrapper is
 * ported; the tests scope the ledger through the exported `hardFailStorage.run`
 * directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordSyncFailureMock,
  recordSyncSuccessMock,
  prismaMock,
  getUserFitbitCredentialsMock,
  refreshAccessTokenMock,
  resourceFake,
} = vi.hoisted(() => ({
  recordSyncFailureMock: vi.fn(async () => {}),
  recordSyncSuccessMock: vi.fn(async () => {}),
  prismaMock: {
    fitbitConnection: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  },
  getUserFitbitCredentialsMock: vi.fn(async (): Promise<unknown> => null),
  refreshAccessTokenMock: vi.fn(),
  // The dead-token cycle test drives the real `syncUserFitbit`; each resource
  // module is mocked to do exactly what the real ones do first — resolve the
  // token — so the ledger registration happens inside the cycle's ALS scope.
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
  isReauthRequired: vi.fn(async () => false),
  recordSyncFailure: recordSyncFailureMock,
  recordSyncSuccess: recordSyncSuccessMock,
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => null,
  annotate: () => {},
}));
vi.mock("../credentials", () => ({
  getUserFitbitCredentials: getUserFitbitCredentialsMock,
}));
vi.mock("../oauth", () => ({
  fitbitOAuth: { refresh: refreshAccessTokenMock },
}));

vi.mock("../sync-metrics", () => ({ syncUserMetrics: resourceFake }));
vi.mock("../sync-activity", () => ({ syncUserActivity: resourceFake }));
vi.mock("../sync-sleep", () => ({ syncUserSleep: resourceFake }));
vi.mock("../sync-workout", () => ({ syncUserWorkout: resourceFake }));

import {
  FITBIT_TOKEN_HARD_FAIL,
  getValidToken,
  hardFailStorage,
} from "../sync-core";
import { syncUserFitbit } from "../sync";
import { FitbitApiError } from "../response-classifier";

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
  userId: "user-1",
  fitbitUserId: "fb-user-1",
  accessToken: "enc(access)",
  refreshToken: "enc(refresh)",
  tokenExpiresAt: new Date(Date.now() - 60_000),
  lastSyncedAt: new Date("2026-07-01T00:00:00.000Z"),
};

const CREDS = { clientId: "id", clientSecret: "secret" };

beforeEach(() => {
  recordSyncFailureMock.mockClear();
  recordSyncSuccessMock.mockClear();
  prismaMock.fitbitConnection.findUnique.mockReset();
  prismaMock.fitbitConnection.update.mockReset().mockResolvedValue({} as never);
  prismaMock.fitbitConnection.updateMany
    .mockReset()
    .mockResolvedValue({ count: 1 } as never);
  getUserFitbitCredentialsMock.mockReset().mockResolvedValue(null);
  refreshAccessTokenMock.mockReset();
});

describe("getValidToken — dead-token cycle verdict", () => {
  it("registers the credentials-missing path on the hard-fail ledger", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );

    const { result, failures } = await withLedger(() =>
      getValidToken("user-1"),
    );

    expect(result).toBeNull();
    expect(failures).toEqual([FITBIT_TOKEN_HARD_FAIL]);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "fitbit",
        kind: "reauth_required",
        errorCode: "credentials_missing",
      }),
    );
  });

  it("registers a refresh failure on the hard-fail ledger", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserFitbitCredentialsMock.mockResolvedValue(CREDS);
    refreshAccessTokenMock.mockRejectedValue(
      new FitbitApiError({
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
    expect(failures).toEqual([FITBIT_TOKEN_HARD_FAIL]);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reauth_required" }),
    );
  });

  it("registers a vanished-connection CAS loss on the ledger", async () => {
    // Fitbit-only path (no Google twin): the CAS update touches zero rows AND
    // the peer re-read finds no row — the connection was deleted mid-flight.
    prismaMock.fitbitConnection.findUnique
      .mockResolvedValueOnce(EXPIRED_CONNECTION as never) // initial read
      .mockResolvedValueOnce(null as never); // peer re-read: row gone
    getUserFitbitCredentialsMock.mockResolvedValue(CREDS);
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
    prismaMock.fitbitConnection.updateMany.mockResolvedValue({
      count: 0,
    } as never);

    const { result, failures } = await withLedger(() =>
      getValidToken("user-1"),
    );

    expect(result).toBeNull();
    expect(failures).toEqual([FITBIT_TOKEN_HARD_FAIL]);
  });

  it("a successful refresh leaves the ledger empty", async () => {
    // Guard against over-failing: a healthy refresh must not touch the ledger.
    prismaMock.fitbitConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserFitbitCredentialsMock.mockResolvedValue(CREDS);
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
    prismaMock.fitbitConnection.updateMany.mockResolvedValue({
      count: 1,
    } as never);

    const { result, failures } = await withLedger(() =>
      getValidToken("user-1"),
    );

    expect(result?.accessToken).toBe("new-access");
    expect(failures).toEqual([]);
  });

  it("a dead-token cycle fails the verdict and never stamps markSynced / recordSyncSuccess", async () => {
    // Every resource resolves the token, the refresh fails each time — before
    // the ledger registration the cycle read as CLEAN (all resources returned
    // 0 without failures), stamped the watermark, and un-parked error_reauth.
    prismaMock.fitbitConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserFitbitCredentialsMock.mockResolvedValue(CREDS);
    refreshAccessTokenMock.mockRejectedValue(
      new FitbitApiError({
        verb: "refreshToken",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "invalid_grant",
      }),
    );

    const res = await syncUserFitbit("user-1");

    expect(res).toEqual({ imported: 0, failed: true });
    expect(recordSyncSuccessMock).not.toHaveBeenCalled();
    // No connection write may carry the watermark stamp.
    for (const call of prismaMock.fitbitConnection.update.mock.calls) {
      const arg = (call as unknown[])[0] as { data: Record<string, unknown> };
      expect(arg.data).not.toHaveProperty("lastSyncedAt");
    }
  });
});
