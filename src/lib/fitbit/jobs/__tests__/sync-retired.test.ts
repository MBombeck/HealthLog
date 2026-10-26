/**
 * The hourly Fitbit cron after Google turned the Web API off: it reads no
 * connection, runs no cohort, and finishes as a clean no-op, so the shutdown
 * cannot turn into an hourly storm of failed polls.
 */
import { describe, expect, it, vi } from "vitest";

const { findMany, runFitbitPollCohort } = vi.hoisted(() => ({
  findMany: vi.fn(async () => [{ userId: "u1" }]),
  runFitbitPollCohort: vi.fn(async () => ({
    usersSynced: 1,
    measurementsImported: 3,
  })),
}));

vi.mock("@/lib/jobs/reminder/shared", () => ({
  getWorkerPrisma: () => ({ fitbitConnection: { findMany } }),
}));
vi.mock("@/lib/fitbit/sync", () => ({ runFitbitPollCohort }));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn(async () => {}),
}));

import { handleFitbitSync } from "@/lib/fitbit/jobs/sync-handlers";
import { isFitbitRetired } from "@/lib/fitbit/retirement";

describe("handleFitbitSync", () => {
  it("polls the cohort while the Web API is up", async () => {
    await handleFitbitSync([]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(runFitbitPollCohort).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all after the turndown", async () => {
    findMany.mockClear();
    runFitbitPollCohort.mockClear();
    vi.mocked(isFitbitRetired).mockReturnValue(true);
    try {
      const outcome = await handleFitbitSync([]);
      expect(findMany).not.toHaveBeenCalled();
      expect(runFitbitPollCohort).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ ok: true, did: { total: 0 } });
    } finally {
      vi.mocked(isFitbitRetired).mockReturnValue(false);
    }
  });
});
