import { describe, it, expect, vi, beforeEach } from "vitest";

const checkRateLimit = vi.fn();
const getAssistantFlags = vi.fn();

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
vi.mock("@/lib/feature-flags", async () =>
  (
    await import("@/__tests__/helpers/assistant-switches-mock")
  ).mockAssistantSwitches(() => getAssistantFlags()),
);
// Never reach the real generator (which imports the provider chain).
vi.mock("@/lib/insights/narrative/period-narrative-generate", () => ({
  generatePeriodNarrative: vi.fn(),
}));
const annotate = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  annotate: (...a: unknown[]) => annotate(...a),
}));
const aiCapabilityForJob = vi.fn();
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: (...a: unknown[]) => aiCapabilityForJob(...a),
  aiCapabilityForRecord: vi.fn(),
}));

import {
  runPeriodNarrativeWarm,
  periodsForDay,
  findNarrativeCandidates,
  PERIOD_NARRATIVE_QUEUE,
  PERIOD_NARRATIVE_CRON,
} from "../period-narrative-warm";
import { PERIOD_NARRATIVE_EXPIRE_SECONDS } from "../period-narrative-queue";
import { handlePeriodNarrative } from "../reminder/status-handlers";
import { insightRetryOptions } from "../reminder/registrar-shared";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "../registry/__tests__/registry-helpers";

function makePrisma(
  users: Array<{ id: string; locale: string | null }>,
  narrativeWrites: Array<{ userId: string; updatedAt: Date }> = [],
  optedOut: string[] = [],
) {
  const findMany = vi.fn().mockResolvedValue(users);
  const queryRaw = vi.fn().mockResolvedValue(optedOut.map((id) => ({ id })));
  const groupBy = vi.fn().mockResolvedValue(
    narrativeWrites.map((row) => ({
      userId: row.userId,
      _max: { updatedAt: row.updatedAt },
    })),
  );
  return {
    prisma: {
      user: { findMany },
      insightNarrative: { groupBy },
      $queryRaw: queryRaw,
    },
    findMany,
    groupBy,
    queryRaw,
  };
}

// A Monday that is also the 1st of the month — both periods warm.
const MON_FIRST = new Date("2026-06-01T03:05:00.000Z");
// A plain Tuesday mid-month — no boundary.
const TUE_MID = new Date("2026-06-02T03:05:00.000Z");
// A Monday that is not the 1st — week only.
const MON_MID = new Date("2026-06-08T03:05:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  getAssistantFlags.mockResolvedValue({
    enabled: true,
    briefing: true,
    insightStatus: true,
  });
  checkRateLimit.mockResolvedValue({ allowed: true });
  aiCapabilityForJob.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
});

describe("periodsForDay — boundary gate", () => {
  it("warms week on a Monday", () => {
    expect(periodsForDay(MON_MID)).toContain("week");
    expect(periodsForDay(MON_MID)).not.toContain("month");
  });
  it("warms month on the 1st", () => {
    expect(periodsForDay(MON_FIRST)).toContain("month");
  });
  it("warms nothing on a plain mid-week day", () => {
    expect(periodsForDay(TUE_MID)).toEqual([]);
  });
});

