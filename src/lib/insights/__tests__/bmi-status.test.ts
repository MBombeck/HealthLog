import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
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
import { generateBmiStatusForUser } from "../bmi-status";

const dayMs = 24 * 60 * 60 * 1000;

/** A `runStatusCompletion` stub returning fixed content, capturing the prompt. */
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
  // Cold rollup tier: the BMI graded series scales the WEIGHT tier, which
  // folds from the full-history `measurement.findMany` fallback on a miss.
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
});

describe("generateBmiStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} BMI series, not the full daily array", async () => {
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
    stubCompletion('{"summary":"OK"}', captured);

    await generateBmiStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const bmi = snapshot.bmi.series;
    expect(bmi).toHaveProperty("recent");
    expect(bmi).toHaveProperty("weekly");
    expect(bmi).toHaveProperty("monthly");
    expect(bmi).toHaveProperty("yearly");
    expect(bmi.recent.length).toBeLessThanOrEqual(21);
    expect(bmi.recent[0]).toHaveProperty("date");
    expect(bmi.recent[0]).toHaveProperty("mean");
    expect(bmi.monthly[0]).toHaveProperty("month");
    const total =
      bmi.recent.length +
      bmi.weekly.length +
      bmi.monthly.length +
      bmi.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("generateBmiStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
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

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });

    // The user-facing payload reads the deterministic fallback, but
    // NOTHING is persisted — so the next mount re-attempts a real
    // generation instead of sticking the fallback for the day.
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

  it("serves the fallback without writing a cache row on provider error", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 80, measuredAt: new Date() },
    ] as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "error",
    } as never);

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });
    expect(result.text).toBeTruthy();
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

describe("generateBmiStatusForUser — cache-read skips a stub", () => {
  it("regenerates when the only cached row is a timeout stub", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    // The most recent cached row is a stub keyed to today.
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: now,
      details: JSON.stringify({
        dateKey: todayKey,
        locale: "en",
        text: "Generic stub fallback.",
        model: "timeout-stub",
        timeout: true,
      }),
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 80, measuredAt: now },
    ] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    stubCompletion('{"summary":"Fresh real assessment."}');

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });

    // The stub must NOT be served — a fresh generation runs instead.
    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh real assessment.");
    expect(result.cached).toBe(false);
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

    stubCompletion(
      '{"summary":"BMI sits in the green band. metric:WEIGHT and steady."}',
    );

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
