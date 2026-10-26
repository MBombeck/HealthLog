/**
 * The nightly mood-forecast rebuild.
 *
 * Three properties, each of which fails silently if it breaks:
 *
 *   1. **The sweep visits accounts that hold rows, not only accounts that
 *      qualify.** An account that deleted its entries drops out of the
 *      eligibility half of the cohort, and if that were the whole cohort it
 *      would keep last month's forecast forever, under whatever date the last
 *      pass stamped on it. Nothing on the surface would say so.
 *   2. **A refusal clears.** Below the threshold, module off, no pattern — all
 *      three leave the account with no rows rather than with stale ones.
 *   3. **One account's bad data costs one account.** The pass counts the
 *      failure and carries on; only an all-accounts failure fails the job.
 *
 * The cohort query and the module gate are mocked, which is what makes the
 * decision path testable without a container. The arithmetic underneath has
 * its own tests, and the whole thing is exercised end to end against real
 * Postgres in `tests/integration/mood-prognosis-ladder.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/reminder/shared", () => ({
  getWorkerPrisma: () => ({
    moodEntry: { groupBy: groupByMock },
    moodPrediction: {
      findMany: predictionFindManyMock,
      deleteMany: deleteManyMock,
    },
  }),
}));

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: { addMeta: () => void }) => Promise<unknown>,
  ) => fn({ addMeta: () => {} }),
}));

const groupByMock = vi.fn();
const predictionFindManyMock = vi.fn();
const deleteManyMock = vi.fn();

import {
  handleMoodPrognosisRefresh,
  runMoodPrognosisRefresh,
} from "@/lib/jobs/mood-prognosis-refresh";
import {
  MOOD_PROGNOSIS_REFRESH_CRON,
  MOOD_PROGNOSIS_REFRESH_QUEUE,
} from "@/lib/jobs/mood-prognosis-refresh-queue";
import { MIN_ENTRIES_FOR_FORECAST } from "@/lib/analytics/mood-prognosis/thresholds";

const NOW = new Date("2026-08-08T02:35:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  groupByMock.mockResolvedValue([
    { userId: "user-1", _count: { _all: MIN_ENTRIES_FOR_FORECAST } },
    { userId: "user-2", _count: { _all: 120 } },
  ]);
  predictionFindManyMock.mockResolvedValue([]);
  deleteManyMock.mockResolvedValue({ count: 0 });
});

describe("mood-prognosis-refresh", () => {
  it("runs at 04:35, in the slot the neighbouring jobs leave free", () => {
    expect(MOOD_PROGNOSIS_REFRESH_CRON).toBe("35 4 * * *");
    expect(MOOD_PROGNOSIS_REFRESH_QUEUE).toBe("mood-prognosis-refresh");
  });

  it("refreshes every eligible account", async () => {
    const refresh = vi.fn(async () => ({ rows: 7, refusal: null }));
    const summary = await runMoodPrognosisRefresh(NOW, { refresh });

    expect(summary.scanned).toBe(2);
    // The count is the point: a cohort query that matched nothing would
    // satisfy "no bad rows" exactly as well as a working sweep.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith("user-1", NOW);
    expect(summary.refreshed).toBe(2);
    expect(summary.rowsWritten).toBe(14);
  });

  it("leaves an account below the entry cut out of the cohort", async () => {
    groupByMock.mockResolvedValue([
      { userId: "user-1", _count: { _all: MIN_ENTRIES_FOR_FORECAST - 1 } },
    ]);
    const refresh = vi.fn(async () => ({ rows: 1, refusal: null }));
    const summary = await runMoodPrognosisRefresh(NOW, { refresh });

    expect(summary.scanned).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("still visits an account that holds rows but no longer qualifies", async () => {
    groupByMock.mockResolvedValue([]);
    predictionFindManyMock.mockResolvedValue([{ userId: "user-stale" }]);
    const refresh = vi.fn(async () => ({
      rows: 0,
      refusal: "too-few-days" as const,
    }));

    const summary = await runMoodPrognosisRefresh(NOW, { refresh });

    // Without this arm the account would keep its forecast forever: it is not
    // in the eligible set any more, so nothing would ever come back for it.
    expect(summary.scanned).toBe(1);
    expect(refresh).toHaveBeenCalledWith("user-stale", NOW);
    expect(summary.refused).toBe(1);
    expect(summary.refreshed).toBe(0);
  });

  it("computes nothing and stores nothing while the module is off, and clears what it stored before", async () => {
    const refresh = vi.fn(async () => ({ rows: 7, refusal: null }));
    const summary = await runMoodPrognosisRefresh(NOW, {
      isAvailable: async () => false,
      refresh,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(summary.moduleOff).toBe(2);
    expect(summary.rowsWritten).toBe(0);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(deleteManyMock).toHaveBeenCalledTimes(2);
  });

  it("counts an account whose pass throws and carries on", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad rows"))
      .mockResolvedValueOnce({ rows: 3, refusal: null });

    const summary = await runMoodPrognosisRefresh(NOW, { refresh });

    expect(summary.failed).toBe(1);
    expect(summary.refreshed).toBe(1);
    expect(summary.rowsWritten).toBe(3);
  });

  it("fails the job only when every account failed", async () => {
    const outcome = await handleMoodPrognosisRefresh([]);
    // The default refresh path reaches the real loader, which the mocked
    // client cannot serve, so every account throws — which is exactly the
    // all-accounts case.
    expect(outcome.ok).toBe(false);
  });
});
