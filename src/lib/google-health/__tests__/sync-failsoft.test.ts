/**
 * Pins the fail-soft contract of `handleCollectionFetchError`: a hard failure
 * (anything but the per-class 403 soft-skip) records the classified sync
 * failure and RETURNS — it must not rethrow, because every call site sits in a
 * per-collection catch and a rethrow would abort the sibling collections
 * (live: steps 400ing suppressed distance / floors / active-energy entirely).
 *
 * Also pins the dead-token verdict: `getValidToken`'s failure paths
 * (credentials missing, refresh failure) must register on the cycle's
 * hard-fail ledger, and a cycle whose token is dead must NOT stamp
 * `markSynced` / `recordSyncSuccess` — otherwise every resource returns 0
 * without failures, the cycle reads as clean, `recordSyncSuccess` un-parks
 * `error_reauth`, and the hourly cohort hammers the dead refresh token forever
 * while `lastSyncedAt` advances past real data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordSyncFailureMock,
  recordSyncSuccessMock,
  prismaMock,
  getUserGoogleHealthCredentialsMock,
  refreshAccessTokenMock,
  resourceFake,
} = vi.hoisted(() => ({
  recordSyncFailureMock: vi.fn(async () => {}),
  recordSyncSuccessMock: vi.fn(async () => {}),
  prismaMock: {
    googleHealthConnection: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
  },
  getUserGoogleHealthCredentialsMock: vi.fn(async (): Promise<unknown> => null),
  refreshAccessTokenMock: vi.fn(),
  // The dead-token cycle test drives the real `syncUserGoogleHealth`; each
  // resource module is mocked to do exactly what the real ones do first —
  // resolve the token — so the ledger registration happens inside the cycle's
  // ALS scope.
  resourceFake: async (userId: string): Promise<number> => {
    const { getValidToken } = await import("../sync-core");
    return (await getValidToken(userId)) ? 1 : 0;
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
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
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("../credentials", () => ({
  getUserGoogleHealthCredentials: getUserGoogleHealthCredentialsMock,
}));
vi.mock("../client", () => ({ refreshAccessToken: refreshAccessTokenMock }));

vi.mock("../sync-metrics", () => ({ syncUserMetrics: resourceFake }));
vi.mock("../sync-activity", () => ({ syncUserActivity: resourceFake }));
vi.mock("../sync-sleep", () => ({ syncUserSleep: resourceFake }));
vi.mock("../sync-workout", () => ({ syncUserWorkout: resourceFake }));

import {
  GOOGLE_HEALTH_TOKEN_HARD_FAIL,
  getValidToken,
  handleCollectionFetchError,
  runWithGoogleHealthHardFailLedger,
} from "../sync-core";
import { syncUserGoogleHealth } from "../sync";
import { GoogleHealthApiError } from "../response-classifier";

/** A connection whose access token is inside the 5-min refresh buffer. */
const EXPIRED_CONNECTION = {
  id: "conn-1",
  userId: "user-1",
  googleUserId: "g-user-1",
  accessToken: "enc-access",
  refreshToken: "enc-refresh",
  tokenExpiresAt: new Date(Date.now() - 60_000),
  lastSyncedAt: new Date("2026-07-01T00:00:00.000Z"),
};

beforeEach(() => {
  recordSyncFailureMock.mockClear();
  recordSyncSuccessMock.mockClear();
  prismaMock.googleHealthConnection.findUnique.mockReset();
  prismaMock.googleHealthConnection.update
    .mockReset()
    .mockResolvedValue({} as never);
  getUserGoogleHealthCredentialsMock.mockReset().mockResolvedValue(null);
  refreshAccessTokenMock.mockReset();
});

describe("handleCollectionFetchError — fail-soft grouping", () => {
  it("soft-skips a per-class 403 without recording a failure", async () => {
    const err = new GoogleHealthApiError({
      verb: "fetchSteps",
      classification: "reauth_required",
      httpStatus: 403,
      reason: "HTTP 403",
    });
    await expect(
      handleCollectionFetchError("fetchSteps", "user-1", err),
    ).resolves.toBe(0);
    expect(recordSyncFailureMock).not.toHaveBeenCalled();
  });

  it("records a 400 as a persistent failure and returns instead of rethrowing", async () => {
    const err = new GoogleHealthApiError({
      verb: "fetchSteps",
      classification: "persistent",
      httpStatus: 400,
      reason: "HTTP 400",
      upstreamError: "INVALID_ARGUMENT: Invalid argument in request.",
    });
    await expect(
      handleCollectionFetchError("fetchSteps", "user-1", err),
    ).resolves.toBe(0);
    expect(recordSyncFailureMock).toHaveBeenCalledTimes(1);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "google-health",
        kind: "persistent",
        errorCode: "400",
      }),
    );
  });

  it("records a transient failure (5xx) and returns as well", async () => {
    const err = new GoogleHealthApiError({
      verb: "fetchDistance",
      classification: "transient",
      httpStatus: 503,
      reason: "HTTP 503",
    });
    await expect(
      handleCollectionFetchError("fetchDistance", "user-1", err),
    ).resolves.toBe(0);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "transient" }),
    );
  });
});

describe("getValidToken — dead-token cycle verdict", () => {
  it("registers the credentials-missing path on the hard-fail ledger", async () => {
    prismaMock.googleHealthConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );

    const { result, failures } = await runWithGoogleHealthHardFailLedger(() =>
      getValidToken("user-1"),
    );

    expect(result).toBeNull();
    expect(failures).toEqual([GOOGLE_HEALTH_TOKEN_HARD_FAIL]);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "google-health",
        kind: "reauth_required",
        errorCode: "credentials_missing",
      }),
    );
  });

  it("registers a refresh failure on the hard-fail ledger", async () => {
    prismaMock.googleHealthConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserGoogleHealthCredentialsMock.mockResolvedValue({
      clientId: "id",
      clientSecret: "secret",
    });
    refreshAccessTokenMock.mockRejectedValue(
      new GoogleHealthApiError({
        verb: "refreshToken",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "invalid_grant",
      }),
    );

    const { result, failures } = await runWithGoogleHealthHardFailLedger(() =>
      getValidToken("user-1"),
    );

    expect(result).toBeNull();
    expect(failures).toEqual([GOOGLE_HEALTH_TOKEN_HARD_FAIL]);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reauth_required" }),
    );
  });

  it("a dead-token cycle fails the verdict and never stamps markSynced / recordSyncSuccess", async () => {
    // Every resource resolves the token, the refresh fails each time — before
    // the ledger registration the cycle read as CLEAN (all resources returned
    // 0 without failures), stamped the watermark, and un-parked error_reauth.
    prismaMock.googleHealthConnection.findUnique.mockResolvedValue(
      EXPIRED_CONNECTION as never,
    );
    getUserGoogleHealthCredentialsMock.mockResolvedValue({
      clientId: "id",
      clientSecret: "secret",
    });
    refreshAccessTokenMock.mockRejectedValue(
      new GoogleHealthApiError({
        verb: "refreshToken",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "invalid_grant",
      }),
    );

    const res = await syncUserGoogleHealth("user-1");

    expect(res).toEqual({ imported: 0, failed: true });
    expect(recordSyncSuccessMock).not.toHaveBeenCalled();
    // No connection write may carry the watermark stamp.
    for (const call of prismaMock.googleHealthConnection.update.mock.calls) {
      const arg = (call as unknown[])[0] as { data: Record<string, unknown> };
      expect(arg.data).not.toHaveProperty("lastSyncedAt");
    }
  });
});
