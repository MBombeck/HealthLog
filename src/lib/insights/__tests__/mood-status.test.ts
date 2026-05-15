import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn(),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import { generateMoodStatusForUser } from "../mood-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generateMoodStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} mood series spanning 3 years", async () => {
    const now = new Date();
    const entries: Array<{
      date: string;
      score: number;
      tags: string[];
      moodLoggedAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      const t = new Date(now.getTime() - day * dayMs);
      entries.push({
        // production code keys mood buckets by `moodLoggedAt`, so the
        // `date` string here is irrelevant for bucketing — keep it
        // ISO-shaped so other downstream consumers don't choke.
        date: t.toISOString().slice(0, 10),
        score: 3 + (day % 3) * 0.5,
        tags: [],
        moodLoggedAt: t,
      });
    }

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue(entries as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async (args: { userPrompt: string }) => {
        captured.userPrompt = args.userPrompt;
        return {
          content: '{"summary":"OK"}',
          model: "x",
          tokensUsed: 1,
        };
      }),
    } as never);

    await generateMoodStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const mood = snapshot.mood.series;
    expect(mood).toHaveProperty("daily");
    expect(mood).toHaveProperty("monthly");
    expect(mood.daily.length).toBeGreaterThan(0);
    expect(mood.monthly.length).toBeGreaterThan(0);
    expect(mood.daily[0]).toHaveProperty("dayOffset");
    expect(mood.daily[0]).toHaveProperty("value");
    expect(mood.daily[0]).toHaveProperty("n");
    expect(mood.monthly[0]).toHaveProperty("monthOffset");
    expect(mood.monthly[0]).toHaveProperty("value");
    expect(mood.monthly[0]).toHaveProperty("n");
  });
});

describe("generateMoodStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    const t = new Date();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      { date: t.toISOString().slice(0, 10), score: 4, tags: [], moodLoggedAt: t },
    ] as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async () => ({
        content: '{"summary":"Mood stayed positive. metric:MOOD"}',
        model: "x",
        tokensUsed: 1,
      })),
    } as never);

    const result = await generateMoodStatusForUser("user-1", { locale: "en" });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const createCalls = vi.mocked(prisma.auditLog.create).mock.calls;
    expect(createCalls.length).toBeGreaterThan(0);
    const details = (createCalls[0][0] as { data: { details: string } }).data
      .details;
    const parsed = JSON.parse(details) as { text: string };
    expect(parsed.text).not.toContain("metric:");
  });
});
