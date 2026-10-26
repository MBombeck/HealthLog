import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getConnMock,
  fetchRechargesMock,
  fetchSleepsMock,
  fetchActivitiesMock,
  fetchCardioLoadsMock,
  fetchSpo2Mock,
  createManyAndReturnMock,
  updateMock,
  findManyMock,
  updateManyMock,
  emitArrivalMock,
  recordSuccessMock,
  recordFailureMock,
  recomputeMock,
  transactionMock,
  reconcileMock,
  invalidateMock,
} = vi.hoisted(() => ({
  getConnMock: vi.fn(),
  fetchRechargesMock: vi.fn(),
  fetchSleepsMock: vi.fn(),
  fetchActivitiesMock: vi.fn(),
  fetchCardioLoadsMock: vi.fn(),
  fetchSpo2Mock: vi.fn(),
  createManyAndReturnMock: vi.fn(),
  updateMock: vi.fn(),
  findManyMock: vi.fn(),
  updateManyMock: vi.fn(),
  emitArrivalMock: vi.fn(),
  recordSuccessMock: vi.fn(),
  recordFailureMock: vi.fn(),
  recomputeMock: vi.fn(),
  transactionMock: vi.fn(),
  reconcileMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock("../credentials", () => ({
  getPolarConnection: getConnMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      createManyAndReturn: createManyAndReturnMock,
      update: updateMock,
      findMany: findManyMock,
      updateMany: updateManyMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: reconcileMock,
  MeasurementReconciliationError: class extends Error {},
}));

vi.mock("@/lib/integrations/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/status")>()),
  recordSyncSuccess: recordSuccessMock,
  recordSyncFailure: recordFailureMock,
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (rows: Array<{ type: string; measuredAt: Date }>) =>
    rows.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
  recomputeBucketsForMeasurement: recomputeMock,
  recomputeBucketsForKeys: recomputeMock,
}));

vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: invalidateMock,
}));

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: emitArrivalMock,
}));

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    fetchNightlyRecharges: fetchRechargesMock,
    fetchSleeps: fetchSleepsMock,
    fetchActivities: fetchActivitiesMock,
    fetchCardioLoads: fetchCardioLoadsMock,
    fetchSpo2: fetchSpo2Mock,
  };
});

import { syncUserPolar, upsertPolarMeasurements } from "../sync";
import { isSyncFailureRecorded } from "@/lib/integrations/status";
import { PolarApiError } from "../response-classifier";

const CONN = { accessToken: "tok", polarUserId: "42" };

