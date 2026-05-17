import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
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
import { generateBmiStatusForUser } from "../bmi-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generateBmiStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} BMI series derived from bucketed weight", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
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

    await generateBmiStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const bmi = snapshot.bmi.series;
    expect(bmi).toHaveProperty("daily");
    expect(bmi).toHaveProperty("monthly");
    expect(bmi.daily.length).toBeGreaterThan(0);
    expect(bmi.monthly.length).toBeGreaterThan(0);
    expect(bmi.daily[0]).toHaveProperty("dayOffset");
    expect(bmi.daily[0]).toHaveProperty("value");
    expect(bmi.daily[0]).toHaveProperty("n");
    expect(bmi.monthly[0]).toHaveProperty("monthOffset");
    expect(bmi.monthly[0]).toHaveProperty("value");
    expect(bmi.monthly[0]).toHaveProperty("n");
  });
});

describe("generateBmiStatusForUser — v1.4.37 timeout-stub persistence", () => {
  it("persists a sentinel row keyed to today when the provider times out", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 80, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    // Simulate a provider that never resolves before the timeout. The
    // helper races the call against `STATUS_PROVIDER_TIMEOUT_MS`; a
    // promise that hangs forever cuts the race short.
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(
        () => new Promise(() => {
          /* never resolves */
        }),
      ),
    } as never);

    // Shrink the timeout window so this test does not hang the suite
    // for the full 20 s. The withTimeout helper polls in ~1 s
    // increments; this still exercises the same race shape.
    vi.useFakeTimers();
    const promise = generateBmiStatusForUser("user-1", { locale: "en" });
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await promise;
    vi.useRealTimers();

    // The user-facing payload still reads the deterministic no-key
    // fallback, but the cached/updatedAt fields signal "this is a
    // stub" so the next mount short-circuits at the cache lookup.
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
    // The dateKey must read as a valid YYYY-MM-DD so the cache hit
    // logic on the next mount matches against today's berlin key.
    expect(parsed.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("subsequent mounts short-circuit at the cache lookup and skip the race", async () => {
    // First mount: cache miss, provider times out, stub persisted.
    // Simulate that prior state by handing back the stub row from
    // findFirst on the second invocation.
    const stubRow = {
      createdAt: new Date(),
      details: JSON.stringify({
        dateKey: new Intl.DateTimeFormat("en-US", {
          timeZone: "Europe/Berlin",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(new Date())
          .reduce<Record<string, string>>((acc, p) => {
            if (p.type !== "literal") acc[p.type] = p.value;
            return acc;
          }, {}),
        locale: "en",
        text: "BMI is a directional metric…",
        timeout: true,
      }),
    };
    // Build a real YYYY-MM-DD string the same way the source helper
    // does so the cache-key match is exact.
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
    stubRow.details = JSON.stringify({
      dateKey: todayKey,
      locale: "en",
      text: "BMI is a directional metric…",
      timeout: true,
    });

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(stubRow as never);
    const providerCall = vi.fn();
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: providerCall,
    } as never);

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });

    // Cache short-circuit fires before the provider call — no race,
    // no second persist.
    expect(providerCall).not.toHaveBeenCalled();
    expect(result.text).toBe("BMI is a directional metric…");
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBe(stubRow.createdAt.toISOString());
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("generateBmiStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 80, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async () => ({
        content:
          '{"summary":"BMI sits in the green band. metric:WEIGHT and steady."}',
        model: "x",
        tokensUsed: 1,
      })),
    } as never);

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });

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
