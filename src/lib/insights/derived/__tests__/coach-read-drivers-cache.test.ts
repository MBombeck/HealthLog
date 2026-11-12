/**
 * The "Coach read" strip reads its pattern line from one cached scan per
 * record and language, not one scan per metric page: the scan covers every
 * channel and does not depend on the metric. A failed scan is not cached, a
 * write that sweeps the record's analytics cells forces a new one, and a
 * switched-off module reads under its own cell.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readCoachCorrelations = vi.fn();
const resolveModuleMap = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: async () => [],
      findFirst: async () => null,
    },
  },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: (userId: string) => resolveModuleMap(userId),
}));
vi.mock("@/lib/insights/derived/baseline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/insights/derived/baseline")>()),
  loadBaselineProfile: async () => ({ ageYears: 40, sex: "MALE" }),
  // The band is not what this file is about: no band, the strip says
  // "still learning" and only the pattern line varies.
  computeVitalsBaseline: async () => ({ status: "insufficient" }),
}));
vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: (userId: string, locale: string) =>
    readCoachCorrelations(userId, locale),
}));

import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";

const SLEEP_DRIVER = {
  behaviour: "symptom severity",
  outcome: "sleep duration",
  direction: "lower" as const,
  lagDays: 1,
  n: 40,
  r: -0.6,
  note: "A pattern to watch, not a cause.",
};
const PULSE_DRIVER = { ...SLEEP_DRIVER, outcome: "pulse" };

const strip = (type: "SLEEP_DURATION" | "PULSE", locale: "en" | "de" = "en") =>
  buildCoachReadStrip("u1", type, locale, { tz: "UTC" });

beforeEach(() => {
  __resetAllCachesForTests();
  readCoachCorrelations.mockReset().mockResolvedValue({
    present: true,
    drivers: [SLEEP_DRIVER, PULSE_DRIVER],
  });
  resolveModuleMap.mockReset().mockResolvedValue({});
});

describe("coach read: the pattern scan behind the strip", () => {
  it("scans once for two metric pages and picks each page's own driver", async () => {
    const sleep = await strip("SLEEP_DURATION");
    const pulse = await strip("PULSE");

    expect(readCoachCorrelations).toHaveBeenCalledTimes(1);
    expect(sleep.driver?.outcome).toBe("sleep duration");
    expect(pulse.driver?.outcome).toBe("pulse");
  });

  it("scans again per language, since the note is a finished sentence", async () => {
    await strip("SLEEP_DURATION", "en");
    await strip("SLEEP_DURATION", "de");

    expect(readCoachCorrelations).toHaveBeenCalledTimes(2);
    expect(readCoachCorrelations).toHaveBeenLastCalledWith("u1", "de");
  });

  it("does not keep a failed scan", async () => {
    readCoachCorrelations.mockResolvedValueOnce({
      present: false,
      reason: "retrieval_failed",
    });

    const failed = await strip("SLEEP_DURATION");
    const retried = await strip("SLEEP_DURATION");

    expect(failed.driver).toBeNull();
    expect(retried.driver?.outcome).toBe("sleep duration");
    expect(readCoachCorrelations).toHaveBeenCalledTimes(2);
  });

  it("scans again after a write sweeps the record's analytics cells", async () => {
    await strip("SLEEP_DURATION");
    invalidateUserMood("u1");
    await strip("SLEEP_DURATION");

    expect(readCoachCorrelations).toHaveBeenCalledTimes(2);
  });

  it("reads a switched-off module under its own cell", async () => {
    await strip("SLEEP_DURATION");
    resolveModuleMap.mockResolvedValue({ insights: false });
    readCoachCorrelations.mockResolvedValue({
      present: false,
      reason: "module_disabled",
    });

    const off = await strip("SLEEP_DURATION");

    expect(readCoachCorrelations).toHaveBeenCalledTimes(2);
    expect(off.driver).toBeNull();
  });
});
