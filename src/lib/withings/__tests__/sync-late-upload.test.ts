import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(),
      createManyAndReturn: vi.fn(),
      update: vi.fn(),
    },
    withingsConnection: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => v),
  encrypt: vi.fn((v: string) => v),
}));

vi.mock("../client", () => ({
  WITHINGS_MEASTYPES: [1, 9, 10, 11],
  fetchMeasurements: vi.fn(),
  subscribeWebhook: vi.fn(),
}));

vi.mock("../oauth", async (orig) => {
  const actual = await orig<typeof import("../oauth")>();
  return { ...actual, withingsOAuth: { refresh: vi.fn() } };
});

vi.mock("../credentials", () => ({
  getUserWithingsCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "secret",
  })),
}));

vi.mock("@/lib/integrations/status", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/integrations/status")
  >("@/lib/integrations/status");
  return {
    ...actual,
    isReauthRequired: vi.fn().mockResolvedValue(false),
    recordSyncFailure: vi.fn().mockResolvedValue(undefined),
    recordSyncSuccess: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForKeys: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
  invalidateUserMeasurements: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  })),
  annotate: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { fetchMeasurements } from "../client";

import { syncUserMeasurements } from "../sync";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(async (run) =>
    run(prisma as never),
  );
  // A live, non-expired connection so `getValidToken` returns the token
  // without touching the refresh path.
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
    id: "conn-1",
    withingsUserId: "wu-1",
    accessToken: "enc-access",
    refreshToken: "enc-refresh",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000),
  } as never);
  vi.mocked(prisma.withingsConnection.update).mockResolvedValue({} as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
  vi.mocked(prisma.measurement.createManyAndReturn).mockImplementation(
    (async (args: { data: Array<{ type: string; measuredAt: Date }> }) =>
      args.data.map((row, i) => ({
        id: `m-${i}`,
        type: row.type,
        measuredAt: row.measuredAt,
      }))) as never,
  );
  vi.mocked(prisma.measurement.update).mockResolvedValue({} as never);
});

/**
 * A reading taken on the device and uploaded to the Withings cloud hours later
 * (a Bluetooth cuff or a scale that syncs when the phone app opens) keeps its
 * original measure date. The watermark advances on wall-clock time, so the
 * incremental read must ask for what Withings received since the watermark
 * (`lastupdate`), not for what was measured since it (`startdate`).
 *
 * The mocked cloud answers the way `getmeas` documents it: `startdate`
 * filters on the measure date, `lastupdate` on the upload time.
 */
type CloudReading = {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  uploadedAt: Date;
};
let cloud: CloudReading[] = [];

function serveCloud() {
  vi.mocked(fetchMeasurements).mockImplementation((async (
    _token: string,
    startDate?: Date,
    _endDate?: Date,
    opts: { updatedSince?: Date } = {},
  ) =>
    cloud
      .filter((m) =>
        opts.updatedSince
          ? m.uploadedAt.getTime() > opts.updatedSince.getTime()
          : !startDate || m.measuredAt.getTime() >= startDate.getTime(),
      )
      .map(({ type, value, unit, measuredAt }) => ({
        type,
        value,
        unit,
        measuredAt,
        groupId: 1,
      }))) as never);
}

describe("Withings incremental sync and late uploads", () => {
  it("imports a reading measured before the watermark but uploaded after it", async () => {
    const takenAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    cloud = [
      {
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: takenAt,
        uploadedAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    ];
    serveCloud();

    // `beforeEach`: the last clean poll stamped lastSyncedAt one hour ago.
    const result = await syncUserMeasurements("user-1");

    expect(result).toEqual({ imported: 1, failed: false });
    const created = vi.mocked(prisma.measurement.createManyAndReturn).mock
      .calls[0]![0] as unknown as {
      data: Array<{ type: string; measuredAt: Date }>;
    };
    expect(created.data).toEqual([
      expect.objectContaining({ type: "WEIGHT", measuredAt: takenAt }),
    ]);
  });

  it("reads by upload time from the watermark minus the overlap", async () => {
    cloud = [];
    serveCloud();

    await syncUserMeasurements("user-1");

    const call = vi.mocked(fetchMeasurements).mock.calls[0]!;
    expect(call[1]).toBeUndefined();
    const opts = call[3] as { updatedSince?: Date };
    expect(opts.updatedSince).toBeInstanceOf(Date);
  });

  it("keeps the measure-date window for a full sync", async () => {
    cloud = [];
    serveCloud();

    await syncUserMeasurements("user-1", { fullSync: true });

    const call = vi.mocked(fetchMeasurements).mock.calls[0]!;
    expect(call[1]).toBeUndefined();
    expect((call[3] as { updatedSince?: Date }).updatedSince).toBeUndefined();
  });
});
