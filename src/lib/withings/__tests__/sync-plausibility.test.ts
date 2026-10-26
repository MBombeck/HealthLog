/**
 * Withings writes the measurement table directly — the measures leg row by
 * row, the activity leg as a planned batch — so neither inherits the shared
 * reconciler's gate. These cases pin that both legs now clear the app's own
 * declared plausibility band before anything reaches Prisma, and that a
 * refusal lands on the wide event rather than vanishing.
 *
 * The measures leg matters twice over: it does not only insert, it OVERWRITES
 * the stored value of an existing slot, so an ungated impossible reading could
 * replace a real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      createManyAndReturn: vi.fn(),
      update: vi.fn(),
    },
    withingsConnection: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn((ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(),
    ),
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => v),
  encrypt: vi.fn((v: string) => v),
}));

vi.mock("../client", async () => {
  const actual = await vi.importActual<typeof import("../client")>("../client");
  return {
    ...actual,
    fetchMeasurements: vi.fn(),
    subscribeWebhook: vi.fn(),
  };
});
vi.mock("../oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oauth")>();
  return {
    ...actual,
    withingsOAuth: { ...actual.withingsOAuth, refresh: vi.fn() },
  };
});

vi.mock("../credentials", () => ({
  getUserWithingsCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "secret",
  })),
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn().mockResolvedValue(false),
  parkIntegrationAtReauth: vi.fn(),
  recordSyncFailure: vi.fn().mockResolvedValue(undefined),
  recordSyncSuccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
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

import { prisma } from "@/lib/db";
import { eventStorage } from "@/lib/logging/context";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { RANGE_REJECTED_META_KEY } from "@/lib/measurements/plausibility-gate";
import type { RangeRejectionTally } from "@/lib/measurements/plausibility-gate";

import { fetchMeasurements } from "../client";
import { syncUserActivity } from "../sync-activity";
import { syncUserMeasurements } from "../sync";

let event: WideEventBuilder;

function tally(): RangeRejectionTally | undefined {
  return event.toJSON().meta?.[RANGE_REJECTED_META_KEY] as
    RangeRejectionTally | undefined;
}

function installActivityFetch(
  entries: Array<{ date: string; steps?: number; distance?: number }>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      json: async () => ({
        status: 0,
        body: { activities: entries, more: false, offset: 0 },
      }),
    })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  event = new WideEventBuilder("background");
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
    id: "conn-1",
    withingsUserId: "wu-1",
    accessToken: "enc-access",
    refreshToken: "enc-refresh",
    scope: "user.metrics,user.activity",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000),
  } as never);
  vi.mocked(prisma.withingsConnection.update).mockResolvedValue({} as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.createManyAndReturn).mockImplementation(
    (async (args: { data: Array<{ type: string; measuredAt: Date }> }) =>
      args.data.map((d, i) => ({
        id: `m-${i}`,
        type: d.type,
        measuredAt: d.measuredAt,
      }))) as never,
  );
  vi.mocked(prisma.measurement.createMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(prisma.measurement.update).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncUserMeasurements — plausibility gate", () => {
  it("writes a reading inside the metric's declared band", async () => {
    vi.mocked(fetchMeasurements).mockResolvedValue([
      {
        type: "PULSE",
        value: 112,
        measuredAt: new Date("2026-05-16T08:00:00Z"),
      },
    ] as never);

    const result = await eventStorage.run(event, () =>
      syncUserMeasurements("user-1"),
    );

    expect(result).toEqual({ imported: 1, failed: false });
    expect(prisma.measurement.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(prisma.measurement.createManyAndReturn).mock.calls[0]?.[0]
        ?.data,
    ).toHaveLength(1);
    expect(tally()).toBeUndefined();
  });

  it("refuses an out-of-band reading and annotates the drop", async () => {
    vi.mocked(fetchMeasurements).mockResolvedValue([
      {
        type: "PULSE",
        value: 112,
        measuredAt: new Date("2026-05-16T08:00:00Z"),
      },
      {
        type: "PULSE",
        value: 55643821.505,
        measuredAt: new Date("2026-05-16T08:05:00Z"),
      },
    ] as never);

    const result = await eventStorage.run(event, () =>
      syncUserMeasurements("user-1"),
    );

    // Only the real reading landed, and the run is still a clean success: one
    // impossible sample must not strand the rest behind a held watermark.
    expect(result).toEqual({ imported: 1, failed: false });
    expect(prisma.measurement.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(prisma.measurement.createManyAndReturn).mock.calls[0]?.[0]
        ?.data,
    ).toHaveLength(1);
    expect(tally()).toEqual({
      total: 1,
      buckets: [
        { source: "withings", type: "PULSE", direction: "above_max", count: 1 },
      ],
    });
    expect(event.getLevel()).toBe("warn");
  });

  it("does not overwrite a stored reading with an out-of-band one", async () => {
    // The slot already holds a real pulse; the provider re-sends the same
    // instant carrying a decode slip. Ungated, the update branch rewrote the
    // good value with the bad one.
    vi.mocked(prisma.measurement.findMany).mockResolvedValueOnce([
      {
        id: "existing-row",
        type: "PULSE",
        measuredAt: new Date("2026-05-16T08:00:00Z"),
        value: 61,
        deletedAt: null,
      },
    ] as never);
    vi.mocked(fetchMeasurements).mockResolvedValue([
      {
        type: "PULSE",
        value: 55643821.505,
        measuredAt: new Date("2026-05-16T08:00:00Z"),
      },
    ] as never);

    const result = await eventStorage.run(event, () =>
      syncUserMeasurements("user-1"),
    );

    expect(result).toEqual({ imported: 0, failed: false });
    expect(prisma.measurement.update).not.toHaveBeenCalled();
    expect(tally()?.total).toBe(1);
  });
});

describe("syncUserActivity — plausibility gate", () => {
  it("plans a daily total inside the metric's declared band", async () => {
    installActivityFetch([{ date: "2026-05-16", steps: 8_400 }]);

    const imported = await eventStorage.run(event, () =>
      syncUserActivity("user-1"),
    );

    expect(imported).toBe(1);
    expect(prisma.measurement.createMany).toHaveBeenCalledTimes(1);
    expect(tally()).toBeUndefined();
  });

  it("refuses an out-of-band daily total and annotates the drop", async () => {
    // ACTIVITY_STEPS is declared 0–200 000.
    installActivityFetch([
      { date: "2026-05-16", steps: 8_400 },
      { date: "2026-05-17", steps: 9_900_000 },
    ]);

    const imported = await eventStorage.run(event, () =>
      syncUserActivity("user-1"),
    );

    expect(imported).toBe(1);
    const created = vi.mocked(prisma.measurement.createMany).mock.calls[0]?.[0]
      ?.data as Array<{ value: number }>;
    expect(created).toHaveLength(1);
    expect(created[0]!.value).toBe(8_400);
    expect(tally()).toEqual({
      total: 1,
      buckets: [
        {
          source: "withings",
          type: "ACTIVITY_STEPS",
          direction: "above_max",
          count: 1,
        },
      ],
    });
    expect(event.getLevel()).toBe("warn");
  });
});
