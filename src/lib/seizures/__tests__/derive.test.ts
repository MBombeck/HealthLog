import { describe, expect, it } from "vitest";

import {
  alertThreshold,
  DEFAULT_CLUSTER_RULE,
  deriveClusters,
  durationFlags,
  frequencyCategory,
  monthlyByType,
  monthsBetween,
  NICE_CLUSTER_RULE,
  normaliseClusterRule,
  seizureDayKeys,
  seizureFreeSummary,
  timeSinceLastAnswer,
  type DerivableSeizure,
} from "../derive";

let n = 0;
function seizure(
  onsetAt: string,
  extra: Partial<DerivableSeizure> = {},
): DerivableSeizure {
  n += 1;
  return {
    id: `e${String(n).padStart(3, "0")}`,
    onsetAt,
    count: 1,
    certainty: "CONFIRMED",
    ilaeType: "FOCAL_TO_BILATERAL_TC",
    typeProfileId: "t1",
    durationSec: 90,
    sleepState: "AWAKE",
    ...extra,
  };
}

describe("deriveClusters", () => {
  it("finds nothing below the rule", () => {
    const events = [
      seizure("2026-03-01T08:00:00Z"),
      seizure("2026-03-02T09:00:00Z"),
    ];
    expect(deriveClusters(events, DEFAULT_CLUSTER_RULE)).toEqual([]);
  });

  it("flags two seizures 23 hours apart under the default 2 in 24 h", () => {
    const events = [
      seizure("2026-03-01T08:00:00Z"),
      seizure("2026-03-02T07:00:00Z"),
    ];
    const clusters = deriveClusters(events, DEFAULT_CLUSTER_RULE);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].seizureCount).toBe(2);
    expect(clusters[0].startAt).toBe("2026-03-01T08:00:00.000Z");
    expect(clusters[0].endAt).toBe("2026-03-02T07:00:00.000Z");
  });

  it("treats the window as half-open: exactly 24 h apart is not a cluster", () => {
    const events = [
      seizure("2026-03-01T08:00:00Z"),
      seizure("2026-03-02T08:00:00Z"),
    ];
    expect(deriveClusters(events, DEFAULT_CLUSTER_RULE)).toEqual([]);
  });

  it("joins a cluster that runs over midnight into one episode", () => {
    const events = [
      seizure("2026-03-01T22:30:00Z"),
      seizure("2026-03-01T23:50:00Z"),
      seizure("2026-03-02T01:10:00Z"),
    ];
    const clusters = deriveClusters(events, NICE_CLUSTER_RULE);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].eventIds).toHaveLength(3);
  });

  it("merges overlapping qualifying windows and counts the run once", () => {
    // Each seizure within 24 h of the next: one episode, not three.
    const events = [
      seizure("2026-03-01T00:00:00Z"),
      seizure("2026-03-01T20:00:00Z"),
      seizure("2026-03-02T16:00:00Z"),
      seizure("2026-03-03T12:00:00Z"),
    ];
    const clusters = deriveClusters(events, DEFAULT_CLUSTER_RULE);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].seizureCount).toBe(4);
  });

  it("keeps separate runs separate", () => {
    const events = [
      seizure("2026-03-01T08:00:00Z"),
      seizure("2026-03-01T09:00:00Z"),
      seizure("2026-03-10T08:00:00Z"),
      seizure("2026-03-10T09:00:00Z"),
    ];
    expect(deriveClusters(events, DEFAULT_CLUSTER_RULE)).toHaveLength(2);
  });

  it("does not make a cluster of one tally row on its own", () => {
    // Three absences logged as one tally are one entry, not a run of
    // seizures that formed a cluster; the rule is read over entries.
    const events = [seizure("2026-03-01T08:00:00Z", { count: 3 })];
    expect(deriveClusters(events, NICE_CLUSTER_RULE)).toEqual([]);
  });

  it("weights a tally by its count once another entry shares the window", () => {
    const events = [
      seizure("2026-03-01T08:00:00Z", { count: 3 }),
      seizure("2026-03-01T12:00:00Z"),
    ];
    const [episode] = deriveClusters(events, { count: 4, windowHours: 24 });
    expect(episode?.seizureCount).toBe(4);
    expect(deriveClusters(events, { count: 5, windowHours: 24 })).toEqual([]);
  });

  it("counts suspected events, since they are exactly when the rule matters", () => {
    const events = [
      seizure("2026-03-01T08:00:00Z"),
      seizure("2026-03-01T10:00:00Z", { certainty: "SUSPECTED" }),
    ];
    expect(deriveClusters(events, DEFAULT_CLUSTER_RULE)).toHaveLength(1);
  });

  it("measures absolute hours across a spring-forward night", () => {
    // Europe/Berlin springs forward on 2026-03-29 at 01:00 UTC. 23:00 local
    // on the 28th (22:00 UTC) to 23:30 local on the 29th (21:30 UTC) is 23.5
    // real hours although the clock shows 24.5.
    const events = [
      seizure("2026-03-28T22:00:00Z"),
      seizure("2026-03-29T21:30:00Z"),
    ];
    expect(deriveClusters(events, DEFAULT_CLUSTER_RULE)).toHaveLength(1);
  });

  it("measures absolute hours across a fall-back night", () => {
    // Europe/Berlin falls back on 2026-10-25 at 01:00 UTC. 23:30 local on
    // the 24th (21:30 UTC) to 23:00 local on the 25th (22:00 UTC) is 24.5
    // real hours although the clock shows 23.5.
    const events = [
      seizure("2026-10-24T21:30:00Z"),
      seizure("2026-10-25T22:00:00Z"),
    ];
    expect(deriveClusters(events, DEFAULT_CLUSTER_RULE)).toEqual([]);
  });

  it("is order-independent", () => {
    const a = seizure("2026-03-01T08:00:00Z");
    const b = seizure("2026-03-01T09:00:00Z");
    expect(deriveClusters([b, a], DEFAULT_CLUSTER_RULE)).toEqual(
      deriveClusters([a, b], DEFAULT_CLUSTER_RULE),
    );
  });
});