describe("findNarrativeCandidates", () => {
  it("drops the users who switched AI analysis off, not the Coach-hidden ones", async () => {
    const { prisma, findMany, groupBy, queryRaw } = makePrisma(
      [{ id: "u1", locale: "de" }],
      [],
      ["opted-out"],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findNarrativeCandidates(prisma as any, 50);
    expect(queryRaw.mock.calls[0].slice(1)).toContain("insights");
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      deletionRequestedAt: null,
      id: { notIn: ["opted-out"] },
    });
    expect(arg.where.disableCoach).toBeUndefined();
    expect(result).toEqual([{ id: "u1", locale: "de" }]);
    // Below the cap the ordering aggregate never runs.
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("serves never-warmed and oldest-narrative users first when the cap bites", async () => {
    const { prisma, groupBy } = makePrisma(
      [
        { id: "fresh", locale: "de" },
        { id: "stale", locale: "de" },
        { id: "never", locale: "de" },
      ],
      [
        { userId: "fresh", updatedAt: new Date("2026-06-09T05:00:00Z") },
        { userId: "stale", updatedAt: new Date("2026-05-01T05:00:00Z") },
      ],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findNarrativeCandidates(prisma as any, 2);
    expect(groupBy).toHaveBeenCalledTimes(1);
    // never-warmed first (no narrative row), then the staleest write;
    // the freshest user falls past the cap.
    expect(result.map((c) => c.id)).toEqual(["never", "stale"]);
  });
});

describe("runPeriodNarrativeWarm", () => {
  it("is a no-op on a non-boundary night (no generation)", async () => {
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: TUE_MID, generate },
    );
    expect(result.periods).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("generates the boundary periods for each candidate, gated by budget", async () => {
    const { prisma } = makePrisma([
      { id: "u1", locale: "de" },
      { id: "u2", locale: "en" },
    ]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "openai" });
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: MON_FIRST, generate },
    );
    expect(result.periods.sort()).toEqual(["month", "week"]);
    // 2 users × 2 periods.
    expect(generate).toHaveBeenCalledTimes(4);
    expect(result.generated).toBe(4);
    // Budget bucket checked once per user.
    expect(checkRateLimit).toHaveBeenCalledTimes(2);
  });

  it("skips a budget-blocked user without generating", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const generate = vi.fn();
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: MON_MID, generate },
    );
    expect(result.budgetBlocked).toBe(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("skips a user whose periodNarrative capability is unavailable before the budget write", async () => {
    const { prisma } = makePrisma([
      { id: "off", locale: "de" },
      { id: "on", locale: "de" },
    ]);
    aiCapabilityForJob.mockImplementation(async (userId: string) =>
      userId === "off"
        ? { available: false, reason: "no_provider", onDeviceAllowed: true }
        : { available: true, reason: null, onDeviceAllowed: true },
    );
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "openai" });
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: MON_MID, generate },
    );
    expect(aiCapabilityForJob).toHaveBeenCalledWith("off", "periodNarrative");
    expect(result.skipped).toBe(1);
    expect(result.budgetBlocked).toBe(0);
    // Only the available user reaches the budget bucket and the generator.
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit.mock.calls[0][0]).toBe("period-narrative:on");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toBe("on");
    expect(annotate).toHaveBeenCalledWith({
      action: { name: "insights.narrative.warm.skipped" },
      meta: { reason: "no_provider" },
    });
  });

  it("short-circuits when the briefing surface is disabled", async () => {
    getAssistantFlags.mockResolvedValueOnce({
      enabled: false,
      briefing: false,
      insightStatus: false,
    });
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();
    const result = await runPeriodNarrativeWarm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      { now: MON_FIRST, generate },
    );
    expect(result.periods).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("queue registration", () => {
  it("declares the queue in the status group", () => {
    expect(groupOf(PERIOD_NARRATIVE_QUEUE).name).toBe("status");
  });

  it("schedules the cron with the retry policy", () => {
    const job = jobOf(PERIOD_NARRATIVE_QUEUE);
    expect(job.cron).toBe(PERIOD_NARRATIVE_CRON);
    expect(job.scheduleOptions).toEqual({
      ...insightRetryOptions,
      expireInSeconds: PERIOD_NARRATIVE_EXPIRE_SECONDS,
    });
  });

  it("binds the warm handler to the queue", async () => {
    expect(await loadedHandler(PERIOD_NARRATIVE_QUEUE)).toBe(
      handlePeriodNarrative,
    );
  });

  it("exposes a sane queue name + nightly cron", () => {
    expect(PERIOD_NARRATIVE_QUEUE).toBe("period-narrative-warm");
    expect(PERIOD_NARRATIVE_CRON).toMatch(/^\d+\s+\d+\s+\*\s+\*\s+\*$/);
  });
});
