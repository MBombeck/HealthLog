import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
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
import { generateMedicationComplianceStatusForUser } from "../medication-compliance-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMedicationCategories).mockResolvedValue({});
});

describe("generateMedicationComplianceStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} compliance series per medication spanning 3 years", async () => {
    const now = new Date();
    const medication = {
      id: "med-1",
      name: "TestMed",
      dose: "5mg",
      active: true,
      createdAt: new Date(now.getTime() - 1100 * dayMs),
      schedules: [{ id: "s1", time: "08:00" }],
    };

    const events: Array<{
      medicationId: string;
      scheduledFor: Date;
      takenAt: Date | null;
      skipped: boolean;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      const scheduledFor = new Date(now.getTime() - day * dayMs);
      events.push({
        medicationId: "med-1",
        scheduledFor,
        takenAt: day % 3 === 0 ? null : scheduledFor,
        skipped: false,
      });
    }

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medication,
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      events as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async (args: { userPrompt: string }) => {
        captured.userPrompt = args.userPrompt;
        return {
          content: '{"summary":"OK","medications":[]}',
          model: "x",
          tokensUsed: 1,
        };
      }),
    } as never);

    await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    expect(snapshot.medications).toBeInstanceOf(Array);
    expect(snapshot.medications.length).toBe(1);
    const dailySeries = snapshot.medications[0].dailySeries;
    expect(dailySeries).toHaveProperty("daily");
    expect(dailySeries).toHaveProperty("monthly");
    expect(dailySeries.daily.length).toBeGreaterThan(0);
    expect(dailySeries.monthly.length).toBeGreaterThan(0);
    expect(dailySeries.daily[0]).toHaveProperty("dayOffset");
    expect(dailySeries.daily[0]).toHaveProperty("value");
    expect(dailySeries.daily[0]).toHaveProperty("n");
    expect(dailySeries.monthly[0]).toHaveProperty("monthOffset");
    expect(dailySeries.monthly[0]).toHaveProperty("value");
    expect(dailySeries.monthly[0]).toHaveProperty("n");
  });
});

describe("generateMedicationComplianceStatusForUser — v1.4.41 timeout-stub persistence", () => {
  it("persists a sentinel row keyed to today when the provider times out", async () => {
    const now = new Date();
    const medication = {
      id: "med-1",
      name: "Ramipril",
      dose: "5mg",
      active: true,
      createdAt: new Date(now.getTime() - 60 * dayMs),
      schedules: [{ id: "s1", time: "08:00" }],
    };

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medication,
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

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
    const promise = generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await promise;
    vi.useRealTimers();

    // Route returns the richer `{summary, medications}` shape — the
    // helper writes the persist row and the route maps `summary` ←
    // `text` on the way out.
    expect(result.summary).toBeTruthy();
    expect(result.medications).toEqual([]);
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
});

describe("generateMedicationComplianceStatusForUser — v1.4.41 timeout-stub short-circuit", () => {
  it("subsequent mounts short-circuit when a stub row with text+timeout:true exists", async () => {
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
        text: "Medication compliance fallback…",
        timeout: true,
      }),
    };

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(stubRow as never);
    const providerCall = vi.fn();
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: providerCall,
    } as never);

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(providerCall).not.toHaveBeenCalled();
    expect(result.summary).toBe("Medication compliance fallback…");
    expect(result.medications).toEqual([]);
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBe(stubRow.createdAt.toISOString());
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("generateMedicationComplianceStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached summary + per-medication text", async () => {
    const now = new Date();
    const medication = {
      id: "med-1",
      name: "Ramipril",
      dose: "5mg",
      active: true,
      createdAt: new Date(now.getTime() - 60 * dayMs),
      schedules: [{ id: "s1", time: "08:00" }],
    };

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medication,
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async () => ({
        content: JSON.stringify({
          summary:
            "Compliance held steady at 96%. metric:BLOOD_PRESSURE_SYS over the last 30 days.",
          medications: [
            {
              medicationId: "med-1",
              summary:
                "Ramipril taken on schedule. metric:PULSE no missed doses in 30 days.",
            },
          ],
        }),
        model: "x",
        tokensUsed: 1,
      })),
    } as never);

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.summary).toBeTruthy();
    expect(result.summary).not.toContain("metric:");
    expect(result.medications[0].text).not.toContain("metric:");
    const createCalls = vi.mocked(prisma.auditLog.create).mock.calls;
    expect(createCalls.length).toBeGreaterThan(0);
    const details = (createCalls[0][0] as { data: { details: string } }).data
      .details;
    const parsed = JSON.parse(details) as {
      summary: string;
      medications: Array<{ text: string }>;
    };
    expect(parsed.summary).not.toContain("metric:");
    expect(parsed.medications[0].text).not.toContain("metric:");
  });
});
