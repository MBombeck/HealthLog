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
 *   2. A negative-cache window opened by an earlier stall never stands in
 *      for a note: once it lapses, with no note stored for today, the
 *      generator regenerates and stores the real text, and writing it closes
 *      the window and resets the failure streak. While it is open (#1279),
 *      no provider is asked and the window stays as it was.
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
vi.mock("@/lib/ai/provider", async (importOriginal) => ({
  // The presence probe the capability reads stays real; only the chain the
  // generation walks is replaced.
  ...(await importOriginal<typeof import("@/lib/ai/provider")>()),
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

import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";

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
      // Presence of a provider for the capability; never decrypted here.
      aiProviderChain: [{ providerType: "anthropic", enabled: true }],
      aiAnthropicKeyEncrypted: "key-present",
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
    const { generateWeightStatusForUser } =
      await import("@/lib/insights/weight-status");

    const result = await generateWeightStatusForUser(user.id, {
      locale: "en",
    });

    expect(result.hasProvider).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.text).toBe(KNOWN_TEXT);

    // The real assessment was stored, encrypted, as the weight note.
    const prisma = getPrismaClient();
    const stored = await prisma.insightStatusCache.findUniqueOrThrow({
      where: {
        userId_metric_locale: {
          userId: user.id,
          metric: "weight",
          locale: "en",
        },
      },
    });
    expect(decryptFromBytes(stored.textEncrypted!)).toBe(KNOWN_TEXT);
    expect(stored.retryAt).toBeNull();
    // Nothing about the note lands in the audit log any more.
    expect(
      await prisma.auditLog.count({
        where: { userId: user.id, action: { contains: "-status." } },
      }),
    ).toBe(0);
  });

  it("regenerates past a lapsed negative-cache window and closes it", async () => {
    const user = await seedRichWeightUser("status-stub-skip-user");
    const prisma = getPrismaClient();

    // Earlier stalls opened a window, now lapsed, with no note stored.
    await prisma.insightStatusCache.create({
      data: {
        userId: user.id,
        metric: "weight",
        locale: "en",
        dateKey: "2026-01-01",
        retryAt: new Date(Date.now() - 1_000),
        negativeReason: "timeout",
        failureStreak: 3,
      },
    });

    const { generateWeightStatusForUser } =
      await import("@/lib/insights/weight-status");

    const result = await generateWeightStatusForUser(user.id, {
      locale: "en",
    });

    expect(result.text).toBe(KNOWN_TEXT);
    expect(result.cached).toBe(false);
    const stored = await prisma.insightStatusCache.findUniqueOrThrow({
      where: {
        userId_metric_locale: {
          userId: user.id,
          metric: "weight",
          locale: "en",
        },
      },
    });
    expect(stored.retryAt).toBeNull();
    expect(stored.negativeReason).toBeNull();
    expect(stored.failureStreak).toBe(0);
  });

  it("asks no provider while the window is open (#1279)", async () => {
    const user = await seedRichWeightUser("status-cooling-user");
    const prisma = getPrismaClient();
    const retryAt = new Date(Date.now() + 60_000);
    await prisma.insightStatusCache.create({
      data: {
        userId: user.id,
        metric: "weight",
        locale: "en",
        dateKey: "2026-01-01",
        retryAt,
        negativeReason: "error",
        failureStreak: 2,
      },
    });
    const { resolveProviderChain } = await import("@/lib/ai/provider");
    const [entry] = await vi.mocked(resolveProviderChain)(user.id);
    const generate = vi.mocked(entry.instance.generateCompletion);
    generate.mockClear();

    const { generateWeightStatusForUser } =
      await import("@/lib/insights/weight-status");
    const result = await generateWeightStatusForUser(user.id, {
      locale: "en",
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.text).not.toBe(KNOWN_TEXT);
    const stored = await prisma.insightStatusCache.findUniqueOrThrow({
      where: {
        userId_metric_locale: {
          userId: user.id,
          metric: "weight",
          locale: "en",
        },
      },
    });
    // The window neither moved nor counted the refused generation.
    expect(stored.retryAt?.getTime()).toBe(retryAt.getTime());
    expect(stored.failureStreak).toBe(2);
    expect(stored.textEncrypted).toBeNull();
  });
});
