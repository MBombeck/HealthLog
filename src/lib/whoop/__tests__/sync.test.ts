/**
 * v1.11.0 — WHOOP sync layer tests (mocked). Covers:
 *   - the rotating refresh token persists BOTH new tokens;
 *   - an incremental recovery sync maps + upserts idempotently (a re-post with
 *     the same externalId routes through the upsert key, never a duplicate);
 *   - the incremental window helper picks the right overlap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────
const {
  prismaMock,
  refreshAccessTokenMock,
  fetchRecoveriesMock,
  recordSyncFailure,
  recordSyncSuccess,
  isReauthRequired,
  emitArrivalMock,
  reconcileMock,
  recomputeBucketsMock,
  invalidateStatusMock,
} = vi.hoisted(() => ({
  prismaMock: {
    whoopConnection: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
    measurement: {
      createManyAndReturn: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  refreshAccessTokenMock: vi.fn(),
  fetchRecoveriesMock: vi.fn(),
  recordSyncFailure: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  recordSyncSuccess: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  isReauthRequired: vi.fn<(...a: unknown[]) => Promise<boolean>>(
    async () => false,
  ),
  reconcileMock: vi.fn(),
  emitArrivalMock: vi.fn(),
  recomputeBucketsMock: vi.fn<(...a: unknown[]) => Promise<void>>(
    async () => {},
  ),
  invalidateStatusMock: vi.fn<(...a: unknown[]) => Promise<void>>(
    async () => {},
  ),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ""),
}));

vi.mock("../client", async (orig) => {
  const actual = await orig<typeof import("../client")>();
  return {
    ...actual,
    refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a),
    fetchRecoveries: (...a: unknown[]) => fetchRecoveriesMock(...a),
  };
});

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: reconcileMock,
  MeasurementReconciliationError: class extends Error {},
}));

vi.mock("../credentials", () => ({
  getUserWhoopCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "csecret",
  })),
}));

vi.mock("@/lib/integrations/status", () => ({
  recordSyncFailure: (...a: unknown[]) => recordSyncFailure(...a),
  recordSyncSuccess: (...a: unknown[]) => recordSyncSuccess(...a),
  isReauthRequired: (...a: unknown[]) => isReauthRequired(...a),
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (rows: Array<{ type: string; measuredAt: Date }>) =>
    rows.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
  recomputeBucketsForMeasurement: (...a: unknown[]) =>
    recomputeBucketsMock(...a),
}));

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: (...a: unknown[]) =>
    invalidateStatusMock(...a),
}));

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: emitArrivalMock,
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => null,
  annotate: () => {},
}));

import {
  getValidToken,
  incrementalStart,
  isCollectionForbidden,
  markResourceSynced,
  resolveResourceCursor,
  upsertWhoopMeasurements,
  WHOOP_DEFAULT_OVERLAP_MS,
  WHOOP_FULL_SYNC_ANCHOR,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
} from "../sync-core";
import { WhoopApiError } from "../response-classifier";
import { syncUserRecovery } from "../sync-recovery";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    async (run: (tx: unknown) => unknown) => run(prismaMock),
  );
  reconcileMock.mockImplementation(
    async (
      _tx: unknown,
      input: { type: string; measuredAt: Date; externalId: string },
    ) => ({
      status: "inserted",
      row: {
        id: `inserted:${input.externalId}`,
        type: input.type,
        measuredAt: input.measuredAt,
        externalId: input.externalId,
      },
    }),
  );
  isReauthRequired.mockResolvedValue(false);
  emitArrivalMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getValidToken — rotating refresh", () => {
  it("persists BOTH the new access AND refresh token on refresh", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(old-access)",
      refreshToken: "enc(old-refresh)",
      // Expired (past) so the refresh path fires.
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    prismaMock.whoopConnection.update.mockResolvedValue({});

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("new-access");
    expect(refreshAccessTokenMock).toHaveBeenCalledWith("old-refresh", {
      clientId: "cid",
      clientSecret: "csecret",
    });
    const updateArg = prismaMock.whoopConnection.update.mock.calls[0]![0];
    expect(updateArg.where.id).toBe("conn1");
    expect(updateArg.data.accessToken).toBe("enc(new-access)");
    expect(updateArg.data.refreshToken).toBe("enc(new-refresh)");
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("re-reads token state under an advisory lock and reuses a peer winner", async () => {
    prismaMock.whoopConnection.findUnique
      .mockResolvedValueOnce({
        id: "conn1",
        whoopUserId: "42",
        accessToken: "enc(old-access)",
        refreshToken: "enc(old-refresh)",
        tokenExpiresAt: new Date(Date.now() - 1000),
      })
      .mockResolvedValueOnce({
        id: "conn1",
        whoopUserId: "42",
        accessToken: "enc(winner-access)",
        refreshToken: "enc(winner-refresh)",
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("winner-access");
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxWait: expect.any(Number),
        timeout: expect.any(Number),
      }),
    );
  });

  it("returns the stored token without refresh when not near expiry", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("live-access");
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(prismaMock.whoopConnection.update).not.toHaveBeenCalled();
  });

  it("treats an ownership-loser connection with no WHOOP user id as unavailable", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: null,
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await expect(getValidToken("user1")).resolves.toBeNull();
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(prismaMock.whoopConnection.update).not.toHaveBeenCalled();
  });

  it("records a reauth failure when credentials are missing on refresh", async () => {
    const { getUserWhoopCredentials } = await import("../credentials");
    (getUserWhoopCredentials as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      null,
    );
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(a)",
      refreshToken: "enc(r)",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });

    const result = await getValidToken("user1");

    expect(result).toBeNull();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "whoop",
        kind: "reauth_required",
      }),
    );
  });
});

describe("incrementalStart", () => {
  it("anchors a full sync at the deep-history anchor, ignoring the cursor", () => {
    const got = incrementalStart(new Date("2026-06-01T12:00:00Z"), {
      fullSync: true,
    });
    expect(got).toEqual(WHOOP_FULL_SYNC_ANCHOR);
  });

  it("subtracts the overlap from lastSyncedAt", () => {
    const last = new Date("2026-06-01T12:00:00Z");
    const got = incrementalStart(last, {
      overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    });
    expect(got!.getTime()).toBe(
      last.getTime() - WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    );
  });

  it("defaults to the 1 h overlap when none supplied", () => {
    const last = new Date("2026-06-01T12:00:00Z");
    const got = incrementalStart(last);
    expect(got!.getTime()).toBe(last.getTime() - WHOOP_DEFAULT_OVERLAP_MS);
  });

  it("a fullSync reaches a span an incremental tick would skip", () => {
    // Incremental from a recent cursor only looks back the overlap (days); a
    // fullSync anchors years back, so it covers history the incremental misses.
    const recentCursor = new Date("2026-06-01T12:00:00Z");
    const incremental = incrementalStart(recentCursor, {
      overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    });
    const full = incrementalStart(recentCursor, { fullSync: true });
    const yearOld = new Date("2025-01-01T00:00:00Z");
    // A year-old record is BEFORE the incremental start (skipped) but AFTER
    // the full-sync anchor (covered).
    expect(yearOld.getTime()).toBeLessThan(incremental!.getTime());
    expect(yearOld.getTime()).toBeGreaterThan(full!.getTime());
  });
});

describe("resolveResourceCursor — per-resource cursor", () => {
  it("prefers the per-resource cursor over the shared lastSyncedAt", () => {
    const got = resolveResourceCursor(
      {
        resourceCursors: { workout: "2026-06-10T00:00:00.000Z" },
        lastSyncedAt: new Date("2026-06-12T00:00:00.000Z"),
      },
      "workout",
    );
    expect(got?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it("falls back to lastSyncedAt for a resource with no cursor key (legacy)", () => {
    const shared = new Date("2026-06-12T00:00:00.000Z");
    const got = resolveResourceCursor(
      {
        resourceCursors: { recovery: "2026-06-10T00:00:00.000Z" },
        lastSyncedAt: shared,
      },
      "workout",
    );
    expect(got).toEqual(shared);
  });

  it("falls back to lastSyncedAt when the column is null", () => {
    const shared = new Date("2026-06-12T00:00:00.000Z");
    expect(
      resolveResourceCursor(
        { resourceCursors: null, lastSyncedAt: shared },
        "sleep",
      ),
    ).toEqual(shared);
  });

  it("a stalled resource cursor does not advance with a sibling's", () => {
    // workout last synced a week ago; recovery synced an hour ago. Resolving
    // workout must still return the OLD workout cursor — a sibling's progress
    // never drags the stalled resource's window forward.
    const connection = {
      resourceCursors: {
        recovery: "2026-06-12T11:00:00.000Z",
        workout: "2026-06-05T12:00:00.000Z",
      },
      lastSyncedAt: new Date("2026-06-12T11:00:00.000Z"),
    };
    const workoutStart = incrementalStart(
      resolveResourceCursor(connection, "workout"),
      { overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS },
    );
    // Workout still re-fetches from a week-old cursor minus the overlap, NOT
    // from recovery's recent one — the late-synced workout stays in range.
    expect(workoutStart!.getTime()).toBe(
      new Date("2026-06-05T12:00:00.000Z").getTime() -
        WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    );
  });
});

describe("markResourceSynced — atomic, independent cursor advance", () => {
  it("issues ONE atomic jsonb_set upsert binding the resource key + instant", async () => {
    prismaMock.$executeRaw.mockResolvedValue(1);

    const at = new Date("2026-06-14T08:00:00.000Z");
    await markResourceSynced("user1", "workout", at);

    // A single atomic statement, never a read-then-write (which would race the
    // concurrent sibling resource queues).
    expect(prismaMock.whoopConnection.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.whoopConnection.update).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);

    const call = prismaMock.$executeRaw.mock.calls[0]!;
    const sql = (call[0] as TemplateStringsArray).join("?");
    const values = call.slice(1);
    // Merge-in-place + monotonic last_synced_at + scoped to the user.
    expect(sql).toContain("jsonb_set");
    expect(sql).toContain("GREATEST");
    // Resource key + ISO instant are parameter-bound, not spliced.
    expect(values).toContain("workout");
    expect(values).toContain(at.toISOString());
    expect(values).toContain(at);
    expect(values).toContain("user1");
  });

  it("refuses a resource outside the closed whitelist (no statement issued)", async () => {
    await markResourceSynced(
      "user1",
      "evil" as unknown as Parameters<typeof markResourceSynced>[1],
      new Date(),
    );
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("upsertWhoopMeasurements — exact insertion results", () => {
  const measuredAt = new Date("2026-06-01T08:00:00.000Z");
  const readings = [
    {
      type: "RECOVERY_SCORE" as const,
      value: 71,
      unit: "score",
      measuredAt,
      externalId: "sleep-uuid:recovery",
    },
    {
      type: "HRV_RMSSD" as const,
      value: 64,
      unit: "ms",
      measuredAt,
      externalId: "sleep-uuid:hrv_rmssd",
    },
  ];

  it("emits only rows returned by the insert statement and updates a raced duplicate", async () => {
    const inserted = {
      id: "new-1",
      type: "RECOVERY_SCORE",
      measuredAt,
      externalId: readings[0].externalId,
    };
    reconcileMock
      .mockResolvedValueOnce({ status: "inserted", row: inserted })
      .mockResolvedValueOnce({
        status: "updated",
        row: {
          id: "existing-2",
          type: "HRV_RMSSD",
          measuredAt,
          externalId: readings[1].externalId,
        },
      });
    const onInserted = vi.fn();

    expect(
      await upsertWhoopMeasurements("user1", readings, { onInserted }),
    ).toBe(2);

    expect(onInserted).toHaveBeenCalledWith([inserted]);
    expect(emitArrivalMock).toHaveBeenCalledWith("user1", [inserted], "whoop");
    expect(reconcileMock.mock.calls[1]![1]).toMatchObject({
      userId: "user1",
      type: "HRV_RMSSD",
      source: "WHOOP",
      externalId: readings[1].externalId,
    });
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxWait: expect.any(Number),
        timeout: expect.any(Number),
      }),
    );
  });

  it("does not pre-probe and still emits a genuine insert", async () => {
    prismaMock.measurement.findMany.mockRejectedValue(
      new Error("probe unavailable"),
    );
    const inserted = {
      id: "new-1",
      type: "RECOVERY_SCORE",
      measuredAt,
      externalId: readings[0].externalId,
    };
    reconcileMock.mockResolvedValueOnce({ status: "inserted", row: inserted });

    await upsertWhoopMeasurements("user1", [readings[0]]);

    expect(prismaMock.measurement.findMany).not.toHaveBeenCalled();
    expect(emitArrivalMock).toHaveBeenCalledWith("user1", [inserted], "whoop");
  });

  it("updates a re-post in place without reporting another insert", async () => {
    reconcileMock.mockResolvedValueOnce({
      status: "updated",
      row: {
        id: "existing-1",
        type: "RECOVERY_SCORE",
        measuredAt,
        externalId: readings[0].externalId,
      },
    });

    expect(await upsertWhoopMeasurements("user1", [readings[0]])).toBe(1);

    expect(emitArrivalMock).toHaveBeenCalledWith("user1", [], "whoop");
    expect(reconcileMock.mock.calls[0]![1]).toMatchObject({
      value: 71,
      externalId: readings[0].externalId,
    });
  });
});

describe("syncUserRecovery — durable cursor ordering", () => {
  const recovery = {
    cycle_id: 1,
    sleep_id: "sleep-uuid",
    user_id: 42,
    created_at: "2026-06-01T06:00:00.000Z",
    updated_at: "2026-06-01T07:00:00.000Z",
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: 66,
      resting_heart_rate: 52,
      hrv_rmssd_milli: 48.7,
      spo2_percentage: 97,
      skin_temp_celsius: 33.4,
    },
  };

  beforeEach(() => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastSyncedAt: new Date("2026-06-01T00:00:00Z"),
      resourceCursors: {
        recovery: "2026-06-01T00:00:00.000Z",
      },
    });
    fetchRecoveriesMock.mockResolvedValue([recovery]);
  });

  it("keeps the cursor unchanged when any represented measurement write fails", async () => {
    reconcileMock
      .mockResolvedValueOnce({
        status: "inserted",
        row: {
          id: "inserted:first",
          type: "RECOVERY_SCORE",
          measuredAt: new Date(recovery.updated_at),
          externalId: "sleep-uuid:recovery_score",
        },
      })
      .mockResolvedValueOnce({
        status: "failed",
        reason: "db_error",
        error: new Error("injected write failure"),
      });

    await expect(syncUserRecovery("user1")).rejects.toThrow();

    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("keeps earlier chunks durable and resumes without duplicate rows after a later chunk fails", async () => {
    const records = Array.from({ length: 21 }, (_, index) => ({
      ...recovery,
      cycle_id: index + 1,
      sleep_id: `sleep-${index.toString().padStart(2, "0")}`,
    }));
    fetchRecoveriesMock.mockResolvedValue(records);

    type StoredRow = {
      id: string;
      type: string;
      measuredAt: Date;
      externalId: string;
    };
    type TransactionState = { rows: Map<string, StoredRow> };

    let committedRows = new Map<string, StoredRow>();
    let committedInsertCount = 0;
    let failLaterChunk = true;

    prismaMock.$transaction.mockImplementation(
      async (run: (tx: TransactionState) => unknown) => {
        const stagedRows = new Map(committedRows);
        const result = await run({ rows: stagedRows });
        committedInsertCount += [...stagedRows.keys()].filter(
          (key) => !committedRows.has(key),
        ).length;
        committedRows = stagedRows;
        return result;
      },
    );
    reconcileMock.mockImplementation(
      async (
        tx: TransactionState,
        input: { type: string; measuredAt: Date; externalId: string },
      ) => {
        if (failLaterChunk && input.externalId === "sleep-20:recovery") {
          return {
            status: "failed",
            reason: "db_error",
            error: new Error("injected later-chunk failure"),
          };
        }

        const existing = tx.rows.get(input.externalId);
        const row = {
          id: existing?.id ?? `row:${input.externalId}`,
          type: input.type,
          measuredAt: input.measuredAt,
          externalId: input.externalId,
        };
        tx.rows.set(input.externalId, row);
        return { status: existing ? "updated" : "inserted", row };
      },
    );

    await expect(syncUserRecovery("user1")).rejects.toThrow();

    expect(committedRows.size).toBeGreaterThan(0);
    expect(committedRows.size).toBeLessThan(105);
    expect(prismaMock.$transaction.mock.calls.length).toBeGreaterThan(1);
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    expect(recomputeBucketsMock).toHaveBeenCalled();
    expect(invalidateStatusMock).toHaveBeenCalledTimes(1);

    failLaterChunk = false;
    await expect(syncUserRecovery("user1")).resolves.toBe(105);

    const expectedExternalIds = records.flatMap(({ sleep_id }) =>
      ["recovery", "hrv_rmssd", "rhr", "spo2", "skin_temp"].map(
        (fieldTag) => `${sleep_id}:${fieldTag}`,
      ),
    );
    const emittedExternalIds = emitArrivalMock.mock.calls.flatMap((call) =>
      (
        call[1] as Array<{
          externalId: string;
        }>
      ).map((row) => row.externalId),
    );

    expect(committedRows).toHaveLength(105);
    expect(committedInsertCount).toBe(105);
    expect([...committedRows.keys()]).toEqual(expectedExternalIds);
    expect(emittedExternalIds).toEqual(expectedExternalIds);
    expect(invalidateStatusMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("advances after success and replay updates identities without new arrivals", async () => {
    expect(await syncUserRecovery("user1")).toBe(5);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(
      async (run: (tx: unknown) => unknown) => run(prismaMock),
    );
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastSyncedAt: new Date("2026-06-01T00:00:00Z"),
      resourceCursors: {
        recovery: "2026-06-01T00:00:00.000Z",
      },
    });
    fetchRecoveriesMock.mockResolvedValue([recovery]);
    reconcileMock.mockImplementation(
      async (
        _tx: unknown,
        input: { type: string; measuredAt: Date; externalId: string },
      ) => ({
        status: "updated",
        row: {
          id: `existing:${input.externalId}`,
          type: input.type,
          measuredAt: input.measuredAt,
          externalId: input.externalId,
        },
      }),
    );

    expect(await syncUserRecovery("user1")).toBe(5);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(emitArrivalMock).toHaveBeenCalledWith("user1", [], "whoop");
  });
});

describe("isCollectionForbidden — tier degradation gate", () => {
  it("is true only for a WhoopApiError carrying HTTP 403", () => {
    const forbidden = new WhoopApiError({
      verb: "fetchRecoveries",
      classification: "reauth_required",
      httpStatus: 403,
      reason: "http_403",
    });
    expect(isCollectionForbidden(forbidden)).toBe(true);
  });

  it("is false for a 401 (genuine token reject → connection-wide reauth)", () => {
    const unauthorized = new WhoopApiError({
      verb: "fetchRecoveries",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "http_401",
    });
    expect(isCollectionForbidden(unauthorized)).toBe(false);
  });

  it("is false for a non-WhoopApiError", () => {
    expect(isCollectionForbidden(new Error("network down"))).toBe(false);
    expect(isCollectionForbidden("boom")).toBe(false);
  });
});

describe("per-resource 403 soft-skip vs reauth", () => {
  beforeEach(() => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastSyncedAt: new Date("2026-06-01T00:00:00Z"),
    });
    prismaMock.whoopConnection.update.mockResolvedValue({});
  });

  it("a collection 403 soft-skips: returns 0, records NO failure (connection stays connected)", async () => {
    fetchRecoveriesMock.mockRejectedValue(
      new WhoopApiError({
        verb: "fetchRecoveries",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );

    const imported = await syncUserRecovery("user1");

    expect(imported).toBe(0);
    // No failure recorded → recordSyncFailure never parks the row at
    // error_reauth, so the next syncUserWhoop does not short-circuit.
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("a collection 401 still records a reauth failure and rethrows", async () => {
    fetchRecoveriesMock.mockRejectedValue(
      new WhoopApiError({
        verb: "fetchRecoveries",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "http_401",
      }),
    );

    await expect(syncUserRecovery("user1")).rejects.toThrow();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "whoop",
        kind: "reauth_required",
      }),
    );
  });
});
