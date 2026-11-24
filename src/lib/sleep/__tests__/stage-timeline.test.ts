import { describe, it, expect } from "vitest";
import type { SleepStage } from "@/generated/prisma/client";
import { hasStageTimeline, type StageSpan } from "../stage-timeline";

/**
 * #1419 — the shapes that carry a recorded stage order and the shapes that
 * carry totals only. The night-level fixtures (Garmin, Oura, WHOOP, Apple
 * Health and the mixed nights) are in `analytics/__tests__/sleep-night.test.ts`.
 */
describe("hasStageTimeline", () => {
  const span = (
    stage: SleepStage | null,
    start: string,
    end: string,
  ): StageSpan => ({
    stage,
    start: new Date(start),
    end: new Date(end),
  });

  it("has no timeline without a span, and one with a single span", () => {
    expect(hasStageTimeline([])).toBe(false);
    expect(
      hasStageTimeline([
        span("ASLEEP", "2026-06-03T23:00:00Z", "2026-06-04T06:00:00Z"),
      ]),
    ).toBe(true);
  });

  it("reads spans nested against one end instant as totals", () => {
    expect(
      hasStageTimeline([
        span("CORE", "2026-06-03T23:00:00Z", "2026-06-04T06:00:00Z"),
        span("DEEP", "2026-06-04T05:00:00Z", "2026-06-04T06:00:00Z"),
      ]),
    ).toBe(false);
  });

  it("reads the builder's layout as totals, to within the stored rounding", () => {
    expect(
      hasStageTimeline([
        span("AWAKE", "2026-06-03T23:00:00Z", "2026-06-03T23:10:00Z"),
        span("CORE", "2026-06-03T23:10:00.300Z", "2026-06-04T03:00:00Z"),
        span("DEEP", "2026-06-04T03:00:00Z", "2026-06-04T04:00:00Z"),
        span("REM", "2026-06-04T04:00:00Z", "2026-06-04T05:00:00Z"),
        span("IN_BED", "2026-06-03T22:50:00Z", "2026-06-04T05:00:00Z"),
      ]),
    ).toBe(false);
  });

  it("reads anything the builder cannot produce as measured", () => {
    // Two spans back to back: a partial night, never read as a layout.
    expect(
      hasStageTimeline([
        span("CORE", "2026-06-03T23:00:00Z", "2026-06-04T01:00:00Z"),
        span("DEEP", "2026-06-04T01:00:00Z", "2026-06-04T02:00:00Z"),
      ]),
    ).toBe(true);
    // Each stage once and back to back, but out of the builder's order.
    expect(
      hasStageTimeline([
        span("CORE", "2026-06-03T23:00:00Z", "2026-06-04T01:00:00Z"),
        span("DEEP", "2026-06-04T01:00:00Z", "2026-06-04T02:00:00Z"),
        span("AWAKE", "2026-06-04T02:00:00Z", "2026-06-04T02:10:00Z"),
        span("REM", "2026-06-04T02:10:00Z", "2026-06-04T03:00:00Z"),
      ]),
    ).toBe(true);
    // In the builder's order, but with a gap between two stages.
    expect(
      hasStageTimeline([
        span("CORE", "2026-06-03T23:00:00Z", "2026-06-04T01:00:00Z"),
        span("DEEP", "2026-06-04T01:30:00Z", "2026-06-04T02:00:00Z"),
        span("REM", "2026-06-04T02:00:00Z", "2026-06-04T03:00:00Z"),
      ]),
    ).toBe(true);
  });
});
