/**
 * Pins the cumulative-group independence contract: each of the four rollup
 * types (steps / distance / active-energy / floors) and the VO2-max summary
 * fetches independently inside `syncUserActivity`. A hard failure on ONE type
 * routes through `handleCollectionFetchError` and the loop continues — the
 * siblings still fetch (live regression: steps' 400 killed the whole group).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchDailyRollUpMock, fetchDataPointsMock, handleErrorMock } =
  vi.hoisted(() => ({
    fetchDailyRollUpMock: vi.fn(),
    fetchDataPointsMock: vi.fn(async () => []),
    handleErrorMock: vi.fn(async () => 0),
  }));

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    fetchDailyRollUp: fetchDailyRollUpMock,
    fetchDataPoints: fetchDataPointsMock,
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
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));

import { syncUserActivity } from "../sync-activity";
import { GoogleHealthApiError } from "../response-classifier";

beforeEach(() => {
  fetchDailyRollUpMock.mockReset();
  fetchDataPointsMock.mockClear();
  handleErrorMock.mockClear();
});

describe("syncUserActivity — one rollup failure never suppresses siblings", () => {
  it("keeps fetching distance / active-energy / floors / vo2max after steps 400s", async () => {
    fetchDailyRollUpMock.mockImplementation(
      async (_dt: unknown, _token: string, verb: string) => {
        if (verb === "fetchSteps") {
          throw new GoogleHealthApiError({
            verb,
            classification: "persistent",
            httpStatus: 400,
            reason: "HTTP 400",
          });
        }
        return [];
      },
    );

    await expect(syncUserActivity("user-1")).resolves.toBe(0);

    const verbs = fetchDailyRollUpMock.mock.calls.map((c) => c[2]);
    expect(verbs).toEqual([
      "fetchSteps",
      "fetchDistance",
      "fetchActiveEnergy",
      "fetchFloors",
    ]);
    // VO2 max (list read) still ran too.
    expect(fetchDataPointsMock).toHaveBeenCalledTimes(1);
    // The steps failure was routed through the shared handler exactly once.
    expect(handleErrorMock).toHaveBeenCalledTimes(1);
    expect(handleErrorMock).toHaveBeenCalledWith(
      "fetchSteps",
      "user-1",
      expect.any(GoogleHealthApiError),
    );
  });
});
