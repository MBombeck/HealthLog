/**
 * Wave 1D — the per-card status path delivers the REAL provider text.
 *
 * Pins two contracts against a real Postgres + a seeded rich account:
 *
 *   1. With a provider chain stubbed to return a known assessment, the
 *      status generator returns that text (the real path is reached, not
 *      the generic no-key fallback). This is the regression the
 *      sticky-stub bug used to break.
 *
 *   2. A timeout-stub cache row keyed to today is NOT served — the
 *      generator skips it and re-generates, proving the stub no longer
 *      pins the fallback for the day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// Stub the provider resolution so the chain runner has a deterministic
// provider to walk. `runRawCompletionWithFallback` runs for real on top
// of this — exercising the same plumbing the live status path uses.
const KNOWN_TEXT = "Your weight has trended down steadily over the past month.";
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn().mockResolvedValue([
    {
      providerType: "anthropic",
      instance: {
        type: "anthropic",
        generateCompletion: vi.fn().mockResolvedValue({
          content: JSON.stringify({ summary: KNOWN_TEXT }),
          model: "test-model",
          tokensUsed: 42,
        }),
      },
    },
  ]),
  resolveProvider: vi.fn().mockResolvedValue({ type: "none" }),
}));

import { toBerlinDayKey } from "@/lib/tz/resolver";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedRichWeightUser(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      heightCm: 180,
      dateOfBirth: new Date("1985-01-01"),
    },
  });
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const rows = Array.from({ length: 120 }, (_, i) => ({
    userId: user.id,
    type: "WEIGHT" as const,
    value: 82 - i * 0.02,
    unit: "kg",
    source: "MANUAL" as const,
    measuredAt: new Date(now - i * DAY_MS),
  }));
  await prisma.measurement.createMany({ data: rows });
  return user;
}

describe("status path delivers real provider text", () => {
  it("returns the provider's assessment, not the no-key fallback", async () => {
    const user = await seedRichWeightUser("status-real-text-user");
    const { generateWeightStatusForUser } = await import(
      "@/lib/insights/weight-status"
    );

    const result = await generateWeightStatusForUser(user.id, {
      locale: "en",
    });

    expect(result.hasProvider).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.text).toBe(KNOWN_TEXT);

    // The real assessment was persisted (not a stub).
    const prisma = getPrismaClient();
    const cached = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: "insights.weight-status.en" },
      orderBy: { createdAt: "desc" },
      select: { details: true },
    });
    const parsed = JSON.parse(cached?.details ?? "{}") as {
      text: string;
      model: string;
      timeout?: boolean;
    };
    expect(parsed.text).toBe(KNOWN_TEXT);
    expect(parsed.model).toBe("test-model");
    expect(parsed.timeout).toBeUndefined();
  });

  it("skips a timeout-stub cache row and regenerates the real text", async () => {
    const user = await seedRichWeightUser("status-stub-skip-user");
    const prisma = getPrismaClient();

    // Pre-seed a stub row keyed to today — the bug used to serve this.
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "insights.weight-status.en",
        details: JSON.stringify({
          dateKey: toBerlinDayKey(new Date()),
          locale: "en",
          text: "Generic fallback advice that must not be served.",
          model: "timeout-stub",
          timeout: true,
        }),
      },
    });

    const { generateWeightStatusForUser } = await import(
      "@/lib/insights/weight-status"
    );

    const result = await generateWeightStatusForUser(user.id, {
      locale: "en",
    });

    // The stub is skipped; the real provider text is returned + cached.
    expect(result.text).toBe(KNOWN_TEXT);
    expect(result.cached).toBe(false);
  });
});
