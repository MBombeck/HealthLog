/**
 * A history import slice that meets a provider outage is sent again later,
 * not dropped after pg-boss's three quick retries; a refused credential stops
 * it with the reason on the integration's ledger; and a chain that keeps
 * failing gives up after a bounded number of attempts, on the ledger and in
 * the job's own error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

const { sends, recordSyncFailureMock, isReauthRequiredMock, runGarminMock } =
  vi.hoisted(() => ({
    sends: [] as Array<{
      queue: string;
      payload: unknown;
      options: Record<string, unknown> | undefined;
    }>,
    recordSyncFailureMock: vi.fn(),
    isReauthRequiredMock: vi.fn(),
    runGarminMock: vi.fn(),
  }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({
    send: async (
      queue: string,
      payload: unknown,
      options?: Record<string, unknown>,
    ) => {
      sends.push({ queue, payload, options });
      return `job-${sends.length}`;
    },
  }),
}));
vi.mock(
  "@/lib/jobs/integration-backfill-claim",
  () => import("@/__tests__/helpers/backfill-claim-passthrough"),
);
vi.mock("@/lib/integrations/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/status")>()),
  recordSyncFailure: recordSyncFailureMock,
  isReauthRequired: isReauthRequiredMock,
}));
vi.mock("@/lib/jobs/integration-backfill-lock", () => ({
  withIntegrationBackfillLock: async (_id: string, run: () => unknown) => ({
    ran: true,
    result: await run(),
  }),
}));
vi.mock("@/lib/jobs/garmin-backfill", () => ({
  runGarminBackfillForUser: runGarminMock,
}));
vi.mock("@/lib/jobs/reminder/shared", () => ({ workerLog: () => {} }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: () => {} }));

import { GarminApiError } from "@/lib/garmin/client";
import { drainIntegrationBackfillAdmission } from "../integration-backfill-drain";
import type { IntegrationBackfillAdmissionPayload } from "../integration-backfill-admission";
import {
  backfillRetryDelaySeconds,
  classifyBackfillFailure,
  INTEGRATION_BACKFILL_RETRY_BASE_SECONDS,
  INTEGRATION_BACKFILL_RETRY_CAP_SECONDS,
  INTEGRATION_BACKFILL_TRANSIENT_ATTEMPTS,
} from "../integration-backfill-retry";

function job(
  data: IntegrationBackfillAdmissionPayload["data"],
  retryCount = 0,
): Job<IntegrationBackfillAdmissionPayload> {
  return {
    id: `job-${data.slice ?? 0}`,
    data: { kind: "garmin-backfill", data },
    expireInSeconds: 3600,
    retryCount,
  } as unknown as Job<IntegrationBackfillAdmissionPayload>;
}

function garmin500(): GarminApiError {
  return new GarminApiError({
    verb: "dailySummaries",
    classification: "transient",
    httpStatus: 500,
    reason: "http_500",
  });
}

/** What the Garmin runner throws when a slice made no progress. */
function sliceFailure(slice: number, cause: unknown): Error {
  return new Error(
    `garmin backfill incomplete for user u1 (slice ${slice}: ${(cause as Error).message})`,
    { cause },
  );
}

beforeEach(() => {
  sends.length = 0;
  recordSyncFailureMock.mockReset();
  isReauthRequiredMock.mockReset().mockResolvedValue(false);
  runGarminMock.mockReset();
});

describe("classifyBackfillFailure", () => {
  it("reads a provider 5xx through the runner's wrapper as transient", () => {
    expect(classifyBackfillFailure(sliceFailure(2, garmin500()))).toMatchObject(
      { kind: "transient", httpStatus: 500 },
    );
  });

  it("carries the Retry-After of a 503", () => {
    const err = new GarminApiError({
      verb: "dailySummaries",
      classification: "transient",
      httpStatus: 503,
      reason: "http_503",
      retryAfterMs: 120_000,
    });
    expect(classifyBackfillFailure(sliceFailure(1, err))).toMatchObject({
      kind: "transient",
      retryAfterMs: 120_000,
    });
  });

  it("treats a timeout and a dropped connection as transient", () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    expect(classifyBackfillFailure(timeout).kind).toBe("transient");
    const reset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      }),
    });
    expect(classifyBackfillFailure(reset).kind).toBe("transient");
  });

  it("treats a refused credential as permanent", () => {
    const err = new GarminApiError({
      verb: "dailySummaries",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "key_refused",
      keyRefused: true,
    });
    expect(classifyBackfillFailure(sliceFailure(0, err)).kind).toBe(
      "permanent",
    );
  });

  it("leaves a contract error and an error without a provider cause alone", () => {
    const err = new GarminApiError({
      verb: "dailySummaries",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
    });
    expect(classifyBackfillFailure(sliceFailure(0, err)).kind).toBe("other");
    expect(classifyBackfillFailure(new Error("deadlock detected")).kind).toBe(
      "other",
    );
  });
});

