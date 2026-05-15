import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
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

vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import { getMedicationCategories } from "@/lib/medication-category";
import { generateBloodPressureStatusForUser } from "../blood-pressure-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMedicationCategories).mockResolvedValue({});
});

describe("generateBloodPressureStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} per metric series with correct field shape", async () => {
    const now = new Date();

    // 3 years of SYS data — covers daily window + monthly window.
    const records: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        type: "BLOOD_PRESSURE_SYS",
        value: 120 + (day % 10),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
      records.push({
        type: "BLOOD_PRESSURE_DIA",
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
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

    await generateBloodPressureStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const sys = snapshot.bloodPressure.systolic.series;
    expect(sys).toHaveProperty("daily");
    expect(sys).toHaveProperty("monthly");
    expect(sys.daily.length).toBeGreaterThan(0);
    expect(sys.monthly.length).toBeGreaterThan(0);
    expect(sys.daily[0]).toHaveProperty("dayOffset");
    expect(sys.daily[0]).toHaveProperty("value");
    expect(sys.daily[0]).toHaveProperty("n");
    expect(sys.monthly[0]).toHaveProperty("monthOffset");
    expect(sys.monthly[0]).toHaveProperty("value");
    expect(sys.monthly[0]).toHaveProperty("n");

    const dia = snapshot.bloodPressure.diastolic.series;
    expect(dia.daily.length).toBeGreaterThan(0);
    expect(dia.monthly.length).toBeGreaterThan(0);
  });
});

describe("generateBloodPressureStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "BLOOD_PRESSURE_SYS", value: 132, measuredAt: new Date() },
      { type: "BLOOD_PRESSURE_DIA", value: 84, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
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
          '{"summary":"Systolic averaged 132. metric:BLOOD_PRESSURE_SYS Diastolic stable. metric:BLOOD_PRESSURE_DIA"}',
        model: "x",
        tokensUsed: 1,
      })),
    } as never);

    const result = await generateBloodPressureStatusForUser("user-1", {
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
