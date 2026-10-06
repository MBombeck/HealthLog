import { describe, expect, it } from "vitest";

import {
  ACTIVITY_TEXT_MAX_CHARS,
  ACTIVITY_TITLE_MAX_CHARS,
  TRAIL_MAX_BYTES,
  activitySummaryKey,
  createNoopActivityRecorder,
} from "../contract";

describe("activity contract", () => {
  it("the no-op recorder sends and stores nothing", () => {
    const recorder = createNoopActivityRecorder();
    const id = recorder.start({
      phase: "thinking",
      round: 1,
      labelKey: "insights.coach.activity.thinking",
      label: "Thinking…",
    });
    recorder.update(id, { title: "**Checking the trend**" });
    recorder.finish(id, "done", { text: "Looked at the last month." });
    expect(recorder.meta()).toEqual([]);
    expect(recorder.trail()).toBeNull();
  });

  it("a full trail of model text fits its stored bound", () => {
    // 99 entries can never all carry text: the bound is what a turn stores,
    // and the recorder trims to it. A dozen rounds of full text must fit.
    const twelveRounds = JSON.stringify({
      entries: Array.from({ length: 12 }, (_, i) => ({
        id: `a${i + 1}`,
        title: "t".repeat(ACTIVITY_TITLE_MAX_CHARS),
        text: "x".repeat(ACTIVITY_TEXT_MAX_CHARS),
      })),
    });
    expect(new TextEncoder().encode(twelveRounds).byteLength).toBeLessThan(
      TRAIL_MAX_BYTES,
    );
  });

  it("says nothing about lookups on a turn that made none", () => {
    expect(activitySummaryKey(0, "en")).toBe(
      "insights.coach.activity.summaryNoLookups",
    );
    expect(activitySummaryKey(1, "en")).toBe(
      "insights.coach.activity.summaryOne",
    );
    expect(activitySummaryKey(3, "pl")).toBe(
      "insights.coach.activity.summaryFew",
    );
  });
});
