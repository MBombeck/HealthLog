/**
 * v1.11.3 — WHOOP body-measurement sync tests (mocked). Covers:
 *   - `mapBody` maps weight/max-HR/height (m→cm) and nulls absent fields;
 *   - weight lands as a single overwrite-in-place WEIGHT row (stable externalId);
 *   - `max_heart_rate` is persisted to WhoopConnection.maxHeartRate;
 *   - height seeds User.heightCm ONLY when currently null (never overwrites);
 *   - a collection 403 soft-skips (returns 0, records no failure).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhoopApiError } from "../response-classifier";

// ── Module mocks ────────────────────────────────────────────────
const {
  prismaMock,
  getValidTokenMock,
  fetchBodyMeasurementMock,
  upsertWhoopMeasurementsMock,
  markSyncedMock,
  recordWhoopSyncFailureMock,
} = vi.hoisted(() => ({
  prismaMock: {
    whoopConnection: {
      update: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({})),
    },
    measurement: {
      deleteMany: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
        count: 0,
      })),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({})),
    },
  },
  getValidTokenMock: vi.fn(),
  fetchBodyMeasurementMock: vi.fn(),
  upsertWhoopMeasurementsMock: vi.fn<(...a: unknown[]) => Promise<number>>(
    async () => 1,
  ),
  markSyncedMock: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  recordWhoopSyncFailureMock: vi.fn<(...a: unknown[]) => Promise<void>>(
    async () => {},
  ),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => null,
  annotate: () => {},
}));

vi.mock("../client", async (orig) => {
  const actual = await orig<typeof import("../client")>();
  return {
    ...actual,
    fetchBodyMeasurement: (...a: unknown[]) => fetchBodyMeasurementMock(...a),
  };
});

vi.mock("../sync-core", async (orig) => {
  const actual = await orig<typeof import("../sync-core")>();
  return {
    ...actual,
    getValidToken: (...a: unknown[]) => getValidTokenMock(...a),
    upsertWhoopMeasurements: (...a: unknown[]) =>
      upsertWhoopMeasurementsMock(...a),
    markSynced: (...a: unknown[]) => markSyncedMock(...a),
    recordWhoopSyncFailure: (...a: unknown[]) =>
      recordWhoopSyncFailureMock(...a),
  };
});

import { mapBody } from "../client";
import { syncUserBody, WHOOP_BODY_WEIGHT_EXTERNAL_ID } from "../sync-body";

const TOKEN = {
  accessToken: "acc",
  connection: { id: "c1", whoopUserId: "9" },
};

beforeEach(() => {
  vi.clearAllMocks();
  getValidTokenMock.mockResolvedValue(TOKEN);
  upsertWhoopMeasurementsMock.mockResolvedValue(1);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("mapBody", () => {
  it("maps weight, max-HR, and height (m→cm)", () => {
    const out = mapBody({
      weight_kilogram: 81.234,
      max_heart_rate: 191.6,
      height_meter: 1.83,
    });
    expect(out.weightKg).toBe(81.23);
    // max heart rate rounds to an integer (column is Int).
    expect(out.maxHeartRate).toBe(192);
    expect(out.heightCm).toBe(183);
  });

  it("nulls every field that WHOOP omits", () => {
    expect(mapBody({})).toEqual({
      weightKg: null,
      maxHeartRate: null,
      heightCm: null,
    });
  });

  it("nulls weight when absent but keeps the present fields", () => {
    const out = mapBody({ max_heart_rate: 180 });
    expect(out.weightKg).toBeNull();
    expect(out.maxHeartRate).toBe(180);
    expect(out.heightCm).toBeNull();
  });
});

describe("syncUserBody — profile weight is not ingested (v1.16.11)", () => {
  it("never upserts a weight Measurement, even when WHOOP sends one", async () => {
    fetchBodyMeasurementMock.mockResolvedValue({ weight_kilogram: 80 });
    prismaMock.user.findUnique.mockResolvedValue({ heightCm: 170 });

    const imported = await syncUserBody("user1");

    expect(imported).toBe(0);
    expect(upsertWhoopMeasurementsMock).not.toHaveBeenCalled();
  });

  it("clears the legacy overwrite row on every pass (idempotent no-op after the first)", async () => {
    fetchBodyMeasurementMock.mockResolvedValue({ weight_kilogram: 80 });
    prismaMock.user.findUnique.mockResolvedValue({ heightCm: 170 });

    await syncUserBody("user1");

    expect(prismaMock.measurement.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user1",
        type: "WEIGHT",
        source: "WHOOP",
        externalId: WHOOP_BODY_WEIGHT_EXTERNAL_ID,
      },
    });
  });
});

describe("syncUserBody — max heart rate", () => {
  it("persists max_heart_rate to WhoopConnection.maxHeartRate", async () => {
    fetchBodyMeasurementMock.mockResolvedValue({ max_heart_rate: 186 });
    prismaMock.user.findUnique.mockResolvedValue({ heightCm: 170 });

    await syncUserBody("user1");

    expect(prismaMock.whoopConnection.update).toHaveBeenCalledWith({
      where: { userId: "user1" },
      data: { maxHeartRate: 186 },
    });
  });

  it("skips the connection write when max_heart_rate is absent", async () => {
    fetchBodyMeasurementMock.mockResolvedValue({ weight_kilogram: 80 });
    prismaMock.user.findUnique.mockResolvedValue({ heightCm: 170 });

    await syncUserBody("user1");

    expect(prismaMock.whoopConnection.update).not.toHaveBeenCalled();
  });
});

describe("syncUserBody — height seed (only when null)", () => {
  it("writes User.heightCm when it is currently null", async () => {
    fetchBodyMeasurementMock.mockResolvedValue({ height_meter: 1.8 });
    prismaMock.user.findUnique.mockResolvedValue({ heightCm: null });

    await syncUserBody("user1");

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user1" },
      data: { heightCm: 180 },
    });
  });

  it("does NOT overwrite a user-set height", async () => {
    fetchBodyMeasurementMock.mockResolvedValue({ height_meter: 1.9 });
    prismaMock.user.findUnique.mockResolvedValue({ heightCm: 175 });

    await syncUserBody("user1");

    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("never mints a Measurement for height", async () => {
    fetchBodyMeasurementMock.mockResolvedValue({ height_meter: 1.8 });
    prismaMock.user.findUnique.mockResolvedValue({ heightCm: null });

    const imported = await syncUserBody("user1");

    // No weight present → nothing imported as a Measurement.
    expect(imported).toBe(0);
    expect(upsertWhoopMeasurementsMock).not.toHaveBeenCalled();
  });
});

describe("syncUserBody — tier degradation", () => {
  it("soft-skips a collection 403 (returns 0, records no failure)", async () => {
    fetchBodyMeasurementMock.mockRejectedValue(
      new WhoopApiError({
        verb: "fetchBodyMeasurement",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );

    const imported = await syncUserBody("user1");

    expect(imported).toBe(0);
    expect(recordWhoopSyncFailureMock).not.toHaveBeenCalled();
    expect(markSyncedMock).not.toHaveBeenCalled();
  });

  it("rethrows a 401 (genuine reauth) instead of soft-skipping", async () => {
    fetchBodyMeasurementMock.mockRejectedValue(
      new WhoopApiError({
        verb: "fetchBodyMeasurement",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "http_401",
      }),
    );

    // A 401 is not a per-class tier gate: it propagates so the connection
    // parks (vs the 403 case above, which returns 0). The catch delegates to
    // the shared `handleCollectionFetchError` (sync-core.ts), whose "401 records a
    // reauth failure + rethrows" contract is unit-tested in sync.test.ts; here
    // we assert the resource sync surfaces the error and writes nothing.
    await expect(syncUserBody("user1")).rejects.toThrow();
    expect(upsertWhoopMeasurementsMock).not.toHaveBeenCalled();
  });

  it("returns 0 without fetching when there is no valid token", async () => {
    getValidTokenMock.mockResolvedValue(null);

    const imported = await syncUserBody("user1");

    expect(imported).toBe(0);
    expect(fetchBodyMeasurementMock).not.toHaveBeenCalled();
  });
});
