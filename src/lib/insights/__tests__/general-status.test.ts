import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
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
import { generateGeneralStatusForUser } from "../general-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generateGeneralStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} per metric series with dayOffset/monthOffset/value/n", async () => {
    const now = new Date();

    // 3 years of weight data — daily across the whole window so the
    // bucketed output covers months 1-12 (daily) and 13-36 (monthly).
    const weightRecords: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      weightRecords.push({
        type: "WEIGHT",
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(
      weightRecords as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
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

    await generateGeneralStatusForUser("user-1", { locale: "en" });

    expect(captured.userPrompt).not.toBeNull();
    // The snapshot JSON is embedded in the user prompt as a fenced block.
    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const snapshot = JSON.parse(match![0]);

    const weight = snapshot.measurementSeries.WEIGHT.series;
    expect(weight).toHaveProperty("daily");
    expect(weight).toHaveProperty("monthly");
    expect(Array.isArray(weight.daily)).toBe(true);
    expect(Array.isArray(weight.monthly)).toBe(true);
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

describe("generateGeneralStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async () => ({
        content:
          '{"summary":"Weight trended down. metric:WEIGHT BP stable. metric:BLOOD_PRESSURE_SYS"}',
        model: "x",
        tokensUsed: 1,
      })),
    } as never);

    const result = await generateGeneralStatusForUser("user-1", {
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
