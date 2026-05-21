import { describe, it, expect } from "vitest";

import { mergeSlimAndThickAnalytics } from "@/lib/analytics/merge-slim-thick";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.4.39.3 — dashboard slim/thick merge robustness.
 *
 * v1.4.39.2 split the dashboard's analytics consumption into a slim
 * `?slice=summaries` query and the thick default query. The original
 * inline merge used `slim?.summaries ?? thick?.summaries` which
 * short-circuited on a truthy-but-empty `{}` from the slim slice and
 * blanked the tile strip even when thick carried the full payload —
 * the regression Marc's v1.4.39.3 e2e CI flagged across eight
 * dashboard / chart specs (chart-overlay-controls, dashboard,
 * measurement-flow, charts-mobile). The pure helper extracted in
 * v1.4.39.3 uses object emptiness as the discriminator so a populated
 * thick payload survives an empty slim resolve.
 */

const stubSummary = (): DataSummary => ({
  count: 30,
  latest: 78.5,
  min: 76,
  max: 80,
  mean: 78,
  avg7: 78.2,
  avg30: 77.9,
  slope7: null,
  slope30: { slope: -0.05, direction: "down", confidence: 0.5 },
  slope90: null,
  anomalyCount: 0,
});

describe("mergeSlimAndThickAnalytics", () => {
  it("returns undefined when neither slim nor thick has resolved", () => {
    expect(mergeSlimAndThickAnalytics(undefined, undefined)).toBeUndefined();
  });

  it("prefers slim summaries when slim carries content (progressive paint)", () => {
    const slim = {
      summaries: {
        WEIGHT: stubSummary(),
      },
    };
    const thick = {
      summaries: {
        WEIGHT: { ...stubSummary(), latest: 1 },
        PULSE: stubSummary(),
      },
      bpInTargetPct: 78,
    };
    const merged = mergeSlimAndThickAnalytics(slim, thick);
    // Slim wins on overlapping field — the v1.4.39.2 progressive-paint
    // contract is preserved.
    expect(merged?.summaries.WEIGHT?.latest).toBe(78.5);
    // Slim does not carry PULSE; merge keeps slim's record as-is
    // (matches the "as soon as slim lands, paint" semantic).
    expect(merged?.summaries.PULSE).toBeUndefined();
    // Thick still wires the BD-Zielbereich + glucose fields.
    expect(merged?.bpInTargetPct).toBe(78);
  });

  it("falls back to thick when slim resolves with an empty summaries record", () => {
    // The v1.4.39.3 regression: empty slim `{}` is truthy by JS
    // semantics so the old `??` short-circuited on it, blanking the
    // tile strip even when thick had data.
    const slim = { summaries: {} as Record<string, DataSummary> };
    const thick = {
      summaries: {
        WEIGHT: stubSummary(),
      },
      bpInTargetPct: 78,
    };
    const merged = mergeSlimAndThickAnalytics(slim, thick);
    expect(merged?.summaries.WEIGHT?.latest).toBe(78.5);
    expect(merged?.bpInTargetPct).toBe(78);
  });

  it("falls back to thick when slim has not resolved yet", () => {
    const thick = {
      summaries: {
        WEIGHT: stubSummary(),
      },
      bpInTargetPct: 78,
    };
    const merged = mergeSlimAndThickAnalytics(undefined, thick);
    expect(merged?.summaries.WEIGHT?.latest).toBe(78.5);
    expect(merged?.bpInTargetPct).toBe(78);
  });

  it("returns slim summaries when only slim has resolved (thick still loading)", () => {
    const slim = {
      summaries: { WEIGHT: stubSummary() },
    };
    const merged = mergeSlimAndThickAnalytics(slim, undefined);
    expect(merged?.summaries.WEIGHT?.latest).toBe(78.5);
    // Thick-only fields collapse to null/undefined so consumers stay
    // undefined-safe — the BD-Zielbereich tile self-gates on these.
    expect(merged?.bpInTargetPct).toBeNull();
    expect(merged?.glucoseByContext).toBeUndefined();
  });

  it("returns empty summaries when both sides resolve empty (legit zero-data tenant)", () => {
    const merged = mergeSlimAndThickAnalytics(
      { summaries: {} },
      { summaries: {} },
    );
    expect(merged?.summaries).toEqual({});
    expect(merged?.bpInTargetPct).toBeNull();
  });

  it("falls back to thick lastSeenByType when slim has none", () => {
    const slim = { summaries: { WEIGHT: stubSummary() } };
    const thick = {
      summaries: { WEIGHT: stubSummary() },
      lastSeenByType: {
        WEIGHT: { lastSeenAt: "2026-05-01T00:00:00.000Z", daysAgo: 3 },
      },
    };
    const merged = mergeSlimAndThickAnalytics(slim, thick);
    expect(merged?.lastSeenByType?.WEIGHT?.daysAgo).toBe(3);
  });

  it("prefers slim lastSeenByType when slim carries one", () => {
    const slim = {
      summaries: { WEIGHT: stubSummary() },
      lastSeenByType: {
        WEIGHT: { lastSeenAt: "2026-05-10T00:00:00.000Z", daysAgo: 1 },
      },
    };
    const thick = {
      summaries: { WEIGHT: stubSummary() },
      lastSeenByType: {
        WEIGHT: { lastSeenAt: "2026-05-01T00:00:00.000Z", daysAgo: 10 },
      },
    };
    const merged = mergeSlimAndThickAnalytics(slim, thick);
    expect(merged?.lastSeenByType?.WEIGHT?.daysAgo).toBe(1);
  });
});