describe("backfillRetryDelaySeconds", () => {
  it("doubles from the base, with jitter between half and the whole step", () => {
    const base = INTEGRATION_BACKFILL_RETRY_BASE_SECONDS;
    expect(backfillRetryDelaySeconds(1, undefined, () => 0)).toBe(base / 2);
    expect(backfillRetryDelaySeconds(1, undefined, () => 1)).toBe(base);
    expect(backfillRetryDelaySeconds(3, undefined, () => 1)).toBe(base * 4);
  });

  it("stops growing at the cap", () => {
    expect(backfillRetryDelaySeconds(30, undefined, () => 1)).toBe(
      INTEGRATION_BACKFILL_RETRY_CAP_SECONDS,
    );
  });

  it("never comes back sooner than Retry-After asks", () => {
    expect(backfillRetryDelaySeconds(1, 2 * 60 * 60 * 1000, () => 0)).toBe(
      2 * 60 * 60,
    );
  });
});

describe("drainIntegrationBackfillAdmission on a failed slice", () => {
  it("sends a slice that met a 500 again later, and the retry goes on", async () => {
    runGarminMock.mockRejectedValueOnce(sliceFailure(2, garmin500()));

    await expect(
      drainIntegrationBackfillAdmission([
        job({ userId: "u1", enqueuedAt: "2026-11-26T13:00:00Z", slice: 2 }),
      ]),
    ).resolves.toBeDefined();

    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      queue: "integration-backfill-admission",
      payload: {
        kind: "garmin-backfill",
        data: { userId: "u1", slice: 3, retry: 1 },
      },
    });
    const startAfter = sends[0]!.options?.startAfter as number;
    expect(startAfter).toBeGreaterThanOrEqual(
      INTEGRATION_BACKFILL_RETRY_BASE_SECONDS / 2,
    );
    expect(startAfter).toBeLessThanOrEqual(
      INTEGRATION_BACKFILL_RETRY_BASE_SECONDS,
    );
    expect(recordSyncFailureMock).not.toHaveBeenCalled();

    // Garmin answers again: the retried slice runs and continues normally.
    runGarminMock.mockResolvedValueOnce({ imported: 120, continued: true });
    const retried = sends[0]!.payload as IntegrationBackfillAdmissionPayload;
    await drainIntegrationBackfillAdmission([job(retried.data)]);
    expect(runGarminMock).toHaveBeenLastCalledWith(
      "u1",
      expect.any(Function),
      3,
    );
  });

  it("gives up after the bounded attempts, on the ledger and in the job error", async () => {
    runGarminMock.mockImplementation(async (_u: string, _s: unknown, slice) => {
      throw sliceFailure(slice as number, garmin500());
    });

    let data: IntegrationBackfillAdmissionPayload["data"] = {
      userId: "u1",
      enqueuedAt: "2026-11-26T13:00:00Z",
      slice: 2,
    };
    let error: unknown;
    for (let i = 0; i < INTEGRATION_BACKFILL_TRANSIENT_ATTEMPTS + 2; i++) {
      const before = sends.length;
      try {
        await drainIntegrationBackfillAdmission([job(data)]);
      } catch (err) {
        error = err;
        break;
      }
      expect(sends.length).toBe(before + 1);
      data = (sends.at(-1)!.payload as IntegrationBackfillAdmissionPayload)
        .data;
    }

    expect(runGarminMock).toHaveBeenCalledTimes(
      INTEGRATION_BACKFILL_TRANSIENT_ATTEMPTS,
    );
    expect(sends).toHaveLength(INTEGRATION_BACKFILL_TRANSIENT_ATTEMPTS - 1);
    expect(String(error)).toMatch(
      new RegExp(
        `gave up after ${INTEGRATION_BACKFILL_TRANSIENT_ATTEMPTS} attempts: garmin backfill incomplete .*slice 9: Garmin dailySummaries error: 500`,
      ),
    );
    expect(recordSyncFailureMock).toHaveBeenCalledTimes(1);
    const recorded = recordSyncFailureMock.mock.calls[0]![0];
    expect(recorded).toMatchObject({
      userId: "u1",
      integration: "garmin",
      kind: "transient",
      errorCode: "500",
      leg: "backfill",
    });
    // The card's message is the provider's, not the runner's account line.
    expect(recorded.message).toContain("Garmin dailySummaries error: 500");
    expect(recorded.message).not.toContain("u1");

    // A pg-boss retry of the job that gave up does not record it again.
    await expect(
      drainIntegrationBackfillAdmission([job(data, 1)]),
    ).rejects.toThrow(/gave up/);
    expect(recordSyncFailureMock).toHaveBeenCalledTimes(1);
  });

  it("parks a refused credential at reauth and does not retry it", async () => {
    runGarminMock.mockRejectedValueOnce(
      sliceFailure(
        0,
        new GarminApiError({
          verb: "dailySummaries",
          classification: "reauth_required",
          httpStatus: 401,
          reason: "key_refused",
          keyRefused: true,
        }),
      ),
    );

    await expect(
      drainIntegrationBackfillAdmission([
        job({ userId: "u1", enqueuedAt: "2026-11-26T13:00:00Z" }),
      ]),
    ).rejects.toThrow(/incomplete/);
    expect(sends).toHaveLength(0);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "garmin",
        kind: "reauth_required",
        errorCode: "401",
      }),
    );
  });

  it("leaves an error without a provider cause to the pg-boss retry", async () => {
    runGarminMock.mockRejectedValueOnce(new Error("deadlock detected"));
    await expect(
      drainIntegrationBackfillAdmission([
        job({ userId: "u1", enqueuedAt: "2026-11-26T13:00:00Z" }),
      ]),
    ).rejects.toThrow("deadlock detected");
    expect(sends).toHaveLength(0);
    expect(recordSyncFailureMock).not.toHaveBeenCalled();
  });
});
