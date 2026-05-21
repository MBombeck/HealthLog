/**
 * v1.4.43 W7-B3 — typed-classification regression suite.
 *
 * Pins that both `syncUserActivity` and `syncUserSleep` route their
 * catch-block through `recordWithingsSyncFailure` (the shared helper in
 * sync.ts that consumes the typed `WithingsApiError.classification`)
 * rather than the legacy `extractWithingsStatus` /
 * `isWithingsRefreshReauthFailure` regex chain.
 *
 * Regression target: pre-v1.4.43, both sync paths re-parsed the error
 * message to infer reauth-vs-transient. Any future migration that
 * accidentally falls back to the regex (e.g. a refactor that drops the
 * `recordWithingsSyncFailure` import) silently regresses the
 * classification taxonomy — the typed path picks up rate-limit (601)
 * and quota (293) verdicts the regex never modelled.
 *
 * Strategy: spy on `recordSyncFailure` (the underlying integration
 * status writer) and assert the recorded `kind` matches the typed
 * classification — `transient` for a fetch-layer 5xx that comes through
 * as a `WithingsApiError`, `persistent` for a body-status 293, and
 * `reauth_required` for the BL-P3-2 403 short-circuit. If a future
 * refactor drops the `WithingsApiError` propagation, this test fails on
 * the 293 path (the legacy regex would map 293 to `transient`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    withingsConnection: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn().mockResolvedValue(false),
  parkIntegrationAtReauth: vi.fn(),
  recordSyncFailure: vi.fn(),
  recordSyncSuccess: vi.fn(),
}));

vi.mock("../sync", async () => {
  const actual = await vi.importActual<typeof import("../sync")>("../sync");
  return {
    ...actual,
    getValidToken: vi.fn(async () => ({
      accessToken: "token",
      connection: { id: "conn-1", withingsUserId: "wu-1" },
    })),
  };
});

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  };
});

import { prisma } from "@/lib/db";
import { recordSyncFailure } from "@/lib/integrations/status";

import { syncUserActivity } from "../sync-activity";
import { syncUserSleep } from "../sync-sleep";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
    scope: "user.metrics,user.activity",
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncUserActivity — typed-classification catch (v1.4.43 W7-B3)", () => {
  it("records a body-status 293 (persistent contract mismatch) with kind=persistent", async () => {
    // The legacy regex chain bucketed 293 as `transient` because
    // `isWithingsRefreshReauthFailure` only matched 100/101/102 +
    // 200..299. The typed classifier in response-classifier.ts moves
    // 293 into PERSISTENT_CODES — pinning that the typed path is
    // reached.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 293, error: "invalid params" }),
      })),
    );

    await expect(syncUserActivity("user-1")).rejects.toThrow(
      /Withings activity error: 293/,
    );
    expect(recordSyncFailure).toHaveBeenCalledTimes(1);
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "withings",
        kind: "persistent",
        errorCode: "293",
      }),
    );
  });

  it("records a body-status 601 (rate-limited) with kind=transient", async () => {
    // The regex chain treated 601 identically to "no status info" —
    // also `transient` by default. We pin the verdict so a future
    // typo in the classifier table doesn't silently turn rate-limit
    // bursts into persistent / reauth.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 601, error: "rate limit" }),
      })),
    );

    await expect(syncUserActivity("user-1")).rejects.toThrow(
      /Withings activity error: 601/,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "transient",
        errorCode: "601",
      }),
    );
  });

  it("records a body-status 100 (auth failed) with kind=reauth_required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 100, error: "auth failed" }),
      })),
    );

    await expect(syncUserActivity("user-1")).rejects.toThrow(
      /Withings activity error: 100/,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reauth_required",
        errorCode: "100",
      }),
    );
  });
});

describe("syncUserSleep — typed-classification catch (v1.4.43 W7-B3)", () => {
  it("records a body-status 293 with kind=persistent (same typed path as activity)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 293, error: "invalid params" }),
      })),
    );

    await expect(syncUserSleep("user-1")).rejects.toThrow(
      /Withings sleep error: 293/,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "withings",
        kind: "persistent",
        errorCode: "293",
      }),
    );
  });

  it("records a body-status 601 with kind=transient", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 601, error: "rate limit" }),
      })),
    );

    await expect(syncUserSleep("user-1")).rejects.toThrow(
      /Withings sleep error: 601/,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "transient",
        errorCode: "601",
      }),
    );
  });

  it("records a body-status 102 with kind=reauth_required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 102, error: "user does not exist" }),
      })),
    );

    await expect(syncUserSleep("user-1")).rejects.toThrow(
      /Withings sleep error: 102/,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reauth_required",
        errorCode: "102",
      }),
    );
  });
});
