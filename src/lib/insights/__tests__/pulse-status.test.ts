import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
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
import { generatePulseStatusForUser } from "../pulse-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generatePulseStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} pulse series with dayOffset/monthOffset/value/n", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        value: 70 + (day % 8),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
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

    await generatePulseStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const pulse = snapshot.pulse.series;
    expect(pulse).toHaveProperty("daily");
    expect(pulse).toHaveProperty("monthly");
    expect(pulse.daily.length).toBeGreaterThan(0);
    expect(pulse.monthly.length).toBeGreaterThan(0);
    expect(pulse.daily[0]).toHaveProperty("dayOffset");
    expect(pulse.daily[0]).toHaveProperty("value");
    expect(pulse.daily[0]).toHaveProperty("n");
    expect(pulse.monthly[0]).toHaveProperty("monthOffset");
    expect(pulse.monthly[0]).toHaveProperty("value");
    expect(pulse.monthly[0]).toHaveProperty("n");
  });
});

describe("generatePulseStatusForUser — v1.4.41 timeout-stub short-circuit", () => {
  // The persist-on-timeout path is covered by
  // `pulse-status-timeout.test.ts`. This block pins the second-mount
  // behaviour: when a sentinel row already exists for today the cache
  // lookup short-circuits and the provider is never invoked.
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
        text: "Pulse fallback text…",
        timeout: true,
      }),
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(stubRow as never);
    const providerCall = vi.fn();
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: providerCall,
    } as never);

    const result = await generatePulseStatusForUser("user-1", { locale: "en" });

    expect(providerCall).not.toHaveBeenCalled();
    expect(result.text).toBe("Pulse fallback text…");
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBe(stubRow.createdAt.toISOString());
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("generatePulseStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 72, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async () => ({
        content:
          '{"summary":"Your pulse is stable. metric:PULSE The 7-day average sits inside the band."}',
        model: "x",
        tokensUsed: 1,
      })),
    } as never);

    const result = await generatePulseStatusForUser("user-1", { locale: "en" });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const createCalls = vi.mocked(prisma.auditLog.create).mock.calls;
    expect(createCalls.length).toBeGreaterThan(0);
    const details = (createCalls[0][0] as { data: { details: string } }).data
      .details;
    const parsed = JSON.parse(details) as { text: string };
    expect(parsed.text).not.toContain("metric:");
    expect(parsed.text).toContain("Your pulse is stable.");
  });
});
