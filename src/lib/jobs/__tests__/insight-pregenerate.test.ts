/**
 * v1.7.0 W6 — unit tests for the nightly insight pre-generation cron.
 *
 * Covers:
 *   - the discovery query selects only coach-enabled, stale-cache users;
 *   - the per-user budget gate blocks a user already generated today;
 *   - the master assistant kill-switch short-circuits the whole run;
 *   - the generator outcomes tally correctly (generated / cached /
 *     skipped / failed);
 *   - the queue is registered in `allQueues` AND scheduled in
 *     reminder-worker.ts (the v1.4.37 W10 unregistered-queue catch).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const checkRateLimit = vi.fn();
const getAssistantFlags = vi.fn();

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
vi.mock("@/lib/feature-flags", () => ({
  getAssistantFlags: (...a: unknown[]) => getAssistantFlags(...a),
}));
// Never reach the real generator (which would import the provider chain).
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  generateComprehensiveInsight: vi.fn(),
}));

import {
  runInsightPregenerate,
  findPregenerateCandidates,
  PREGENERATE_STALE_MS,
  INSIGHT_PREGENERATE_QUEUE,
  INSIGHT_PREGENERATE_CRON,
} from "../insight-pregenerate";

function makePrisma(users: Array<{ id: string; locale: string | null }>) {
  const findMany = vi.fn().mockResolvedValue(users);
  return {
    prisma: { user: { findMany } },
    findMany,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAssistantFlags.mockResolvedValue({ enabled: true, briefing: true });
  checkRateLimit.mockResolvedValue({ allowed: true });
});

describe("findPregenerateCandidates", () => {
  it("filters on disableCoach=false + stale-or-null cache, oldest-first, capped", async () => {
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const now = new Date("2026-05-31T04:30:00.000Z");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findPregenerateCandidates(prisma as any, now, 50);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.disableCoach).toBe(false);
    expect(arg.where.OR).toEqual([
      { insightsCachedAt: null },
      {
        insightsCachedAt: {
          lt: new Date(now.getTime() - PREGENERATE_STALE_MS),
        },
      },
    ]);
    expect(arg.orderBy).toEqual({ insightsCachedAt: "asc" });
    expect(arg.take).toBe(50);
  });
});

describe("runInsightPregenerate — kill switch", () => {
  it("short-circuits when the briefing surface is disabled globally", async () => {
    getAssistantFlags.mockResolvedValue({ enabled: false, briefing: false });
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result.total).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("runInsightPregenerate — budget gate", () => {
  it("skips a user whose per-user budget bucket is exhausted and never calls the generator for them", async () => {
    const { prisma } = makePrisma([
      { id: "u1", locale: "de" },
      { id: "u2", locale: "en" },
    ]);
    // u1 blocked, u2 allowed.
    checkRateLimit
      .mockResolvedValueOnce({ allowed: false })
      .mockResolvedValueOnce({ allowed: true });
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result.total).toBe(2);
    expect(result.budgetBlocked).toBe(1);
    expect(result.generated).toBe(1);
    // The budget gate uses a dedicated bucket key, not the route bucket.
    expect(checkRateLimit).toHaveBeenCalledWith(
      "insight-pregenerate:u1",
      1,
      expect.any(Number),
    );
    // Only u2 reached the generator.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("u2", {
      locale: "en",
      force: true,
    });
  });
});

describe("runInsightPregenerate — force flag", () => {
  it("forces a fresh generation so the 20-24h cache window is not short-circuited to `cached`", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });

    await runInsightPregenerate(prisma as never, { generate });

    // The cron's discovery window (20 h) is shorter than the
    // generator's 24 h TTL; `force: true` bypasses the TTL re-check so
    // a 20-24h-old cache actually regenerates rather than returning
    // `cached` and wasting the budget bucket.
    expect(generate).toHaveBeenCalledWith("u1", {
      locale: "de",
      force: true,
    });
  });
});

describe("runInsightPregenerate — outcome tally", () => {
  it("tallies generated / cached / skipped / failed", async () => {
    const { prisma } = makePrisma([
      { id: "a", locale: "de" },
      { id: "b", locale: "de" },
      { id: "c", locale: "de" },
      { id: "d", locale: null },
    ]);
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ status: "generated", providerType: "x" })
      .mockResolvedValueOnce({ status: "cached" })
      .mockResolvedValueOnce({ status: "skipped", reason: "no-provider" })
      .mockResolvedValueOnce({ status: "failed", reason: "provider-error" });

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result).toMatchObject({
      total: 4,
      generated: 1,
      cached: 1,
      skipped: 1,
      failed: 1,
      budgetBlocked: 0,
    });
    // Locale defaulting: null → "de".
    expect(generate).toHaveBeenLastCalledWith("d", {
      locale: "de",
      force: true,
    });
  });
});

describe("queue registration", () => {
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, "../reminder-worker.ts"),
    "utf8",
  );

  it("registers the queue name in the allQueues createQueue loop", () => {
    const match = workerSrc.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/\bINSIGHT_PREGENERATE_QUEUE\b/);
  });

  it("schedules the cron in the schedules table", () => {
    expect(workerSrc).toMatch(
      /\[\s*INSIGHT_PREGENERATE_QUEUE\s*,\s*INSIGHT_PREGENERATE_CRON\s*\]/,
    );
  });

  it("registers a boss.work handler for the queue", () => {
    expect(workerSrc).toMatch(
      /boss\.work[\s\S]{0,80}INSIGHT_PREGENERATE_QUEUE/,
    );
  });

  it("exposes a sane queue name + nightly cron", () => {
    expect(INSIGHT_PREGENERATE_QUEUE).toBe("insight-pregenerate");
    // Minute Hour … — nightly single tick.
    expect(INSIGHT_PREGENERATE_CRON).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});
