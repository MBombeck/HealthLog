/**
 * F-SYNC-3 — the metric MAPPER runs inside a per-type catch, not just the
 * fetch. A single malformed point whose `resource.map(point)` throws used to
 * escape the METRIC_RESOURCES loop and skip every metric type ordered after it
 * (body-fat, spo2, hrv, rhr, respiratory, glucose, temps), also blocking the
 * watermark so the bad point refetched hourly and those types stayed dead.
 *
 * This pins the contract: a throwing mapper on the first type routes through
 * `handleCollectionFetchError` and the loop continues to fetch every sibling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchDataPointsMock, handleErrorMock, mapWeightMock } = vi.hoisted(
  () => ({
    fetchDataPointsMock: vi.fn(),
    handleErrorMock: vi.fn(async () => 0),
    mapWeightMock: vi.fn(() => {
      throw new Error("malformed weight point");
    }),
  }),
);

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    fetchDataPoints: fetchDataPointsMock,
    mapWeight: mapWeightMock,
  };
});

vi.mock("../sync-core", () => ({
  getValidToken: vi.fn(async () => ({
    accessToken: "token",
    connection: { id: "c1", googleUserId: "g1" },
  })),
  handleCollectionFetchError: handleErrorMock,
  upsertGoogleHealthMeasurements: vi.fn(async () => ({
    imported: 0,
    touched: [],
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

import { syncUserMetrics } from "../sync-metrics";

beforeEach(() => {
  handleErrorMock.mockClear();
  mapWeightMock.mockClear();
  // Weight returns one point (whose mapper throws); everything else is empty so
  // its real mapper is never exercised.
  fetchDataPointsMock
    .mockReset()
    .mockImplementation(async (_dt: unknown, _token: string, verb: string) =>
      verb === "fetchWeight" ? [{ any: "point" }] : [],
    );
});

describe("syncUserMetrics — a throwing mapper never skips sibling types", () => {
  it("routes the map throw through the ledger and keeps fetching the rest", async () => {
    await expect(syncUserMetrics("user-1")).resolves.toBe(0);

    // The weight mapper threw and was routed exactly once.
    expect(mapWeightMock).toHaveBeenCalled();
    expect(handleErrorMock).toHaveBeenCalledWith(
      "fetchWeight",
      "user-1",
      expect.any(Error),
    );

    // Every metric type ordered AFTER weight still fetched — the loop was not
    // aborted by the throw.
    const verbs = fetchDataPointsMock.mock.calls.map((c) => c[2]);
    expect(verbs).toContain("fetchBodyFat");
    expect(verbs).toContain("fetchSpo2");
    expect(verbs).toContain("fetchRespiratoryRate");
    expect(verbs).toContain("fetchHeartRate");
  });
});
