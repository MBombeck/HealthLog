import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
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
import { generateBloodPressureStatusForUser } from "../blood-pressure-status";

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
  vi.mocked(getMedicationCategories).mockResolvedValue({});
  // Cold rollup tier: the BP channels fold monthly/yearly from the
  // full-history `measurement.findMany` fallback on a tier miss.
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
});

describe("generateBloodPressureStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} per-metric series, not the full daily array", async () => {
    const now = new Date();

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
    stubCompletion('{"summary":"OK"}', captured);

    await generateBloodPressureStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const sys = snapshot.bloodPressure.systolic.series;
    expect(sys).toHaveProperty("recent");
    expect(sys).toHaveProperty("weekly");
    expect(sys).toHaveProperty("monthly");
    expect(sys).toHaveProperty("yearly");
    expect(sys.recent.length).toBeLessThanOrEqual(21);
    expect(sys.recent[0]).toHaveProperty("date");
    expect(sys.recent[0]).toHaveProperty("mean");
    expect(sys.monthly[0]).toHaveProperty("month");

    const dia = snapshot.bloodPressure.diastolic.series;
    expect(dia).toHaveProperty("recent");
    expect(dia).toHaveProperty("monthly");
    expect(dia.recent.length).toBeLessThanOrEqual(21);

    // Embedded correlation pair arrays are capped, not full-length.
    expect(snapshot.weightVsSystolic.pairs.length).toBeLessThanOrEqual(30);
  });
});

describe("generateBloodPressureStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
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

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateBloodPressureStatusForUser("user-1", {
      locale: "en",
    });

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

describe("generateBloodPressureStatusForUser — cache-read skips a stub", () => {
  it("regenerates when the only cached row is a timeout stub", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: now,
      details: JSON.stringify({
        dateKey: todayKey,
        locale: "en",
        text: "Blood pressure assessment fallback…",
        model: "timeout-stub",
        timeout: true,
      }),
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "BLOOD_PRESSURE_SYS", value: 132, measuredAt: now },
      { type: "BLOOD_PRESSURE_DIA", value: 84, measuredAt: now },
    ] as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    stubCompletion('{"summary":"Fresh BP assessment."}');

    const result = await generateBloodPressureStatusForUser("user-1", {
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh BP assessment.");
    expect(result.cached).toBe(false);
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

    stubCompletion(
      '{"summary":"Systolic averaged 132. metric:BLOOD_PRESSURE_SYS Diastolic stable. metric:BLOOD_PRESSURE_DIA"}',
    );

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