describe("normaliseClusterRule", () => {
  it("defaults to 2 in 24 h and clamps into range", () => {
    expect(normaliseClusterRule(null)).toEqual({ count: 2, windowHours: 24 });
    expect(normaliseClusterRule({ count: 1, windowHours: 0 })).toEqual({
      count: 2,
      windowHours: 1,
    });
    expect(normaliseClusterRule({ count: 99, windowHours: 999 })).toEqual({
      count: 20,
      windowHours: 168,
    });
  });
});

describe("seizure days and the seizure-free summary", () => {
  it("groups by the person's calendar day, not UTC", () => {
    const events = [seizure("2026-03-01T23:30:00Z")];
    expect(seizureDayKeys(events, "UTC")).toEqual(["2026-03-01"]);
    expect(seizureDayKeys(events, "Europe/Berlin")).toEqual(["2026-03-02"]);
  });

  it("counts days since the last confirmed seizure and ignores suspected ones", () => {
    const events = [
      seizure("2026-03-01T08:00:00Z"),
      seizure("2026-03-08T08:00:00Z", { certainty: "SUSPECTED" }),
    ];
    const s = seizureFreeSummary(
      events,
      "UTC",
      "2026-03-01",
      "2026-03-10",
      "2026-03-10",
    );
    expect(s.daysSinceLast).toBe(9);
    expect(s.lastAt).toBe("2026-03-01T08:00:00.000Z");
    // 2 March to 10 March, both ends included.
    expect(s.longestFreeDays).toBe(9);
  });

  it("finds the longest gap including the period edges", () => {
    const events = [
      seizure("2026-03-05T08:00:00Z"),
      seizure("2026-03-06T08:00:00Z"),
    ];
    const s = seizureFreeSummary(
      events,
      "UTC",
      "2026-03-01",
      "2026-03-08",
      "2026-03-08",
    );
    // 1 to 4 March before the first seizure day.
    expect(s.longestFreeDays).toBe(4);
  });

  it("answers null without any confirmed seizure", () => {
    const s = seizureFreeSummary(
      [],
      "UTC",
      "2026-03-01",
      "2026-03-31",
      "2026-03-31",
    );
    expect(s.daysSinceLast).toBeNull();
    expect(s.longestFreeDays).toBe(31);
  });
});

