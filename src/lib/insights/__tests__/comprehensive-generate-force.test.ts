/**
 * v1.7.0 — `force` bypasses the 24 h cache short-circuit.
 *
 * The nightly pre-generate cron discovers users on a 20 h window but
 * the generator's cache TTL is 24 h. Without `force` a user whose cache
 * is 20-24 h old short-circuits to `{status:"cached"}` and the cron's
 * budget bucket is wasted with no actual regeneration. These tests pin
 * that `force: true` skips the TTL re-check (and `force: false` still
 * honours a fresh cache).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: (...a: unknown[]) => resolveProviderChain(...a),
  resolveProvider: (...a: unknown[]) => resolveProvider(...a),
}));

import { generateComprehensiveInsight } from "../comprehensive-generate";

beforeEach(() => {
  vi.clearAllMocks();
  // No provider configured → the function returns `skipped` once it gets
  // past the cache short-circuit, which is enough to prove the branch.
  resolveProviderChain.mockResolvedValue([]);
  resolveProvider.mockResolvedValue({ type: "none" });
});

describe("generateComprehensiveInsight — cache short-circuit", () => {
  it("returns `cached` for a fresh (<24h) cache when not forced", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 21 * 60 * 60 * 1000),
      insightsCachedText: "{}",
      insightsExcludeMetrics: [],
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
    });

    expect(outcome).toEqual({ status: "cached" });
    // Never reached the provider chain.
    expect(resolveProviderChain).not.toHaveBeenCalled();
  });

  it("bypasses the 24h cache when `force` is set (proceeds past the short-circuit)", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      // 21h old — inside the 24h TTL, so the un-forced path would cache.
      insightsCachedAt: new Date(Date.now() - 21 * 60 * 60 * 1000),
      insightsCachedText: "{}",
      insightsExcludeMetrics: [],
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
      force: true,
    });

    // Forced past the cache → provider chain resolved → no provider →
    // skipped (NOT cached). The key assertion is that it did not
    // short-circuit on the fresh cache.
    expect(resolveProviderChain).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "skipped", reason: "no-provider" });
  });
});
