import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generateMoodStatusForUser } from "../mood-status";

const dayMs = 24 * 60 * 60 * 1000;

function stubCompletion(
  content: string,
  capture?: { userPrompt: string | null },
) {
  vi.mocked(runStatusCompletion).mockImplementation(
    async (args: { userPrompt: string }) => {
      if (capture) capture.userPrompt = args.userPrompt;
      return {
        kind: "ok",
        content,
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never;
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generateMoodStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} mood series, not the full daily array", async () => {
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
    stubCompletion('{"summary":"OK"}', captured);

    await generateMoodStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const mood = snapshot.mood.series;
    expect(mood).toHaveProperty("recent");
    expect(mood).toHaveProperty("weekly");
    expect(mood).toHaveProperty("monthly");
    expect(mood).toHaveProperty("yearly");
    expect(mood.recent.length).toBeLessThanOrEqual(21);
    expect(mood.recent[0]).toHaveProperty("date");
    expect(mood.recent[0]).toHaveProperty("mean");
    expect(mood.monthly[0]).toHaveProperty("month");
    const total =
      mood.recent.length +
      mood.weekly.length +
      mood.monthly.length +
      mood.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("generateMoodStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
    const t = new Date();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      { date: t.toISOString().slice(0, 10), score: 4, tags: [], moodLoggedAt: t },
    ] as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateMoodStatusForUser("user-1", { locale: "en" });

    expect(result.text).toBeTruthy();
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBeNull();
    // v1.8.3 — no real assessment persisted (updatedAt stays null above),
    // but a short-TTL negative stub IS written so the read-only route does
    // not re-enqueue on every navigation while the provider is degraded.
    // The stub is a timeout marker that `readFreshStatusText` rejects.
    await Promise.resolve();
    for (const call of vi.mocked(prisma.auditLog.create).mock.calls) {
      const details = JSON.parse(
        (call[0] as { data: { details: string } }).data.details,
      );
      expect(details.timeout === true || details.model === "timeout-stub").toBe(
        true,
      );
    }
  });
});

describe("generateMoodStatusForUser — cache-read skips a stub", () => {
  it("regenerates when the only cached row is a timeout stub", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: now,
      details: JSON.stringify({
        dateKey: todayKey,
        locale: "en",
        text: "Mood fallback text…",
        model: "timeout-stub",
        timeout: true,
      }),
    } as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      { date: now.toISOString().slice(0, 10), score: 4, tags: [], moodLoggedAt: now },
    ] as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    stubCompletion('{"summary":"Fresh mood assessment."}');

    const result = await generateMoodStatusForUser("user-1", { locale: "en" });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh mood assessment.");
    expect(result.cached).toBe(false);
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

    stubCompletion('{"summary":"Mood stayed positive. metric:MOOD"}');

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
