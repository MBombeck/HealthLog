/**
 * Pins the record-scoped stale-segment sweep in the WHOOP sleep sync
 * (v1.28.25). A WHOOP re-score used to renumber the reconstructed segments'
 * indexed externalIds and insert a duplicate night; the ids are stage-tagged
 * (stable) now, and the sync sweeps whatever an earlier scoring left under a
 * re-fetched record's prefix — including every legacy `:seg:<tag>:<i>` row.
 * The sweep must be bounded to the records of THIS fetch, live-only,
 * SLEEP_DURATION-only, keep-protected, and soft-delete.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateManyMock, upsertMeasurementsMock, morningRefreshMock } =
  vi.hoisted(() => ({
    updateManyMock: vi.fn(async () => ({ count: 0 })),
    upsertMeasurementsMock: vi.fn(
      async (
        _userId: string,
        readings: Array<{ type: string; measuredAt: Date }>,
        opts?: {
          onInserted?: (
            rows: Array<{ id: string; type: string; measuredAt: Date }>,
          ) => void;
        },
      ) => {
        opts?.onInserted?.(
          readings.map((row, index) => ({ ...row, id: `inserted-${index}` })),
        );
        return 1;
      },
    ),
    morningRefreshMock: vi.fn<(...args: unknown[]) => Promise<void>>(
      async () => {},
    ),
  }));

vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: (...args: unknown[]) =>
    morningRefreshMock(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { updateMany: updateManyMock },
    whoopConnection: {
      findUnique: vi.fn(async () => ({
        lastSyncedAt: null,
        resourceCursors: null,
      })),
    },
  },
}));

vi.mock("../sync-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sync-core")>()),
  getValidToken: vi.fn(async () => ({ accessToken: "tok" })),
  markResourceSynced: vi.fn(async () => {}),
  upsertWhoopMeasurements: upsertMeasurementsMock,
}));

const { fetchSleepsMock } = vi.hoisted(() => ({ fetchSleepsMock: vi.fn() }));
vi.mock("../client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client")>()),
  fetchSleeps: fetchSleepsMock,
  fetchSleepById: fetchSleepsMock,
}));

import type { WhoopSleep } from "../client";
import { syncUserSleep } from "../sync-sleep";

const NIGHT: WhoopSleep = {
  id: "sleep-uuid",
  user_id: 42,
  created_at: "2026-06-01T05:00:00.000Z",
  updated_at: "2026-06-01T07:00:00.000Z",
  start: "2026-05-31T23:00:00.000Z",
  end: "2026-06-01T07:00:00.000Z",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 28_800_000,
      total_awake_time_milli: 1_800_000,
      total_light_sleep_time_milli: 14_400_000,
      total_slow_wave_sleep_time_milli: 5_400_000,
      total_rem_sleep_time_milli: 7_200_000,
    },
    sleep_needed: {
      baseline_milli: 27_000_000,
      need_from_sleep_debt_milli: 0,
      need_from_recent_strain_milli: 0,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 15.2,
    sleep_performance_percentage: 88,
    sleep_efficiency_percentage: 93.5,
    sleep_consistency_percentage: 71,
  },
};

beforeEach(() => {
  updateManyMock.mockClear().mockResolvedValue({ count: 0 });
  upsertMeasurementsMock.mockClear();
  fetchSleepsMock.mockReset();
  morningRefreshMock.mockClear();
});

describe("syncUserSleep — record-scoped stale-segment sweep", () => {
  it("sweeps live WHOOP SLEEP_DURATION rows under the record prefix, keeping the fresh set", async () => {
    fetchSleepsMock.mockResolvedValue([NIGHT]);

    await syncUserSleep("user-1");

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = (updateManyMock.mock.calls[0]! as unknown[])[0] as {
      where: {
        userId: string;
        source: string;
        type: string;
        deletedAt: null;
        externalId: { startsWith: string; notIn: string[] };
      };
      data: Record<string, unknown>;
    };
    expect(arg.where.userId).toBe("user-1");
    expect(arg.where.source).toBe("WHOOP");
    expect(arg.where.type).toBe("SLEEP_DURATION");
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.externalId.startsWith).toBe("sleep-uuid:");
    // The fresh set: the four stage-tagged segments + the IN_BED envelope.
    expect(arg.where.externalId.notIn.sort()).toEqual([
      "sleep-uuid:seg:sleep_awake",
      "sleep-uuid:seg:sleep_core",
      "sleep-uuid:seg:sleep_deep",
      "sleep-uuid:seg:sleep_rem",
      "sleep-uuid:sleep_in_bed",
    ]);
    // Soft delete only.
    expect(arg.data).toEqual({ deletedAt: expect.any(Date) });

    // A legacy indexed row for this record falls inside the sweep.
    const legacyId = "sleep-uuid:seg:sleep_core:1";
    expect(legacyId.startsWith(arg.where.externalId.startsWith)).toBe(true);
    expect(arg.where.externalId.notIn).not.toContain(legacyId);
  });

  it("sweeps BEFORE the fresh set upserts (replace-then-write, google parity)", async () => {
    fetchSleepsMock.mockResolvedValue([NIGHT]);
    await syncUserSleep("user-1");
    const sweepOrder = updateManyMock.mock.invocationCallOrder[0]!;
    const upsertOrder = upsertMeasurementsMock.mock.invocationCallOrder[0]!;
    expect(sweepOrder).toBeLessThan(upsertOrder);
  });

  it("skips the sweep for an unscored record (no fresh ids — deleting would wipe the night)", async () => {
    fetchSleepsMock.mockResolvedValue([
      { ...NIGHT, score_state: "PENDING_SCORE", score: undefined },
    ]);
    await syncUserSleep("user-1");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("never fails the sync when the sweep query throws", async () => {
    fetchSleepsMock.mockResolvedValue([NIGHT]);
    updateManyMock.mockRejectedValueOnce(new Error("db down"));
    await expect(syncUserSleep("user-1")).resolves.toBe(1);
    expect(upsertMeasurementsMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues one refresh after every committed chunk settles", async () => {
    fetchSleepsMock.mockResolvedValue([NIGHT]);
    const firstMeasuredAt = new Date("2026-06-01T06:30:00.000Z");
    const secondMeasuredAt = new Date("2026-06-01T07:00:00.000Z");
    upsertMeasurementsMock.mockImplementationOnce(
      async (
        _userId: string,
        _readings: Array<{ type: string; measuredAt: Date }>,
        opts?: {
          onInserted?: (
            rows: Array<{ id: string; type: string; measuredAt: Date }>,
          ) => void;
        },
      ) => {
        opts?.onInserted?.([
          {
            id: "first-committed-segment",
            type: "SLEEP_DURATION",
            measuredAt: firstMeasuredAt,
          },
        ]);
        opts?.onInserted?.([
          {
            id: "second-committed-segment",
            type: "SLEEP_DURATION",
            measuredAt: secondMeasuredAt,
          },
        ]);
        return 2;
      },
    );

    await expect(syncUserSleep("user-1")).resolves.toBe(2);

    expect(morningRefreshMock).toHaveBeenCalledTimes(1);
    expect(morningRefreshMock).toHaveBeenCalledWith("user-1", [
      firstMeasuredAt,
      secondMeasuredAt,
    ]);
  });

  it("enqueues refreshes for a committed chunk before a later chunk fails", async () => {
    fetchSleepsMock.mockResolvedValue([NIGHT]);
    const measuredAt = new Date("2026-06-01T07:00:00.000Z");
    upsertMeasurementsMock.mockImplementationOnce(
      async (
        _userId: string,
        _readings: Array<{ type: string; measuredAt: Date }>,
        opts?: {
          onInserted?: (
            rows: Array<{ id: string; type: string; measuredAt: Date }>,
          ) => void;
        },
      ) => {
        opts?.onInserted?.([
          { id: "committed-segment", type: "SLEEP_DURATION", measuredAt },
        ]);
        throw new Error("injected later-chunk failure");
      },
    );

    await expect(syncUserSleep("user-1")).rejects.toThrow(
      "injected later-chunk failure",
    );

    expect(morningRefreshMock).toHaveBeenCalledWith("user-1", [measuredAt]);
  });
});
