import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * v1.4.28 R3a FB-D2 — provider timeout fallback for the pulse-status
 * route. When the upstream `generateCompletion` call does not resolve
 * inside the 20-second budget the route returns a deterministic
 * cached-style envelope so the InsightStatusCard renders the
 * fallback text instead of spinning behind React-Query's default
 * retries.
 *
 * v1.4.41 — the timeout branch now persists a sentinel keyed to
 * today (see `persistTimeoutStubAndReturn`) so subsequent mounts
 * short-circuit at the cache lookup. The persisted row carries
 * `timeout: true` + `model: "timeout-stub"` so the daily pre-warm
 * job can recognise and overwrite the stub instead of treating it
 * as a real assessment.
 */

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

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("generatePulseStatusForUser — provider timeout fallback", () => {
  it("returns a cached-style envelope when the provider exceeds 20 s", async () => {
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

    // Provider stalls indefinitely.
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(
        () => new Promise<{ content: string }>(() => {}),
      ),
    } as never);

    const promise = generatePulseStatusForUser("user-1", { locale: "en" });
    // Advance past the 20-second budget so the timeout race wins.
    await vi.advanceTimersByTimeAsync(21_000);
    const result = await promise;

    expect(result.hasProvider).toBe(true);
    expect(result.cached).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.text?.length ?? 0).toBeGreaterThan(0);
    // v1.4.41 — the timeout branch now persists a sentinel row so
    // subsequent mounts short-circuit at the cache lookup. The
    // daily pre-warm worker overwrites the stub by detecting
    // `timeout: true` + `model: "timeout-stub"`.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const createArg = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as {
      data: { details: string };
    };
    const parsed = JSON.parse(createArg.data.details) as {
      timeout?: boolean;
      model?: string;
    };
    expect(parsed.timeout).toBe(true);
    expect(parsed.model).toBe("timeout-stub");
  });
});
