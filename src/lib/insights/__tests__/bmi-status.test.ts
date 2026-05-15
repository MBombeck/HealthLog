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