describe("monthlyByType", () => {
  it("counts seizures and seizure days per type and month, with a total", () => {
    const events = [
      seizure("2026-01-10T08:00:00Z", { typeProfileId: "a", count: 3 }),
      seizure("2026-01-10T12:00:00Z", { typeProfileId: "a" }),
      seizure("2026-02-01T08:00:00Z", { typeProfileId: "b" }),
      seizure("2026-02-02T08:00:00Z", { typeProfileId: null }),
    ];
    const { rows, total } = monthlyByType(events, "UTC");
    const a = rows.find((r) => r.typeProfileId === "a")!;
    expect(a.counts).toEqual({ "2026-01": 4 });
    expect(a.days).toEqual({ "2026-01": 1 });
    expect(rows.find((r) => r.typeProfileId === null)!.total).toBe(1);
    expect(total.counts).toEqual({ "2026-01": 4, "2026-02": 2 });
    expect(total.days).toEqual({ "2026-01": 1, "2026-02": 2 });
  });

  it("lists every month of a period across a year end", () => {
    expect(monthsBetween("2025-11-15", "2026-02-01")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

describe("durationFlags", () => {
  it("compares against t1 and the usual duration plus two minutes", () => {
    expect(durationFlags(300, "GENERALIZED_TC", 60)).toEqual({
      overT1: true,
      prolonged: true,
    });
    expect(durationFlags(170, "GENERALIZED_TC", 60)).toEqual({
      overT1: false,
      prolonged: false,
    });
    expect(durationFlags(180, "GENERALIZED_TC", 60)).toEqual({
      overT1: false,
      prolonged: true,
    });
  });

  it("answers null where the input to decide is missing", () => {
    expect(durationFlags(null, "GENERALIZED_TC", 60)).toEqual({
      overT1: null,
      prolonged: null,
    });
    expect(durationFlags(400, "FOCAL_PRESERVED", null)).toEqual({
      overT1: null,
      prolonged: null,
    });
  });
});

describe("alertThreshold", () => {
  it("uses 5 minutes for a convulsive type without a usual duration", () => {
    expect(alertThreshold("FOCAL_TO_BILATERAL_TC", null)).toEqual({
      seconds: 300,
      source: "t1",
    });
  });

  it("uses the usual duration plus 2 minutes when that comes first (NICE)", () => {
    expect(alertThreshold("GENERALIZED_TC", 60)).toEqual({
      seconds: 180,
      source: "usualPlusTwo",
    });
  });

  it("never waits past t1 for a convulsive type, however long the usual one", () => {
    expect(alertThreshold("GENERALIZED_TC", 400)).toEqual({
      seconds: 300,
      source: "t1",
    });
  });

  it("uses t1 for focal impaired and absence types", () => {
    expect(alertThreshold("FOCAL_IMPAIRED", 30).seconds).toBe(600);
    expect(alertThreshold("ABSENCE_TYPICAL", null).seconds).toBe(600);
  });

  it("falls back to 5 minutes for any other type and for no type", () => {
    expect(alertThreshold("GEN_MYOCLONIC", null)).toEqual({
      seconds: 300,
      source: "generic",
    });
    expect(alertThreshold(null, null)).toEqual({
      seconds: 300,
      source: "generic",
    });
  });
});

describe("LOINC summary answers", () => {
  it("buckets the trailing year by LOINC's own definitions", () => {
    expect(frequencyCategory([])).toBe("lessThanYearly");
    expect(frequencyCategory([1, 1, 1])).toBe("yearly");
    expect(frequencyCategory(new Array(15).fill(1))).toBe("monthly");
    expect(frequencyCategory(new Array(60).fill(1))).toBe("weekly");
    expect(frequencyCategory(new Array(220).fill(1))).toBe("daily");
    expect(frequencyCategory(new Array(220).fill(3))).toBe("multiplePerDay");
    expect(frequencyCategory(new Array(200).fill(12))).toBe("innumerable");
  });

  it("answers time since the last seizure in LL6118-5", () => {
    expect(timeSinceLastAnswer(null).code).toBe("LA14072-5");
    expect(timeSinceLastAnswer(0).code).toBe("LA32860-1");
    expect(timeSinceLastAnswer(6).code).toBe("LA32861-9");
    expect(timeSinceLastAnswer(20).code).toBe("LA32862-7");
    expect(timeSinceLastAnswer(400).code).toBe("LA32866-8");
    expect(timeSinceLastAnswer(900).code).toBe("LA32867-6");
  });
});