beforeEach(() => {
  getConnMock.mockReset();
  fetchRechargesMock.mockReset();
  fetchSleepsMock.mockReset();
  fetchActivitiesMock.mockReset();
  fetchCardioLoadsMock.mockReset();
  fetchSpo2Mock.mockReset();
  transactionMock
    .mockReset()
    .mockImplementation(async (run: (tx: unknown) => unknown) => run({}));
  reconcileMock
    .mockReset()
    .mockImplementation(
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
  createManyAndReturnMock.mockReset().mockImplementation(
    async ({
      data,
    }: {
      data: Array<{
        type: string;
        measuredAt: Date;
        externalId: string;
      }>;
    }) =>
      data.map((row, index) => ({
        id: `inserted-${index}`,
        type: row.type,
        measuredAt: row.measuredAt,
        externalId: row.externalId,
      })),
  );
  updateMock.mockReset().mockResolvedValue({});
  findManyMock.mockReset();
  updateManyMock.mockReset().mockResolvedValue({ count: 0 });
  emitArrivalMock.mockReset().mockResolvedValue(undefined);
  recordSuccessMock.mockReset().mockResolvedValue(undefined);
  recordFailureMock.mockReset().mockResolvedValue(undefined);
  recomputeMock.mockReset().mockResolvedValue(undefined);
  invalidateMock.mockReset().mockResolvedValue(undefined);
  fetchRechargesMock.mockResolvedValue([]);
  fetchSleepsMock.mockResolvedValue([]);
  fetchActivitiesMock.mockResolvedValue([]);
  fetchCardioLoadsMock.mockResolvedValue([]);
  fetchSpo2Mock.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

function createdRows() {
  return reconcileMock.mock.calls.map((call) => call[1]);
}

describe("syncUserPolar", () => {
  it("no-ops cleanly for an unconnected user", async () => {
    getConnMock.mockResolvedValue(null);
    expect(await syncUserPolar("u1")).toEqual({
      imported: 0,
      failed: false,
      tokenProven: false,
    });
    expect(createManyAndReturnMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("authenticates all collection reads with the access token only", async () => {
    getConnMock.mockResolvedValue(CONN);

    await syncUserPolar("u1");

    expect(fetchRechargesMock).toHaveBeenCalledWith("tok");
    expect(fetchSleepsMock).toHaveBeenCalledWith("tok");
    expect(fetchActivitiesMock).toHaveBeenCalledWith("tok");
    expect(fetchCardioLoadsMock).toHaveBeenCalledWith("tok");
    expect(fetchSpo2Mock).toHaveBeenCalledWith("tok");
  });

  it("maps a recharge RECOVERY_SCORE row with source POLAR + stable externalId", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchRechargesMock.mockResolvedValue([
      { date: "2026-06-10", nightly_recharge_status: 6 },
    ]);
    const { imported } = await syncUserPolar("u1");
    expect(imported).toBe(1);
    const row = createdRows()[0];
    expect(row).toMatchObject({
      userId: "u1",
      type: "RECOVERY_SCORE",
      source: "POLAR",
      externalId: "recharge:2026-06-10:recovery",
      value: 100,
    });
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "polar", {
      leg: "vitals",
    });
  });

  it("maps a cardio-load row with source POLAR + stable externalId", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchCardioLoadsMock.mockResolvedValue([
      { date: "2026-06-10", cardio_load: 123.45 },
    ]);
    const { imported } = await syncUserPolar("u1");
    expect(imported).toBe(1);
    const row = createdRows()[0];
    expect(row).toMatchObject({
      type: "CARDIO_LOAD",
      source: "POLAR",
      externalId: "cardioload:2026-06-10:cardio_load",
      value: 123.45,
    });
  });

  it("keeps reconstructed sleep segments distinct under their stage-tagged externalId", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchSleepsMock.mockResolvedValue([
      {
        date: "2026-06-10",
        sleep_start_time: "2026-06-09T23:00:00+02:00",
        sleep_end_time: "2026-06-10T07:00:00+02:00",
        light_sleep: 3600,
        deep_sleep: 1800,
        rem_sleep: 5400,
      },
    ]);
    await syncUserPolar("u1");
    const externalIds = createdRows().map((row) => row.externalId);
    expect(externalIds).toContain("sleep:2026-06-10:seg:sleep_core");
    expect(externalIds).toContain("sleep:2026-06-10:seg:sleep_rem");
    // The several segment rows stay distinct (no collision).
    expect(new Set(externalIds).size).toBe(externalIds.length);
  });

  it("sweeps stale segment rows per fetched night: live-only, seg-prefixed, notIn the fresh set, soft-delete (v1.28.25)", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchSleepsMock.mockResolvedValue([
      {
        date: "2026-06-10",
        sleep_start_time: "2026-06-09T23:00:00+02:00",
        sleep_end_time: "2026-06-10T07:00:00+02:00",
        light_sleep: 3600,
        deep_sleep: 1800,
        rem_sleep: 5400,
      },
    ]);

    await syncUserPolar("u1");

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = updateManyMock.mock.calls[0]![0] as {
      where: {
        userId: string;
        source: string;
        type: string;
        deletedAt: null;
        externalId: { startsWith: string; notIn: string[] };
      };
      data: Record<string, unknown>;
    };
    expect(arg.where.userId).toBe("u1");
    expect(arg.where.source).toBe("POLAR");
    expect(arg.where.type).toBe("SLEEP_DURATION");
    expect(arg.where.deletedAt).toBeNull();
    // Bounded to THIS night's reconstructed segments. The prefix stays on
    // `:seg:` (not the whole `sleep:<date>:` slice) because the IN_BED
    // envelope keys on its measuredAt's UTC date, which can drift a calendar
    // day from `date` — a broader bound could cross nights.
    expect(arg.where.externalId.startsWith).toBe("sleep:2026-06-10:seg:");
    // Every fresh SLEEP_DURATION id is protected (segments + IN_BED).
    expect(arg.where.externalId.notIn.sort()).toEqual([
      "sleep:2026-06-10:seg:sleep_core",
      "sleep:2026-06-10:seg:sleep_deep",
      "sleep:2026-06-10:seg:sleep_rem",
      "sleep:2026-06-10:sleep_in_bed",
    ]);
    // Soft delete only.
    expect(arg.data).toEqual({ deletedAt: expect.any(Date) });

    // A legacy indexed row for this night falls inside the sweep.
    const legacyId = "sleep:2026-06-10:seg:sleep_core:0";
    expect(legacyId.startsWith(arg.where.externalId.startsWith)).toBe(true);
    expect(arg.where.externalId.notIn).not.toContain(legacyId);

    // Replace-then-write: the sweep runs before the insert statement.
    expect(updateManyMock.mock.invocationCallOrder[0]!).toBeLessThan(
      reconcileMock.mock.invocationCallOrder[0]!,
    );
  });

  it("never sweeps when the fetch returns no sleep records", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchRechargesMock.mockResolvedValue([
      { date: "2026-06-10", nightly_recharge_status: 3 },
    ]);
    await syncUserPolar("u1");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("is idempotent — a re-sync upserts on the same externalId", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchRechargesMock.mockResolvedValue([
      { date: "2026-06-10", nightly_recharge_status: 3 },
    ]);
    reconcileMock
      .mockResolvedValueOnce({
        status: "inserted",
        row: {
          id: "inserted-recharge",
          type: "RECOVERY_SCORE",
          measuredAt: new Date("2026-06-10T00:00:00.000Z"),
          externalId: "recharge:2026-06-10:recovery",
        },
      })
      .mockResolvedValueOnce({
        status: "updated",
        row: {
          id: "inserted-recharge",
          type: "RECOVERY_SCORE",
          measuredAt: new Date("2026-06-10T00:00:00.000Z"),
          externalId: "recharge:2026-06-10:recovery",
        },
      });
    await syncUserPolar("u1");
    await syncUserPolar("u1");
    expect(reconcileMock.mock.calls[0]![1].externalId).toBe(
      reconcileMock.mock.calls[1]![1].externalId,
    );
  });

  it("records a reauth_required partial failure on a 401 and does NOT throw (per-collection isolation)", async () => {
    getConnMock.mockResolvedValue(CONN);
    // The recharge collection 401s; the four siblings return data.
    fetchRechargesMock.mockRejectedValue(
      new PolarApiError({
        verb: "fetchNightlyRecharges",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "http_401",
      }),
    );
    fetchCardioLoadsMock.mockResolvedValue([
      { date: "2026-06-10", cardio_load: 42 },
    ]);

    const { imported } = await syncUserPolar("u1");

    // No rethrow now — a fetch failure is isolated per-collection.
    expect(imported).toBe(1);
    expect(createdRows().map((row) => row.type)).toContain("CARDIO_LOAD");
    // Exactly one partial failure recorded, classified off the first error,
    // naming the failed collection.
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        integration: "polar",
        kind: "reauth_required",
        errorCode: "401",
        message: expect.stringContaining("recharge"),
      }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("isolates one dead collection — imports the healthy four and records one named failure", async () => {
    getConnMock.mockResolvedValue(CONN);
    // SpO2 fails upstream, the other four return one row each.
    fetchSpo2Mock.mockRejectedValue(
      new PolarApiError({
        verb: "fetchSpo2",
        classification: "transient",
        httpStatus: 503,
        reason: "http_503",
      }),
    );
    fetchRechargesMock.mockResolvedValue([
      { date: "2026-06-10", nightly_recharge_status: 6 },
    ]);
    fetchSleepsMock.mockResolvedValue([
      {
        date: "2026-06-10",
        sleep_start_time: "2026-06-09T23:00:00+02:00",
        sleep_end_time: "2026-06-10T07:00:00+02:00",
        light_sleep: 3600,
      },
    ]);
    fetchActivitiesMock.mockResolvedValue([
      { start_time: "2026-06-10T00:00:00", steps: 8000 },
    ]);
    fetchCardioLoadsMock.mockResolvedValue([
      { date: "2026-06-10", cardio_load: 55 },
    ]);

    const result = await syncUserPolar("u1");
    const imported = result.imported;

    // The partial rides back with the count rather than being narrowed away.
    expect(result.failed).toBe(true);
    expect(result.tokenProven).toBe(true);
    // The healthy four still wrote their rows — the source is not blanked.
    const written = createdRows().map((row) => row.type);
    expect(written).toContain("RECOVERY_SCORE");
    expect(written).toContain("SLEEP_DURATION");
    expect(written).toContain("ACTIVITY_STEPS");
    expect(written).toContain("CARDIO_LOAD");
    expect(written).not.toContain("OXYGEN_SATURATION");
    expect(imported).toBeGreaterThan(0);
    // Exactly one failure, naming spo2. No success.
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "polar",
        kind: "transient",
        errorCode: "503",
        message: expect.stringContaining("spo2"),
      }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("reads a 403 beside a healthy sibling as a refused data type, not a dead token", async () => {
    getConnMock.mockResolvedValue(CONN);
    // An account without the SpO2 sensor or the consent for it: the same token
    // reads the other collections fine.
    fetchSpo2Mock.mockRejectedValue(
      new PolarApiError({
        verb: "fetchSpo2",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );
    fetchCardioLoadsMock.mockResolvedValue([
      { date: "2026-06-10", cardio_load: 55 },
    ]);

    const result = await syncUserPolar("u1");

    expect(result).toMatchObject({ failed: false, tokenProven: true });
    expect(createdRows().map((row) => row.type)).toContain("CARDIO_LOAD");
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "polar", {
      leg: "vitals",
    });
  });

  it("keeps a 403 on every collection a reauth_required failure", async () => {
    getConnMock.mockResolvedValue(CONN);
    for (const mock of [
      fetchRechargesMock,
      fetchSleepsMock,
      fetchActivitiesMock,
      fetchCardioLoadsMock,
      fetchSpo2Mock,
    ]) {
      mock.mockRejectedValue(
        new PolarApiError({
          verb: "fetch",
          classification: "reauth_required",
          httpStatus: 403,
          reason: "http_403",
        }),
      );
    }

    const result = await syncUserPolar("u1");

    expect(result).toMatchObject({ failed: true, tokenProven: false });
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reauth_required", errorCode: "403" }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("isolates a throwing mapper — one malformed record does not blank siblings", async () => {
    getConnMock.mockResolvedValue(CONN);
    // A malformed recharge record whose mapper throws on first field access
    // must not reject the whole batch (the old Promise.all failure mode).
    fetchRechargesMock.mockResolvedValue([
      new Proxy(
        {},
        {
          get() {
            throw new Error("malformed recharge point");
          },
        },
      ),
    ]);
    fetchCardioLoadsMock.mockResolvedValue([
      { date: "2026-06-10", cardio_load: 77 },
    ]);

    const { imported } = await syncUserPolar("u1");

    expect(imported).toBe(1);
    expect(createdRows().map((row) => row.type)).toContain("CARDIO_LOAD");
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("recharge") }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("sleep-collection failure skips the sweep, siblings still import", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchSleepsMock.mockRejectedValue(
      new PolarApiError({
        verb: "fetchSleeps",
        classification: "transient",
        httpStatus: 500,
        reason: "http_500",
      }),
    );
    fetchActivitiesMock.mockResolvedValue([
      { start_time: "2026-06-10T00:00:00", steps: 8000 },
    ]);

    const { imported } = await syncUserPolar("u1");

    // The sweep never ran — a failed sleep collection pushes no sweep entries.
    expect(updateManyMock).not.toHaveBeenCalled();
    // The activity sibling still imported.
    expect(createdRows().map((row) => row.type)).toContain("ACTIVITY_STEPS");
    expect(imported).toBeGreaterThan(0);
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("all five healthy → success stamped once, no failure recorded", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchRechargesMock.mockResolvedValue([
      { date: "2026-06-10", nightly_recharge_status: 6 },
    ]);

    await syncUserPolar("u1");

    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "polar", {
      leg: "vitals",
    });
  });

  it.each([
    { name: "recharge", type: "RECOVERY_SCORE" },
    { name: "sleep", type: "SLEEP_DURATION" },
    { name: "activity", type: "ACTIVITY_STEPS" },
    { name: "cardioload", type: "CARDIO_LOAD" },
    { name: "spo2", type: "OXYGEN_SATURATION" },
  ])(
    "Oura-parity: a 4xx on the $name collection names it in the single failure and imports every sibling",
    async ({ name }) => {
      getConnMock.mockResolvedValue(CONN);
      // Every collection returns one healthy row...
      fetchRechargesMock.mockResolvedValue([
        { date: "2026-06-10", nightly_recharge_status: 6 },
      ]);
      fetchSleepsMock.mockResolvedValue([
        {
          date: "2026-06-10",
          sleep_start_time: "2026-06-09T23:00:00+02:00",
          sleep_end_time: "2026-06-10T07:00:00+02:00",
          light_sleep: 3600,
        },
      ]);
      fetchActivitiesMock.mockResolvedValue([
        { start_time: "2026-06-10T00:00:00", steps: 8000 },
      ]);
      fetchCardioLoadsMock.mockResolvedValue([
        { date: "2026-06-10", cardio_load: 55 },
      ]);
      fetchSpo2Mock.mockResolvedValue([
        { test_time: 1_781_059_600, blood_oxygen_percent: 96 },
      ]);
      // ...except the one under test, which 4xxs.
      const mockByName: Record<string, ReturnType<typeof vi.fn>> = {
        recharge: fetchRechargesMock,
        sleep: fetchSleepsMock,
        activity: fetchActivitiesMock,
        cardioload: fetchCardioLoadsMock,
        spo2: fetchSpo2Mock,
      };
      mockByName[name]!.mockRejectedValue(
        new PolarApiError({
          verb: name,
          classification: "persistent",
          httpStatus: 404,
          reason: "http_404",
        }),
      );

      await syncUserPolar("u1");

      // Exactly one failure, naming this collection; no success stamp.
      expect(recordFailureMock).toHaveBeenCalledTimes(1);
      expect(recordFailureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          integration: "polar",
          message: expect.stringContaining(name),
        }),
      );
      expect(recordSuccessMock).not.toHaveBeenCalled();
      // Every sibling collection still imported at least one row.
      const written = createdRows().map((row) => row.type);
      const siblingTypes: Record<string, string> = {
        recharge: "RECOVERY_SCORE",
        sleep: "SLEEP_DURATION",
        activity: "ACTIVITY_STEPS",
        cardioload: "CARDIO_LOAD",
        spo2: "OXYGEN_SATURATION",
      };
      for (const [collName, collType] of Object.entries(siblingTypes)) {
        if (collName === name) continue;
        expect(written).toContain(collType);
      }
    },
  );

  it("leaves a write-path failure UNMARKED so the cohort boundary records it once", async () => {
    // The `upsertPolarMeasurements` transaction throw escapes `syncUserPolar`
    // uncaught: no source-site record, no mark — the poll-cohort boundary is
    // what records it (exactly once).
    getConnMock.mockResolvedValue(CONN);
    fetchRechargesMock.mockResolvedValue([
      { date: "2026-06-10", nightly_recharge_status: 6 },
    ]);
    reconcileMock.mockReset().mockResolvedValue({
      status: "failed",
      reason: "db_error",
      error: new Error("write boom"),
    });

    const err = await syncUserPolar("u1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isSyncFailureRecorded(err)).toBe(false);
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });
});

describe("upsertPolarMeasurements — exact insertion results", () => {
  const measuredAt = new Date("2026-06-10T08:00:00.000Z");
  const readings = [
    {
      type: "RECOVERY_SCORE" as const,
      value: 100,
      unit: "score",
      measuredAt,
      externalId: "recharge:2026-06-10:recovery",
    },
    {
      type: "CARDIO_LOAD" as const,
      value: 123.45,
      unit: "score",
      measuredAt,
      externalId: "cardioload:2026-06-10:cardio_load",
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
          type: "CARDIO_LOAD",
          measuredAt,
          externalId: readings[1].externalId,
        },
      });
    const onInserted = vi.fn();

    expect(await upsertPolarMeasurements("u1", readings, { onInserted })).toBe(
      2,
    );

    expect(onInserted).toHaveBeenCalledWith([inserted]);
    expect(emitArrivalMock).toHaveBeenCalledWith("u1", [inserted], "polar");
    expect(reconcileMock.mock.calls[1]![1]).toMatchObject({
      userId: "u1",
      type: "CARDIO_LOAD",
      source: "POLAR",
      externalId: readings[1].externalId,
    });
  });

  it("does not pre-probe and still emits a genuine insert", async () => {
    findManyMock.mockRejectedValue(new Error("probe unavailable"));
    const inserted = {
      id: "new-1",
      type: "RECOVERY_SCORE",
      measuredAt,
      externalId: readings[0].externalId,
    };
    reconcileMock.mockResolvedValueOnce({ status: "inserted", row: inserted });

    await upsertPolarMeasurements("u1", [readings[0]]);

    expect(findManyMock).not.toHaveBeenCalled();
    expect(emitArrivalMock).toHaveBeenCalledWith("u1", [inserted], "polar");
  });
});
