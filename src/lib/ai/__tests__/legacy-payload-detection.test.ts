import { describe, it, expect } from "vitest";
import { isLegacyInsightPayload } from "../legacy-payload";

/**
 * v1.4.16 — legacy-payload detection.
 *
 * Cached insight blobs persisted before B5c shipped don't carry the
 * `rationale` field. The /api/insights/generate route returns a
 * `legacyPayload: true` flag on cache-hit so the UI can render a
 * one-time "Insights updated — regenerate for new explainability
 * features" CTA. User-initiated regeneration stays the trigger; we
 * do NOT auto-regenerate on cache-hit (that would burn rate-limit
 * tokens silently).
 *
 * Detection is intentionally lenient — the cached payload may carry
 * either the canonical `AIInsightResponse` shape or the legacy
 * `InsightResult` shape (string-only recommendations[]). Both pre-
 * date B5c rationale; both should be flagged for regeneration.
 */

describe("isLegacyInsightPayload()", () => {
  it("returns false for a B5c-shaped payload (every rec has rationale)", () => {
    const payload = {
      summary: "x",
      recommendations: [
        {
          id: "rec-1",
          text: "Walk more",
          severity: "suggestion",
          metricSource: {
            type: "activity",
            timeRange: "last7days",
            summary: "5,000 steps",
          },
          rationale: {
            dataWindow: "last7days",
            comparedTo: "your 90-day median (8,000 steps)",
            deviation: "−3,000 steps below baseline",
          },
        },
      ],
    };
    expect(isLegacyInsightPayload(payload)).toBe(false);
  });

  it("returns true for a payload where every rec lacks rationale (pre-B5c)", () => {
    const payload = {
      summary: "x",
      recommendations: [
        {
          id: "rec-1",
          text: "Walk more",
          severity: "suggestion",
          metricSource: {
            type: "activity",
            timeRange: "last7days",
            summary: "5,000 steps",
          },
        },
      ],
    };
    expect(isLegacyInsightPayload(payload)).toBe(true);
  });

  it("returns true for the legacy InsightResult-style string-only recommendations[]", () => {
    // v1.4.14 / v1.4.15 cached InsightResult blobs sometimes have
    // string-recs (`recommendations: ["Walk more", "Hydrate"]`).
    // These also predate B5c.
    const payload = {
      summary: "x",
      recommendations: ["Walk more", "Hydrate"],
    };
    expect(isLegacyInsightPayload(payload)).toBe(true);
  });

  it("returns false for an empty recommendations[] (no recs to migrate)", () => {
    // Empty recs is a legitimate refusal payload — not legacy.
    const payload = {
      summary: "Insufficient data.",
      recommendations: [],
    };
    expect(isLegacyInsightPayload(payload)).toBe(false);
  });

  it("returns true when ANY rec is missing rationale (mixed payload)", () => {
    const payload = {
      summary: "x",
      recommendations: [
        {
          id: "rec-1",
          text: "Walk more",
          severity: "suggestion",
          metricSource: {
            type: "activity",
            timeRange: "last7days",
            summary: "5,000 steps",
          },
          rationale: {
            dataWindow: "last7days",
            comparedTo: "your 90-day median",
            deviation: "−3,000 steps",
          },
        },
        {
          id: "rec-2",
          text: "Hydrate",
          severity: "info",
          metricSource: {
            type: "fluid",
            timeRange: "last7days",
            summary: "low intake",
          },
          // no rationale
        },
      ],
    };
    expect(isLegacyInsightPayload(payload)).toBe(true);
  });

  it("returns false for null / non-object input (defensive)", () => {
    expect(isLegacyInsightPayload(null)).toBe(false);
    expect(isLegacyInsightPayload(undefined)).toBe(false);
    expect(isLegacyInsightPayload("not an object")).toBe(false);
    expect(isLegacyInsightPayload(42)).toBe(false);
  });

  it("returns false when recommendations is missing entirely (not legacy, just empty)", () => {
    expect(isLegacyInsightPayload({ summary: "x" })).toBe(false);
  });

  it("returns true for the v1.4.14 pre-strict-schema shape", () => {
    // A cached blob of this shape crashed /insights after the schema
    // change. No `summary`, no `recommendations[]` — just the
    // pre-v1.4.16 `{changed, stable, drivers, nextSteps, confidence,
    // limitations}` shape. The route's `safeParse` failed and fell
    // through to the raw blob, so the rich card got `summary ===
    // undefined` and crashed inside `stripChartTokens(undefined)`.
    const payload = {
      changed: "Long-term improvement on weight and BP.",
      stable: "Pulse remains stable.",
      drivers: "Weight reduction may have contributed.",
      nextSteps: "Keep going.",
      confidence: "hoch",
      limitations: "Correlations don't imply causation.",
    };
    expect(isLegacyInsightPayload(payload)).toBe(true);
  });

  it("returns true for an empty-summary v1.4.14-style blob (no fields)", () => {
    expect(isLegacyInsightPayload({})).toBe(true);
  });
});
