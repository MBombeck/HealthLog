/**
 * Fitbit token-management tests (mocked). Covers `getValidToken`:
 *   - the ROTATING refresh branch (classic Fitbit returns a fresh refresh token
 *     on every refresh; persist it, replacing the stored one);
 *   - the defensive keep-existing guard when a malformed response omits it;
 *   - the stored-token fast path when not near expiry;
 *   - a reauth failure recorded when credentials are missing on refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, refreshAccessTokenMock, recordSyncFailure } = vi.hoisted(
  () => ({
    prismaMock: {
      fitbitConnection: {
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      measurement: {
        findMany: vi.fn<(arg: Record<string, unknown>) => Promise<unknown[]>>(
          async () => [],
        ),
        createManyAndReturn: vi.fn(async (arg: Record<string, unknown>) =>
          (arg.data as Array<{ type: string; measuredAt: Date }>).map(
            (row, index) => ({ ...row, id: `inserted-${index}` }),
          ),
        ),
        update: vi.fn<(arg: Record<string, unknown>) => Promise<unknown>>(
          async () => ({}),
        ),
      },
    },
    refreshAccessTokenMock: vi.fn(),
    recordSyncFailure: vi.fn<(...a: unknown[]) => Promise<void>>(
      async () => {},
    ),
  }),
);

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (rows: Array<{ type: string; measuredAt: Date }>) =>
    rows,
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => ({ rowsUpserted: 0, durationMs: 0 })),
}));

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ""),
}));

vi.mock("../client", async (orig) => {
  const actual = await orig<typeof import("../client")>();
  return {
    ...actual,
    refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a),
  };
});

vi.mock("../credentials", () => ({
  getUserFitbitCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "csecret",
  })),
}));

vi.mock("@/lib/integrations/status", () => ({
  recordSyncFailure: (...a: unknown[]) => recordSyncFailure(...a),
}));

import {
  classificationToFailureKind,
  getValidToken,
  upsertFitbitMeasurements,
} from "../sync-core";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getValidToken — rotating refresh", () => {
  it("defensively KEEPS the stored refresh token when a malformed response omits one", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(old-access)",
      refreshToken: "enc(old-refresh)",
      // Expired so the refresh path fires.
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    // Classic Fitbit always rotates; a missing refresh_token is a malformed
    // reply. Guard it by keeping the existing token rather than writing a blank.
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      expires_in: 3600,
    });
    prismaMock.fitbitConnection.updateMany.mockResolvedValue({ count: 1 });

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("new-access");
    expect(refreshAccessTokenMock).toHaveBeenCalledWith("old-refresh", {
      clientId: "cid",
      clientSecret: "csecret",
    });
    const updateArg = prismaMock.fitbitConnection.updateMany.mock.calls[0]![0];
    expect(updateArg.data.accessToken).toBe("enc(new-access)");
    // The stored refresh token must NOT be wiped when the response omits one.
    expect(updateArg.data).not.toHaveProperty("refreshToken");
  });

  it("persists the ROTATED refresh token when the response carries a fresh one", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(old-access)",
      refreshToken: "enc(old-refresh)",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
    prismaMock.fitbitConnection.updateMany.mockResolvedValue({ count: 1 });

    await getValidToken("user1");

    const updateArg = prismaMock.fitbitConnection.updateMany.mock.calls[0]![0];
    // CAS guard scopes the write to the connection AND the spent ciphertext.
    expect(updateArg.where.id).toBe("conn1");
    expect(updateArg.where.refreshToken).toBe("enc(old-refresh)");
    expect(updateArg.data.accessToken).toBe("enc(new-access)");
    expect(updateArg.data.refreshToken).toBe("enc(rotated-refresh)");
  });

  it("reuses the peer's rotated token on a lost CAS race (no spurious reauth)", async () => {
    prismaMock.fitbitConnection.findUnique
      .mockResolvedValueOnce({
        id: "conn1",
        fitbitUserId: "abc123",
        accessToken: "enc(old-access)",
        refreshToken: "enc(old-refresh)",
        tokenExpiresAt: new Date(Date.now() - 1000),
      })
      .mockResolvedValueOnce({ accessToken: "enc(peer-access)" });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
    // A concurrent sync rotated first → zero rows match the CAS guard.
    prismaMock.fitbitConnection.updateMany.mockResolvedValue({ count: 0 });

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("peer-access");
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("returns the stored token without refresh when not near expiry", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("live-access");
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });

  it("returns null when there is no connection", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue(null);
    expect(await getValidToken("user1")).toBeNull();
  });

  it("records a reauth failure when credentials are missing on refresh", async () => {
    const { getUserFitbitCredentials } = await import("../credentials");
    (
      getUserFitbitCredentials as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(a)",
      refreshToken: "enc(r)",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });

    const result = await getValidToken("user1");

    expect(result).toBeNull();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "fitbit",
        kind: "reauth_required",
      }),
    );
  });

  it("records a classified failure and returns null when the refresh itself fails", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(a)",
      refreshToken: "enc(r)",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshAccessTokenMock.mockRejectedValue(
      new Error("Fitbit refreshAccessToken error: 401"),
    );

    const result = await getValidToken("user1");

    expect(result).toBeNull();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "fitbit",
        kind: "reauth_required",
      }),
    );
  });
});

describe("upsertFitbitMeasurements — batched write, tombstones resurrect", () => {
  it("inserts a fresh reading via createMany with field-by-field data, source pinned to FITBIT", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    prismaMock.measurement.findMany.mockResolvedValue([]); // nothing live yet

    const { imported } = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 80.5,
        unit: "kg",
        measuredAt,
        externalId: "2026-05-10T07:00:00.000Z:weight",
      },
    ]);

    expect(imported).toBe(1);
    expect(prismaMock.measurement.update).not.toHaveBeenCalled();

    // The probe matches EVERY FITBIT row for the batch's externalIds — live
    // AND tombstoned (the full unique index owns the key either way).
    const probeArg = prismaMock.measurement.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(probeArg.where).toMatchObject({
      userId: "user1",
      source: "FITBIT",
      externalId: { in: ["2026-05-10T07:00:00.000Z:weight"] },
    });
    expect(probeArg.where).not.toHaveProperty("deletedAt");

    const createArg = prismaMock.measurement.createManyAndReturn.mock
      .calls[0]![0] as {
      data: Record<string, unknown>[];
      skipDuplicates: boolean;
    };
    expect(createArg.skipDuplicates).toBe(true);
    expect(createArg.data[0]).toMatchObject({
      userId: "user1",
      type: "WEIGHT",
      source: "FITBIT",
      value: 80.5,
      unit: "kg",
      externalId: "2026-05-10T07:00:00.000Z:weight",
    });
  });

  it("overwrites a matched LIVE row in place via update and bumps syncVersion", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    // A re-fetched daily summary: the live row already exists.
    prismaMock.measurement.findMany.mockResolvedValue([
      { id: "m-live", type: "WEIGHT", externalId: "stats:weight:2026-05-10" },
    ]);

    const { imported } = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 79.9,
        unit: "kg",
        measuredAt,
        externalId: "stats:weight:2026-05-10",
      },
    ]);

    expect(imported).toBe(1);
    // No fresh insert — the live row was overwritten in place.
    expect(prismaMock.measurement.createManyAndReturn).not.toHaveBeenCalled();
    const updateArg = prismaMock.measurement.update.mock.calls[0]![0] as {
      where: { id: string };
      data: { value: number; syncVersion: unknown };
    };
    expect(updateArg.where).toEqual({ id: "m-live" });
    expect(updateArg.data.value).toBe(79.9);
    expect(updateArg.data.syncVersion).toEqual({ increment: 1 });
  });

  it("RESURRECTS a soft-deleted row — the probe matches the tombstone and the update clears deletedAt", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    // The tombstone still owns its key under the FULL unique index, so the
    // probe returns it; planning an insert instead would be dropped silently
    // by `skipDuplicates` and wedge the key forever.
    prismaMock.measurement.findMany.mockResolvedValue([
      { id: "m-dead", type: "WEIGHT", externalId: "stats:weight:2026-05-10" },
    ]);

    const { imported } = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 80.5,
        unit: "kg",
        measuredAt,
        externalId: "stats:weight:2026-05-10",
      },
    ]);

    expect(imported).toBe(1);
    expect(prismaMock.measurement.createManyAndReturn).not.toHaveBeenCalled();
    const updateArg = prismaMock.measurement.update.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArg.where).toEqual({ id: "m-dead" });
    expect(updateArg.data.deletedAt).toBeNull();
  });

  it("splits a mixed batch: matched-live → update, unmatched → createMany", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    prismaMock.measurement.findMany.mockResolvedValue([
      { id: "m-live", type: "WEIGHT", externalId: "live-key" },
    ]);

    const { imported } = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 1,
        unit: "kg",
        measuredAt,
        externalId: "live-key",
      },
      {
        type: "WEIGHT",
        value: 2,
        unit: "kg",
        measuredAt,
        externalId: "fresh-key",
      },
    ]);

    expect(imported).toBe(2);
    expect(prismaMock.measurement.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.measurement.update.mock.calls[0]![0]).toMatchObject({
      where: { id: "m-live" },
    });
    const createArg = prismaMock.measurement.createManyAndReturn.mock
      .calls[0]![0] as {
      data: Record<string, unknown>[];
    };
    expect(createArg.data).toHaveLength(1);
    expect(createArg.data[0]).toMatchObject({ externalId: "fresh-key" });
  });

  it("collapses a duplicate fresh key inside one batch to a single create (last-write-wins)", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    prismaMock.measurement.findMany.mockResolvedValue([]);

    await upsertFitbitMeasurements("user1", [
      { type: "WEIGHT", value: 1, unit: "kg", measuredAt, externalId: "dup" },
      { type: "WEIGHT", value: 9, unit: "kg", measuredAt, externalId: "dup" },
    ]);

    const createArg = prismaMock.measurement.createManyAndReturn.mock
      .calls[0]![0] as {
      data: Record<string, unknown>[];
    };
    expect(createArg.data).toHaveLength(1);
    // Last write wins.
    expect(createArg.data[0]!.value).toBe(9);
  });

  it("defers the rollup hook and returns touched keys when deferRollup is set", async () => {
    const { recomputeBucketsForMeasurement } =
      await import("@/lib/rollups/measurement-rollups");
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    prismaMock.measurement.findMany.mockResolvedValue([]);

    const { imported, touched } = await upsertFitbitMeasurements(
      "user1",
      [
        {
          type: "WEIGHT",
          value: 80.5,
          unit: "kg",
          measuredAt,
          externalId: "k1",
        },
      ],
      { deferRollup: true },
    );

    expect(imported).toBe(1);
    expect(touched).toEqual([{ type: "WEIGHT", measuredAt }]);
    // The inline per-day hook is skipped on the deferred (backfill) path.
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });

  it("returns 0 without touching prisma for an empty batch", async () => {
    const { imported } = await upsertFitbitMeasurements("user1", []);
    expect(imported).toBe(0);
    expect(prismaMock.measurement.findMany).not.toHaveBeenCalled();
    expect(prismaMock.measurement.createManyAndReturn).not.toHaveBeenCalled();
    expect(prismaMock.measurement.update).not.toHaveBeenCalled();
  });
});

describe("classificationToFailureKind", () => {
  it("maps each classification onto a FailureKind", () => {
    expect(classificationToFailureKind("reauth_required")).toBe(
      "reauth_required",
    );
    expect(classificationToFailureKind("persistent")).toBe("persistent");
    expect(classificationToFailureKind("transient")).toBe("transient");
    // A success has no failure kind; surface it as transient (contract-bug
    // anomaly is still recorded).
    expect(classificationToFailureKind("success")).toBe("transient");
  });
});
