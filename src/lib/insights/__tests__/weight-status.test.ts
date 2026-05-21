import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
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
import { generateWeightStatusForUser } from "../weight-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generateWeightStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} weight series with bucket fields", async () => {
    const now = new Date();
    const records: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        type: "WEIGHT",
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
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

    await generateWeightStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const weight = snapshot.weight.series;
    expect(weight).toHaveProperty("daily");
    expect(weight).toHaveProperty("monthly");
    expect(weight.daily.length).toBeGreaterThan(0);
    expect(weight.monthly.length).toBeGreaterThan(0);
    expect(weight.daily[0]).toHaveProperty("dayOffset");
    expect(weight.daily[0]).toHaveProperty("value");
    expect(weight.daily[0]).toHaveProperty("n");
    expect(weight.monthly[0]).toHaveProperty("monthOffset");
    expect(weight.monthly[0]).toHaveProperty("value");
    expect(weight.monthly[0]).toHaveProperty("n");
  });
});

describe("generateWeightStatusForUser — v1.4.41 timeout-stub persistence", () => {
  it("persists a sentinel row keyed to today when the provider times out", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    // Provider stalls indefinitely so the timeout race wins.
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      ),
    } as never);

    vi.useFakeTimers();
    const promise = generateWeightStatusForUser("user-1", { locale: "en" });
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.text).toBeTruthy();
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBeTruthy();

    const createCalls = vi.mocked(prisma.auditLog.create).mock.calls;
    expect(createCalls.length).toBe(1);
    const details = (createCalls[0][0] as { data: { details: string } }).data
      .details;
    const parsed = JSON.parse(details) as {
      dateKey?: string;
      text?: string;
      timeout?: boolean;
      model?: string;
    };
    expect(parsed.text).toBeTruthy();
    expect(parsed.timeout).toBe(true);
    expect(parsed.model).toBe("timeout-stub");
    expect(parsed.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("subsequent mounts short-circuit at the cache lookup and skip the race", async () => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")!.value;
    const m = parts.find((p) => p.type === "month")!.value;
    const d = parts.find((p) => p.type === "day")!.value;
    const todayKey = `${y}-${m}-${d}`;
    const stubRow = {
      createdAt: new Date(),
      details: JSON.stringify({
        dateKey: todayKey,
        locale: "en",
        text: "Weight is a directional metric…",
        timeout: true,
      }),
    };

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(stubRow as never);
    const providerCall = vi.fn();
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: providerCall,
    } as never);

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
    });

    expect(providerCall).not.toHaveBeenCalled();
    expect(result.text).toBe("Weight is a directional metric…");
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBe(stubRow.createdAt.toISOString());
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("generateWeightStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async () => ({
        content:
          '{"summary":"Weight trended down 0.4 kg last week. metric:WEIGHT"}',
        model: "x",
        tokensUsed: 1,
      })),
    } as never);

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
    });

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
