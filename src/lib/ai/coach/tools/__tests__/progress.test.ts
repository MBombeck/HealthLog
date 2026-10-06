/**
 * v1.41 — the no-progress brake: repeated calls, rounds of empty misses,
 * rounds without a new stretch of the record.
 */
import { describe, expect, it } from "vitest";

import { callScope, callSignature, createProgressTracker } from "../progress";

describe("callSignature", () => {
  it("is one call whatever the key order, case or spacing", () => {
    expect(
      callSignature(
        "get_metric_table",
        '{"metric":"bp","window":"last30days"}',
      ),
    ).toBe(
      callSignature(
        "get_metric_table",
        '{ "window": "LAST30DAYS ", "metric": "bp" }',
      ),
    );
    expect(callSignature("get_sleep", "")).toBe(
      callSignature("get_sleep", "{}"),
    );
    expect(callSignature("get_sleep", "{}")).not.toBe(
      callSignature("get_sleep", '{"window":"last7days"}'),
    );
  });
});

describe("callScope", () => {
  it("is the domain, window and period a call reads", () => {
    expect(
      callScope("get_metric_table", { metric: "bp", window: "last7days" }),
    ).toBe("bp|last7days|current");
    expect(callScope("get_sleep", {})).toBe("get_sleep|default|current");
    expect(
      callScope("compare_series", {
        metric: "bp",
        metricB: "sleep",
        basis: "yearAgo",
      }),
    ).toBe("bp+sleep|default|yearAgo");
  });
});

describe("createProgressTracker", () => {
  const found = { present: true };
  const empty = { present: false, reason: "no_data" };
  const informative = { present: false, reason: "outside_window" };

  it("names the earlier call a repeat stands for, and does not remember the repeat", () => {
    const tracker = createProgressTracker();
    const sig = callSignature("get_sleep", "{}");
    expect(tracker.duplicateOf("c1", sig)).toBeNull();
    expect(tracker.duplicateOf("c2", sig)).toBe("c1");
    expect(tracker.duplicateOf("c3", sig)).toBe("c1");
  });

  it("brakes when every call of a round repeats an earlier one", () => {
    const tracker = createProgressTracker();
    tracker.record({
      duplicate: false,
      scope: "bp|default|current",
      result: found,
    });
    expect(tracker.endRound()).toBe(false);
    tracker.record({ duplicate: true, scope: null, result: null });
    tracker.record({ duplicate: true, scope: null, result: null });
    expect(tracker.endRound()).toBe(true);
  });

  it("does not brake on a round with one repeat beside a new read", () => {
    const tracker = createProgressTracker();
    tracker.record({ duplicate: true, scope: null, result: null });
    tracker.record({
      duplicate: false,
      scope: "pulse|default|current",
      result: found,
    });
    expect(tracker.endRound()).toBe(false);
  });

  it("brakes after two rounds of nothing but empty misses", () => {
    const tracker = createProgressTracker();
    tracker.record({
      duplicate: false,
      scope: "a|default|current",
      result: empty,
    });
    expect(tracker.endRound()).toBe(false);
    tracker.record({
      duplicate: false,
      scope: "b|default|current",
      result: empty,
    });
    expect(tracker.endRound()).toBe(true);
  });

  it("counts a miss that says where the data is as progress", () => {
    const tracker = createProgressTracker();
    tracker.record({
      duplicate: false,
      scope: "a|default|current",
      result: empty,
    });
    tracker.endRound();
    tracker.record({
      duplicate: false,
      scope: "b|default|current",
      result: informative,
    });
    expect(tracker.endRound()).toBe(false);
  });

  it("brakes after three rounds without a new stretch of the record", () => {
    const tracker = createProgressTracker();
    tracker.record({
      duplicate: false,
      scope: "bp|default|current",
      result: found,
    });
    expect(tracker.endRound()).toBe(false);
    for (let round = 0; round < 2; round += 1) {
      tracker.record({
        duplicate: false,
        scope: "bp|default|current",
        result: found,
      });
      expect(tracker.endRound()).toBe(false);
    }
    tracker.record({
      duplicate: false,
      scope: "bp|default|current",
      result: found,
    });
    expect(tracker.endRound()).toBe(true);
  });
});
