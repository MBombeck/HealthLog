import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { getMedicationCategories } from "@/lib/medication-category";
import { generateMedicationComplianceStatusForUser } from "../medication-compliance-status";

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

function medFixture(now: Date) {
  return {
    id: "med-1",
    name: "Ramipril",
    dose: "5mg",
    active: true,
    createdAt: new Date(now.getTime() - 60 * dayMs),
    schedules: [
      { id: "s1", windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMedicationCategories).mockResolvedValue({});
});

describe("generateMedicationComplianceStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} compliance series per medication", async () => {
    const now = new Date();
    const medication = {
      id: "med-1",
      name: "TestMed",
      dose: "5mg",
      active: true,
      createdAt: new Date(now.getTime() - 1100 * dayMs),
      schedules: [
        { id: "s1", windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
      ],
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
    stubCompletion('{"summary":"OK","medications":[]}', captured);

    await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    expect(snapshot.medications).toBeInstanceOf(Array);
    expect(snapshot.medications.length).toBe(1);
    const dailySeries = snapshot.medications[0].dailySeries;
    expect(dailySeries).toHaveProperty("recent");
    expect(dailySeries).toHaveProperty("weekly");
    expect(dailySeries).toHaveProperty("monthly");
    expect(dailySeries).toHaveProperty("yearly");
    expect(dailySeries.recent.length).toBeLessThanOrEqual(21);
    expect(dailySeries.recent[0]).toHaveProperty("date");
    expect(dailySeries.recent[0]).toHaveProperty("mean");
    expect(dailySeries.monthly[0]).toHaveProperty("month");
  });
});

describe("generateMedicationComplianceStatusForUser — timeout never persists", () => {
  it("serves the fallback summary without writing a cache row on timeout", async () => {
    const now = new Date();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medFixture(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.summary).toBeTruthy();
    expect(result.medications).toEqual([]);
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

describe("generateMedicationComplianceStatusForUser — cache-read skips a stub", () => {
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
        text: "Medication compliance fallback…",
        model: "timeout-stub",
        timeout: true,
      }),
    } as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medFixture(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    stubCompletion('{"summary":"Fresh compliance assessment.","medications":[]}');

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe("Fresh compliance assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generateMedicationComplianceStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached summary", async () => {
    const now = new Date();

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medFixture(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    // The compliance prompt returns only a `{ summary }` envelope; the
    // per-medication cards are placeholder text built server-side, never
    // model-authored. So token-leak hardening only has to scrub `summary`.
    stubCompletion(
      JSON.stringify({
        summary:
          "Compliance held steady at 96%. metric:BLOOD_PRESSURE_SYS over the last 30 days.",
      }),
    );

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.summary).toBeTruthy();
    expect(result.summary).not.toContain("metric:");
    // A per-medication placeholder row is still surfaced for the active med.
    expect(result.medications).toHaveLength(1);
    expect(result.medications[0].medicationId).toBe("med-1");
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
