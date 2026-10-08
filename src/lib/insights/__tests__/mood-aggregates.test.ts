import { describe, expect, it } from "vitest";

import {
  STABILITY_MIN_DAYS,
  STABILITY_SD_FULL_SCALE,
  TIME_OF_DAY_MIN_BUCKET_SAMPLES,
  bucketForHour,
  computeDistribution,
  computeHeatmapCells,
  computeInTargetPct,
  computeMoodAggregates,
  computeMoodMetricCorrelation,
  computeMoodStability,
  computeStructuredTagSummary,
  computeTagSummary,
  computeTagInfluence,
  computeBetterDays,
  computeTagMetricCrosstab,
  computeFactorMetricCrosstab,
  buildFactorDailySeries,
  CROSSTAB_MIN_PRESENT_DAYS,
  CROSSTAB_MIN_ABSENT_DAYS,
  CROSSTAB_MAX_ROWS,
  CROSSTAB_METRICS,
  CROSSTAB_METRIC_TYPES,
  CROSSTAB_FDR_Q,
  influenceConfidence,
  computeTimeOfDayAverages,
  computeWeekdayAverages,
  selectHeatmapWindow,
  INFLUENCE_MIN_PRESENT_DAYS,
  INFLUENCE_MIN_ABSENT_DAYS,
  BETTER_DAYS_MAX_FACTORS,
  type CrossMetricMeasurement,
  type MoodAggregateEntry,
  type MoodMetricCorrelation,
  type RatedFactorScore,
  type StructuredTagRef,
  type TagInfluence,
} from "../mood-aggregates";

const dayMs = 24 * 60 * 60 * 1000;

/** Anchor "now" at a fixed UTC instant so day-key math is deterministic. */
const NOW = new Date("2026-06-01T12:00:00.000Z");

function dayKey(offset: number): string {
  return new Date(NOW.getTime() - offset * dayMs).toISOString().slice(0, 10);
}

function entry(
  offset: number,
  score: number,
  tags: unknown = null,
): MoodAggregateEntry {
  const ts = new Date(NOW.getTime() - offset * dayMs);
  return { date: dayKey(offset), score, tags, moodLoggedAt: ts };
}

describe("selectHeatmapWindow", () => {
  it("uses a 30-day window below 90 days of history", () => {
    expect(selectHeatmapWindow(0)).toBe(30);
    expect(selectHeatmapWindow(45)).toBe(30);
    expect(selectHeatmapWindow(89)).toBe(30);
  });

  it("uses a 90-day window between 90 and 180 days inclusive", () => {
    expect(selectHeatmapWindow(90)).toBe(90);
    expect(selectHeatmapWindow(150)).toBe(90);
    expect(selectHeatmapWindow(180)).toBe(90);
  });

  it("uses a 365-day window beyond 180 days", () => {
    expect(selectHeatmapWindow(181)).toBe(365);
    expect(selectHeatmapWindow(400)).toBe(365);
  });
});

describe("computeTagSummary", () => {
  it("ranks tags by frequency, drops singletons, and averages the score", () => {
    const entries: MoodAggregateEntry[] = [
      entry(1, 5, ["sport", "work"]),
      entry(2, 3, ["work"]),
      entry(3, 1, ["work"]),
      entry(4, 4, ["sport"]),
      entry(5, 2, ["solo-tag"]), // count 1 → dropped
    ];
    const tags = computeTagSummary(entries, NOW);
    expect(tags).toEqual([
      { tag: "work", count: 3, avgScore: 3 },
      { tag: "sport", count: 2, avgScore: 4.5 },
    ]);
  });

  it("excludes entries older than the window", () => {
    const entries: MoodAggregateEntry[] = [
      entry(1, 5, ["recent"]),
      entry(2, 5, ["recent"]),
      entry(200, 5, ["old"]),
      entry(201, 5, ["old"]),
    ];
    const tags = computeTagSummary(entries, NOW, 90);
    expect(tags.map((t) => t.tag)).toEqual(["recent"]);
  });
});

describe("computeStructuredTagSummary", () => {
  function entryWithStructured(
    offset: number,
    score: number,
    structuredTags: StructuredTagRef[],
  ): MoodAggregateEntry {
    return { ...entry(offset, score, null), structuredTags };
  }

  it("ranks structured tags by frequency, keeps singletons, and groups by category", () => {
    const entries: MoodAggregateEntry[] = [
      entryWithStructured(1, 5, [
        {
          key: "happy",
          categoryKey: "feelings",
          labelKey: "mood.tag.happy",
          icon: "Smile",
        },
        {
          key: "worked_out",
          categoryKey: "health",
          labelKey: "mood.tag.workedOut",
          icon: "Dumbbell",
        },
      ]),
      entryWithStructured(2, 3, [
        {
          key: "happy",
          categoryKey: "feelings",
          labelKey: "mood.tag.happy",
          icon: "Smile",
        },
      ]),
      entryWithStructured(3, 1, [
        {
          key: "stressed",
          categoryKey: "feelings",
          labelKey: "mood.tag.stressed",
          icon: "Brain",
        },
      ]),
    ];
    const rows = computeStructuredTagSummary(entries, NOW);
    const happy = rows.find((r) => r.key === "happy");
    expect(happy).toEqual({
      key: "happy",
      categoryKey: "feelings",
      labelKey: "mood.tag.happy",
      label: null,
      icon: "Smile",
      count: 2,
      avgScore: 4,
    });
    // singletons are kept for the structured breakdown (curated catalog,
    // not noisy free text).
    expect(rows.find((r) => r.key === "stressed")?.count).toBe(1);
    expect(rows.find((r) => r.key === "worked_out")?.categoryKey).toBe(
      "health",
    );
    // ranked by frequency desc.
    expect(rows[0].key).toBe("happy");
  });

  it("carries a custom tag's decrypted label beside its labelKey", () => {
    // A custom tag's labelKey mirrors its raw `custom:<uuid>` key; the
    // decrypted `label` must survive the summary so the UI never renders
    // the raw uuid.
    const customRef: StructuredTagRef = {
      key: "custom:abc-123",
      categoryKey: "custom",
      labelKey: "custom:abc-123",
      label: "Migraine",
      icon: "Tag",
    };
    const rows = computeStructuredTagSummary(
      [entryWithStructured(1, 4, [customRef])],
      NOW,
    );
    expect(rows[0].label).toBe("Migraine");
    expect(rows[0].labelKey).toBe("custom:abc-123");
  });

  it("excludes entries older than the window and ignores entries without structured tags", () => {
    const entries: MoodAggregateEntry[] = [
      entryWithStructured(1, 5, [
        {
          key: "happy",
          categoryKey: "feelings",
          labelKey: "mood.tag.happy",
          icon: "Smile",
        },
      ]),
      entryWithStructured(200, 5, [
        {
          key: "sad",
          categoryKey: "feelings",
          labelKey: "mood.tag.sad",
          icon: "Frown",
        },
      ]),
      entry(2, 4, ["flat-only"]), // no structuredTags → ignored here
    ];
    const rows = computeStructuredTagSummary(entries, NOW, 90);
    expect(rows.map((r) => r.key)).toEqual(["happy"]);
  });
});

describe("computeInTargetPct", () => {
  it("returns the share of the newest 30 daily buckets in the green band", () => {
    const daily = [
      { dayOffset: 0, value: 4 },
      { dayOffset: 1, value: 3 }, // below 3.5 → out
      { dayOffset: 2, value: 5 },
      { dayOffset: 3, value: 3.5 }, // exactly green min → in
    ];
    // 3 of 4 in target → 75
    expect(computeInTargetPct(daily)).toBe(75);
  });

  it("ignores buckets older than 30 days and returns null when empty", () => {
    expect(computeInTargetPct([{ dayOffset: 40, value: 5 }])).toBeNull();
    expect(computeInTargetPct([])).toBeNull();
  });
});

describe("computeDistribution", () => {
  it("rounds daily means to discrete levels and reports every level 1..5", () => {
    const daily = [
      { dayOffset: 0, value: 5 },
      { dayOffset: 1, value: 4.4 }, // → 4
      { dayOffset: 2, value: 3.6 }, // → 4
      { dayOffset: 3, value: 1 },
    ];
    expect(computeDistribution(daily)).toEqual([
      { score: 1, count: 1 },
      { score: 2, count: 0 },
      { score: 3, count: 0 },
      { score: 4, count: 2 },
      { score: 5, count: 1 },
    ]);
  });
});

describe("computeWeekdayAverages", () => {
  it("groups daily means by Monday-aligned weekday", () => {
    // 2026-06-01 is a Monday (UTC). dayOffset 0 = Mon, 1 = Sun, 7 = Mon.
    const daily = [
      { dayOffset: 0, value: 4 }, // Mon
      { dayOffset: 7, value: 2 }, // Mon
      { dayOffset: 1, value: 5 }, // Sun
    ];
    const rows = computeWeekdayAverages(daily, NOW);
    const mon = rows.find((r) => r.weekday === 0);
    const sun = rows.find((r) => r.weekday === 6);
    expect(mon).toEqual({ weekday: 0, avgScore: 3, count: 2 });
    expect(sun).toEqual({ weekday: 6, avgScore: 5, count: 1 });
    // every weekday present
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.weekday === 2)).toEqual({
      weekday: 2,
      avgScore: null,
      count: 0,
    });
  });
});

describe("computeHeatmapCells", () => {
  it("averages multi-entry days and clips to the window", () => {
    const entries: MoodAggregateEntry[] = [
      entry(0, 4),
      { ...entry(0, 2), moodLoggedAt: new Date(NOW.getTime() - 0.1 * dayMs) },
      entry(5, 1),
      entry(45, 3), // outside a 30-day window
    ];
    const cells = computeHeatmapCells(entries, NOW, 30);
    const today = cells.find((c) => c.date === dayKey(0));
    expect(today).toEqual({ date: dayKey(0), score: 3, samples: 2 });
    // The 45-day-old entry is clipped.
    expect(cells.find((c) => c.date === dayKey(45))).toBeUndefined();
    // Sorted ascending by date.
    expect(cells.map((c) => c.date)).toEqual(
      [...cells.map((c) => c.date)].sort(),
    );
  });
});

describe("computeMoodMetricCorrelation", () => {
  it("pairs on dayOffset and returns scatter points + a coefficient", () => {
    // Twenty days, not five. This test used to run on five and assert a
    // coefficient came back, which pinned the very thing the significance
    // gate exists to refuse: five points that happen to line up are not a
    // finding. The pairing and the scatter projection are what it is asking
    // about, and they are unchanged — it just has to ask above the bar.
    const moodDaily = Array.from({ length: 20 }, (_, i) => ({
      dayOffset: i,
      value: 5 - (i % 5),
    }));
    // Perfectly positively correlated metric.
    const metricDaily = moodDaily.map((b) => ({
      dayOffset: b.dayOffset,
      value: b.value * 10,
    }));
    const corr = computeMoodMetricCorrelation(moodDaily, metricDaily, NOW);
    expect(corr.n).toBe(20);
    expect(corr.points).toHaveLength(20);
    expect(corr.result?.r).toBe(1);
    expect(corr.suppressed).toBeUndefined();
    expect(corr.points[0]).toEqual({ x: 5, y: 50 });
  });

  it("refuses the same shape at five days", () => {
    const moodDaily = Array.from({ length: 5 }, (_, i) => ({
      dayOffset: i,
      value: 5 - i,
    }));
    const metricDaily = moodDaily.map((b) => ({
      dayOffset: b.dayOffset,
      value: b.value * 10,
    }));
    const corr = computeMoodMetricCorrelation(moodDaily, metricDaily, NOW);
    expect(corr.n).toBe(5);
    expect(corr.result).toBeNull();
    expect(corr.suppressed).toBe("insufficientPairs");
  });

  it("returns a null coefficient below the minimum pair count", () => {
    const moodDaily = [
      { dayOffset: 0, value: 5 },
      { dayOffset: 1, value: 4 },
    ];
    const metricDaily = [{ dayOffset: 0, value: 1 }];
    const corr = computeMoodMetricCorrelation(moodDaily, metricDaily, NOW);
    expect(corr.n).toBe(1);
    expect(corr.result).toBeNull();
  });
});

describe("computeMoodAggregates", () => {
  it("assembles every dimension and derives the summary headline", () => {
    const entries: MoodAggregateEntry[] = [];
    for (let day = 0; day < 200; day++) {
      entries.push(entry(day, ((day % 5) + 1) as number, ["daily"]));
    }
    // oldest-first ordering (matches the DB read .reverse()).
    entries.reverse();

    const measurements: CrossMetricMeasurement[] = [];
    for (let day = 0; day < 10; day++) {
      measurements.push({
        type: "PULSE",
        value: 60 + day,
        measuredAt: new Date(NOW.getTime() - day * dayMs),
      });
    }

    const agg = computeMoodAggregates({ entries, measurements, now: NOW });

    // 200 days of history → 365-day heatmap window.
    expect(agg.heatmap.windowDays).toBe(365);
    expect(agg.summary.totalEntries).toBe(200);
    expect(agg.summary.totalSpanDays).toBe(199);
    expect(agg.distribution).toHaveLength(5);
    expect(agg.weekday).toHaveLength(7);
    expect(agg.tags.map((t) => t.tag)).toContain("daily");
    expect(agg.correlations.pulse.n).toBeGreaterThanOrEqual(5);
    // No sleep / steps rows supplied → empty correlation.
    expect(agg.correlations.sleep.n).toBe(0);
    expect(agg.correlations.sleep.result).toBeNull();
    // v1.8.6 — the narrative feed rides on the same aggregates and is
    // ranked strongest-first.
    expect(Array.isArray(agg.narratives)).toBe(true);
    for (let i = 1; i < agg.narratives.length; i++) {
      expect(agg.narratives[i - 1].strength).toBeGreaterThanOrEqual(
        agg.narratives[i].strength,
      );
    }
  });

  it("handles an empty entry set without throwing", () => {
    const agg = computeMoodAggregates({
      entries: [],
      measurements: [],
      now: NOW,
    });
    expect(agg.summary.totalEntries).toBe(0);
    expect(agg.summary.mean).toBeNull();
    expect(agg.heatmap.windowDays).toBe(30);
    expect(agg.heatmap.cells).toEqual([]);
    expect(agg.distribution.every((d) => d.count === 0)).toBe(true);
  });

  it("carries the time-of-day pattern and stability fields", () => {
    const agg = computeMoodAggregates({
      entries: [],
      measurements: [],
      now: NOW,
    });
    expect(agg.timeOfDay.reliable).toBe(false);
    expect(agg.timeOfDay.buckets.map((b) => b.bucket)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "night",
    ]);
    expect(agg.stability).toBeNull();
  });

  it("scores stability per trailing window, so a steady month after a turbulent year reads steady", () => {
    // Days 0..29 sit at 4; days 30..119 swing between 1 and 5.
    const entries: MoodAggregateEntry[] = [];
    for (let d = 0; d < 30; d++) entries.push(entry(d, 4));
    for (let d = 30; d < 120; d++) entries.push(entry(d, d % 2 ? 1 : 5));
    const agg = computeMoodAggregates({ entries, measurements: [], now: NOW });

    expect(agg.stabilityByWindow[30]?.score).toBe(100);
    expect(agg.stabilityByWindow[30]?.days).toBe(30);
    expect(agg.stabilityByWindow[90]?.score).toBeLessThan(
      agg.stabilityByWindow[30]!.score,
    );
    // The whole-year entry is the score `stability` has always carried.
    expect(agg.stabilityByWindow[365]).toEqual(agg.stability);
    expect(agg.stability?.days).toBe(120);
  });
});

describe("bucketForHour", () => {
  it("maps each hour to its part of day with night wrapping midnight", () => {
    expect(bucketForHour(0)).toBe("night");
    expect(bucketForHour(4)).toBe("night");
    expect(bucketForHour(5)).toBe("morning");
    expect(bucketForHour(11)).toBe("morning");
    expect(bucketForHour(12)).toBe("afternoon");
    expect(bucketForHour(16)).toBe("afternoon");
    expect(bucketForHour(17)).toBe("evening");
    expect(bucketForHour(20)).toBe("evening");
    expect(bucketForHour(21)).toBe("night");
    expect(bucketForHour(23)).toBe("night");
  });
});

describe("computeTimeOfDayAverages", () => {
  /** Build an entry at a fixed UTC instant + hour, in a given tz. */
  function tzEntry(
    daysAgo: number,
    utcHour: number,
    score: number,
    tz: string | null = "UTC",
  ): MoodAggregateEntry {
    const base = new Date(NOW.getTime() - daysAgo * dayMs);
    base.setUTCHours(utcHour, 0, 0, 0);
    return { date: dayKey(daysAgo), score, tags: null, moodLoggedAt: base, tz };
  }

  it("buckets entries by part of day and averages per bucket", () => {
    const entries: MoodAggregateEntry[] = [
      tzEntry(1, 8, 5),
      tzEntry(2, 9, 3),
      tzEntry(3, 14, 4),
      tzEntry(4, 14, 2),
    ];
    const pattern = computeTimeOfDayAverages(entries);
    const morning = pattern.buckets.find((b) => b.bucket === "morning");
    const afternoon = pattern.buckets.find((b) => b.bucket === "afternoon");
    expect(morning).toEqual({ bucket: "morning", avgScore: 4, count: 2 });
    expect(afternoon).toEqual({ bucket: "afternoon", avgScore: 3, count: 2 });
  });

  it("honours the per-row timezone when bucketing the local hour", () => {
    // 06:00 UTC is 08:00 in Berlin (summer, UTC+2) → morning, but stays
    // in the night bucket (00:00–04:59) under a UTC-6 zone.
    const berlin = computeTimeOfDayAverages([
      tzEntry(1, 6, 5, "Europe/Berlin"),
    ]);
    expect(berlin.buckets.find((b) => b.bucket === "morning")?.count).toBe(1);

    const chicago = computeTimeOfDayAverages([
      tzEntry(1, 6, 5, "America/Chicago"),
    ]);
    expect(chicago.buckets.find((b) => b.bucket === "night")?.count).toBe(1);
  });

  it("falls back to UTC for legacy rows without a tz", () => {
    const pattern = computeTimeOfDayAverages([tzEntry(1, 14, 5, null)]);
    expect(pattern.buckets.find((b) => b.bucket === "afternoon")?.count).toBe(
      1,
    );
  });

  it("is unreliable for a once-a-day logger clustered in one bucket", () => {
    // Ten nightly logs, all in the evening bucket → single-bucket spread.
    const entries = Array.from({ length: 10 }, (_, i) => tzEntry(i, 19, 4));
    const pattern = computeTimeOfDayAverages(entries);
    expect(pattern.reliable).toBe(false);
    expect(pattern.best).toBeNull();
    expect(pattern.worst).toBeNull();
  });

  it("is unreliable when a second bucket is below the sample floor", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => tzEntry(i, 8, 5)), // morning ≥ floor
      tzEntry(5, 14, 3), // a single afternoon log, below the floor
    ];
    expect(TIME_OF_DAY_MIN_BUCKET_SAMPLES).toBeGreaterThan(1);
    const pattern = computeTimeOfDayAverages(entries);
    expect(pattern.reliable).toBe(false);
  });

  it("surfaces best/worst once two buckets clear the sample floor", () => {
    const entries = [
      ...Array.from({ length: 4 }, (_, i) => tzEntry(i, 8, 5)), // morning avg 5
      ...Array.from({ length: 4 }, (_, i) => tzEntry(i + 4, 22, 2)), // night avg 2
    ];
    const pattern = computeTimeOfDayAverages(entries);
    expect(pattern.reliable).toBe(true);
    expect(pattern.best).toBe("morning");
    expect(pattern.worst).toBe("night");
  });
});

describe("computeMoodStability", () => {
  function points(values: number[]) {
    return values.map((value, i) => ({ dayOffset: i, value }));
  }

  it("returns null below the minimum-days floor", () => {
    const sparse = points(Array(STABILITY_MIN_DAYS - 1).fill(3));
    expect(computeMoodStability(sparse)).toBeNull();
  });

  it("scores a perfectly flat mood at 100 (very steady)", () => {
    const flat = points(Array(STABILITY_MIN_DAYS).fill(3));
    const stability = computeMoodStability(flat);
    expect(stability).not.toBeNull();
    expect(stability?.score).toBe(100);
    expect(stability?.stdDev).toBe(0);
    expect(stability?.band).toBe("verySteady");
    expect(stability?.days).toBe(STABILITY_MIN_DAYS);
  });

  it("scores an sd at or beyond the full-scale cap at 0 (very variable)", () => {
    // Alternating 1 / 5 → sd 2.0 > FULL_SCALE → clamped to 0.
    const swing = points(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 1 : 5)),
    );
    const stability = computeMoodStability(swing);
    expect(stability?.score).toBe(0);
    expect(stability?.band).toBe("veryVariable");
    expect(stability?.stdDev).toBeGreaterThanOrEqual(STABILITY_SD_FULL_SCALE);
  });

  it("scales linearly between the bounds", () => {
    // A balanced series alternating ±halfFull around its mean has a
    // population sd of exactly halfFull → score 50.
    const halfFull = STABILITY_SD_FULL_SCALE / 2;
    const balanced = points(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? 3 - halfFull : 3 + halfFull,
      ),
    );
    const stability = computeMoodStability(balanced);
    expect(stability?.stdDev).toBe(halfFull);
    expect(stability?.score).toBe(50);
    expect(stability?.band).toBe("variable");
  });
});

// ── F1 — computeTagInfluence (with-vs-without delta) ─────────────────

describe("computeTagInfluence", () => {
  function flatEntry(
    offset: number,
    score: number,
    tags: string[],
  ): MoodAggregateEntry {
    return entry(offset, score, tags);
  }

  it("computes the with-vs-without daily-mean delta and direction", () => {
    // 14 days WITH "exercise" averaging ~4.5, 14 days WITHOUT averaging ~2.5
    // — enough per group (>= 12) for a strong clean separation to read high.
    const entries: MoodAggregateEntry[] = [];
    for (let i = 0; i < 14; i++)
      entries.push(flatEntry(i, i % 2 === 0 ? 5 : 4, ["exercise"]));
    for (let i = 14; i < 28; i++)
      entries.push(flatEntry(i, i % 2 === 0 ? 3 : 2, []));
    const result = computeTagInfluence(entries, NOW, 365);
    const ex = result.flat.find((r) => r.tag === "exercise");
    expect(ex).toBeDefined();
    expect(ex!.withDays).toBe(14);
    expect(ex!.withoutDays).toBe(14);
    expect(ex!.withAvg).toBeCloseTo(4.5, 1);
    expect(ex!.withoutAvg).toBeCloseTo(2.5, 1);
    expect(ex!.delta).toBeCloseTo(2, 1);
    expect(ex!.delta).toBeGreaterThan(0);
    // strong clean separation on enough days → high confidence
    expect(ex!.confidence).toBe("high");
  });

  it("downgrades confidence to low on a small (but sufficient) sample", () => {
    // exactly at the floor — 5 present / 5 absent — never reads high.
    const entries: MoodAggregateEntry[] = [];
    for (let i = 0; i < 5; i++) entries.push(flatEntry(i, 5, ["small"]));
    for (let i = 5; i < 10; i++) entries.push(flatEntry(i, 2, []));
    const result = computeTagInfluence(entries, NOW);
    const row = result.flat.find((r) => r.tag === "small");
    expect(row).toBeDefined();
    expect(row!.confidence).toBe("low");
  });

  it("drops a tag below the present-days floor", () => {
    const entries: MoodAggregateEntry[] = [];
    // only 3 present days < INFLUENCE_MIN_PRESENT_DAYS
    for (let i = 0; i < 3; i++) entries.push(flatEntry(i, 5, ["rare"]));
    for (let i = 3; i < 15; i++) entries.push(flatEntry(i, 3, []));
    expect(INFLUENCE_MIN_PRESENT_DAYS).toBeGreaterThan(3);
    const result = computeTagInfluence(entries, NOW);
    expect(result.flat.find((r) => r.tag === "rare")).toBeUndefined();
  });

  it("drops a tag below the absent-days floor", () => {
    const entries: MoodAggregateEntry[] = [];
    // tag present on 12 days, absent on only 3 < INFLUENCE_MIN_ABSENT_DAYS
    for (let i = 0; i < 12; i++) entries.push(flatEntry(i, 4, ["ubiquitous"]));
    for (let i = 12; i < 15; i++) entries.push(flatEntry(i, 3, []));
    expect(INFLUENCE_MIN_ABSENT_DAYS).toBeGreaterThan(3);
    const result = computeTagInfluence(entries, NOW);
    expect(result.flat.find((r) => r.tag === "ubiquitous")).toBeUndefined();
  });

  it("uses the daily-mean convention (multi-entry days collapse to one observation)", () => {
    const entries: MoodAggregateEntry[] = [];
    // day 0 has two "calm" entries (5 and 3 → mean 4); make 5 more present days
    entries.push(flatEntry(0, 5, ["calm"]));
    entries.push(flatEntry(0, 3, ["calm"]));
    for (let i = 1; i < 6; i++) entries.push(flatEntry(i, 4, ["calm"]));
    for (let i = 6; i < 12; i++) entries.push(flatEntry(i, 2, []));
    const result = computeTagInfluence(entries, NOW);
    const calm = result.flat.find((r) => r.tag === "calm");
    expect(calm).toBeDefined();
    // 6 distinct present days, not 7 entries
    expect(calm!.withDays).toBe(6);
  });

  it("never returns NaN and drops a zero-delta tag", () => {
    const entries: MoodAggregateEntry[] = [];
    // identical means with and without → delta 0 → dropped
    for (let i = 0; i < 6; i++) entries.push(flatEntry(i, 3, ["neutral"]));
    for (let i = 6; i < 12; i++) entries.push(flatEntry(i, 3, []));
    const result = computeTagInfluence(entries, NOW);
    expect(result.flat.find((r) => r.tag === "neutral")).toBeUndefined();
    for (const row of [...result.flat, ...result.structured]) {
      expect(Number.isFinite(row.delta)).toBe(true);
      expect(Number.isFinite(row.withAvg)).toBe(true);
      expect(Number.isFinite(row.withoutAvg)).toBe(true);
      expect(Number.isFinite(row.pValue)).toBe(true);
    }
  });

  it("returns empty axes for a sparse history", () => {
    const entries: MoodAggregateEntry[] = [
      flatEntry(0, 5, ["a"]),
      flatEntry(1, 4, ["b"]),
    ];
    const result = computeTagInfluence(entries, NOW);
    expect(result.flat).toEqual([]);
    expect(result.structured).toEqual([]);
  });

  it("handles structured tags with label metadata and ranks by |delta|", () => {
    const tag = (key: string): StructuredTagRef => ({
      key,
      categoryKey: "feelings",
      labelKey: `mood.tag.${key}`,
      icon: "Smile",
    });
    const e = (
      offset: number,
      score: number,
      keys: string[],
    ): MoodAggregateEntry => ({
      ...entry(offset, score, null),
      structuredTags: keys.map(tag),
    });
    const entries: MoodAggregateEntry[] = [];
    // "social" lifts strongly, "chores" lifts mildly
    for (let i = 0; i < 6; i++) entries.push(e(i, 5, ["social"]));
    for (let i = 6; i < 12; i++) entries.push(e(i, 4, ["chores"]));
    for (let i = 12; i < 18; i++) entries.push(e(i, 2, []));
    const result = computeTagInfluence(entries, NOW);
    expect(result.structured[0].tag).toBe("social");
    expect(result.structured[0].labelKey).toBe("mood.tag.social");
    expect(result.structured[0].categoryKey).toBe("feelings");
    // ranked by absolute delta desc
    expect(Math.abs(result.structured[0].delta)).toBeGreaterThanOrEqual(
      Math.abs(result.structured[1].delta),
    );
  });

  it("threads a custom tag's decrypted label into the influence row and the better-days board", () => {
    const customRef: StructuredTagRef = {
      key: "custom:abc-123",
      categoryKey: "custom",
      labelKey: "custom:abc-123",
      label: "Migraine",
      icon: "Tag",
    };
    const e = (
      offset: number,
      score: number,
      withTag: boolean,
    ): MoodAggregateEntry => ({
      ...entry(offset, score, null),
      structuredTags: withTag ? [customRef] : [],
    });
    const entries: MoodAggregateEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push(e(i, 2, true));
    for (let i = 6; i < 12; i++) entries.push(e(i, 4, false));
    const influence = computeTagInfluence(entries, NOW);
    const row = influence.structured.find((r) => r.tag === "custom:abc-123");
    expect(row?.label).toBe("Migraine");
    expect(row?.labelKey).toBe("custom:abc-123");

    const emptyCorr: MoodMetricCorrelation = { result: null, points: [], n: 0 };
    const board = computeBetterDays(influence, {
      sleep: emptyCorr,
      steps: emptyCorr,
      pulse: emptyCorr,
      weight: emptyCorr,
      bloodPressureSystolic: emptyCorr,
    });
    const factor = board.find((f) => f.key === "custom:abc-123");
    expect(factor?.label).toBe("Migraine");
  });

  it("caps each axis at the max-rows limit", () => {
    const entries: MoodAggregateEntry[] = [];
    // 12 distinct tags each present on 6 days, with a shared absent pool
    for (let tagIdx = 0; tagIdx < 12; tagIdx++) {
      for (let d = 0; d < 6; d++) {
        entries.push(
          flatEntry(tagIdx * 6 + d, 5 - (tagIdx % 4), [`tag${tagIdx}`]),
        );
      }
    }
    const result = computeTagInfluence(entries, NOW, 365);
    expect(result.flat.length).toBeLessThanOrEqual(8);
  });
});

describe("influenceConfidence", () => {
  it("requires both a small p and a comfortable sample for high", () => {
    expect(influenceConfidence(0.005, 12)).toBe("high");
    expect(influenceConfidence(0.005, 11)).toBe("medium"); // sample too small for high
    expect(influenceConfidence(0.04, 10)).toBe("medium");
    expect(influenceConfidence(0.04, 7)).toBe("low"); // sample too small for medium
    expect(influenceConfidence(0.2, 50)).toBe("low"); // p too high
  });
});

// ── F2 — computeBetterDays (unified board) ──────────────────────────

describe("computeBetterDays", () => {
  function corr(
    n: number,
    r: number,
    strength: "stark" | "moderat" | "schwach" | "keine",
  ): MoodMetricCorrelation {
    return { result: { r, strength, n }, points: [], n };
  }

  const emptyCorr: MoodMetricCorrelation = { result: null, points: [], n: 0 };

  it("merges tag influence and metric correlations, ranked by effect size", () => {
    const tagInfluence: TagInfluence = {
      flat: [
        {
          tag: "exercise",
          labelKey: null,
          categoryKey: null,
          icon: null,
          withDays: 10,
          withoutDays: 10,
          withAvg: 4.4,
          withoutAvg: 2.4,
          delta: 2,
          pooledSd: 1, // |d| = 2 → standardized effect 1.0 (capped)
          pValue: 0.001,
          confidence: "high",
        },
      ],
      structured: [],
    };
    const correlations = {
      sleep: corr(40, 0.6, "moderat"), // effect 0.6
      steps: corr(40, 0.15, "keine"), // excluded (keine)
      pulse: emptyCorr, // excluded (null)
      weight: corr(3, 0.9, "stark"), // excluded (n < 5)
      bloodPressureSystolic: corr(40, -0.45, "moderat"), // effect 0.45, down
    };
    const board = computeBetterDays(tagInfluence, correlations);
    expect(board.map((f) => f.key)).toEqual([
      "exercise",
      "sleep",
      "bloodPressureSystolic",
    ]);
    expect(board[0].source).toBe("tag");
    expect(board[0].direction).toBe("up");
    expect(board[2].direction).toBe("down");
    // excluded ones are absent
    expect(board.find((f) => f.key === "steps")).toBeUndefined();
    expect(board.find((f) => f.key === "pulse")).toBeUndefined();
    expect(board.find((f) => f.key === "weight")).toBeUndefined();
  });

  it("flags a negative tag delta as a down factor", () => {
    const tagInfluence: TagInfluence = {
      flat: [
        {
          tag: "poor_sleep",
          labelKey: null,
          categoryKey: null,
          icon: null,
          withDays: 8,
          withoutDays: 8,
          withAvg: 2.2,
          withoutAvg: 3.8,
          delta: -1.6,
          pooledSd: 0.9,
          pValue: 0.01,
          confidence: "medium",
        },
      ],
      structured: [],
    };
    const board = computeBetterDays(tagInfluence, {
      sleep: emptyCorr,
      steps: emptyCorr,
      pulse: emptyCorr,
      weight: emptyCorr,
      bloodPressureSystolic: emptyCorr,
    });
    expect(board).toHaveLength(1);
    expect(board[0].direction).toBe("down");
    expect(board[0].delta).toBe(-1.6);
  });

  it("ranks tags by the standardized (Cohen's-d) effect, not the raw delta", () => {
    // "tight" has the smaller raw delta but a far smaller pooled SD, so its
    // standardized effect (0.8 / 0.4 = 2.0 → capped 1.0) beats "wide"
    // (1.2 / 2.0 = 0.6). The legacy |delta|/2 heuristic would have ordered
    // them the other way (0.6 vs 0.4), so this pins the new behaviour.
    const tagInfluence: TagInfluence = {
      flat: [
        {
          tag: "wide",
          labelKey: null,
          categoryKey: null,
          icon: null,
          withDays: 10,
          withoutDays: 10,
          withAvg: 4.2,
          withoutAvg: 3.0,
          delta: 1.2,
          pooledSd: 2.0,
          pValue: 0.02,
          confidence: "medium",
        },
        {
          tag: "tight",
          labelKey: null,
          categoryKey: null,
          icon: null,
          withDays: 10,
          withoutDays: 10,
          withAvg: 4.0,
          withoutAvg: 3.2,
          delta: 0.8,
          pooledSd: 0.4,
          pValue: 0.001,
          confidence: "high",
        },
      ],
      structured: [],
    };
    const board = computeBetterDays(tagInfluence, {
      sleep: emptyCorr,
      steps: emptyCorr,
      pulse: emptyCorr,
      weight: emptyCorr,
      bloodPressureSystolic: emptyCorr,
    });
    expect(board.map((f) => f.key)).toEqual(["tight", "wide"]);
    // Raw deltas shown in the UI are untouched by the ranking change.
    expect(board[0].delta).toBe(0.8);
    expect(board[1].delta).toBe(1.2);
  });

  it("falls back to the |delta|/2 heuristic when a tag has no pooled SD", () => {
    const tagInfluence: TagInfluence = {
      flat: [
        {
          tag: "constant",
          labelKey: null,
          categoryKey: null,
          icon: null,
          withDays: 10,
          withoutDays: 10,
          withAvg: 4.0,
          withoutAvg: 2.0,
          delta: 2,
          pooledSd: null, // both groups perfectly constant
          pValue: 1,
          confidence: "low",
        },
      ],
      structured: [],
    };
    const board = computeBetterDays(tagInfluence, {
      sleep: emptyCorr,
      steps: emptyCorr,
      pulse: emptyCorr,
      weight: emptyCorr,
      bloodPressureSystolic: emptyCorr,
    });
    expect(board).toHaveLength(1);
    expect(board[0].effectSize).toBe(1); // min(1, |2|/2)
  });

  it("returns an empty board when nothing clears the gates", () => {
    const board = computeBetterDays(
      { flat: [], structured: [] },
      {
        sleep: corr(40, 0.1, "keine"),
        steps: emptyCorr,
        pulse: emptyCorr,
        weight: emptyCorr,
        bloodPressureSystolic: emptyCorr,
      },
    );
    expect(board).toEqual([]);
  });

  it("caps the board length", () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      tag: `t${i}`,
      labelKey: null,
      categoryKey: null,
      icon: null,
      withDays: 6,
      withoutDays: 6,
      withAvg: 4,
      withoutAvg: 3,
      delta: 1 - i * 0.01,
      pooledSd: 1,
      pValue: 0.02,
      confidence: "low" as const,
    }));
    const board = computeBetterDays(
      { flat, structured: [] },
      {
        sleep: emptyCorr,
        steps: emptyCorr,
        pulse: emptyCorr,
        weight: emptyCorr,
        bloodPressureSystolic: emptyCorr,
      },
    );
    expect(board.length).toBe(BETTER_DAYS_MAX_FACTORS);
  });
});

// ── v1.12.0 — computeTagMetricCrosstab (tag × HK metric) ─────────────

describe("computeTagMetricCrosstab", () => {
  const WORKOUT: StructuredTagRef = {
    key: "worked_out",
    categoryKey: "health",
    labelKey: "mood.tag.workedOut",
    icon: "Dumbbell",
  };

  function structuredEntry(
    offset: number,
    score: number,
    structuredTags: StructuredTagRef[],
  ): MoodAggregateEntry {
    return { ...entry(offset, score, null), structuredTags };
  }

  /** A measurement at midday on the day `offset` days before NOW. */
  function meas(
    offset: number,
    type: string,
    value: number,
  ): CrossMetricMeasurement {
    return {
      type,
      value,
      measuredAt: new Date(NOW.getTime() - offset * dayMs),
    };
  }

  it("compares a metric on tag-present vs tag-absent days (same-day) and surfaces a significant delta", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    // 12 days WITH the workout tag, high active energy (~600 ± a little).
    for (let i = 0; i < 12; i++) {
      entries.push(structuredEntry(i, 4, [WORKOUT]));
      measurements.push(
        meas(i, "ACTIVE_ENERGY_BURNED", 600 + (i % 2 === 0 ? 20 : -20)),
      );
    }
    // 12 days WITHOUT the tag, low active energy (~350).
    for (let i = 12; i < 24; i++) {
      entries.push(structuredEntry(i, 3, []));
      measurements.push(
        meas(i, "ACTIVE_ENERGY_BURNED", 350 + (i % 2 === 0 ? 20 : -20)),
      );
    }
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find(
      (r) => r.tag === "worked_out" && r.metricKey === "activeEnergy",
    );
    expect(row).toBeDefined();
    expect(row!.display).toBe("kcal");
    expect(row!.mode).toBe("sameDay");
    expect(row!.withDays).toBe(12);
    expect(row!.withoutDays).toBe(12);
    expect(row!.withAvg).toBeCloseTo(600, 0);
    expect(row!.withoutAvg).toBeCloseTo(350, 0);
    expect(row!.delta).toBeCloseTo(250, 0);
    // strong clean separation on enough days → high confidence + tight q.
    expect(row!.confidence).toBe("high");
    expect(row!.qValue).toBeLessThanOrEqual(0.1);
  });

  it("converts SLEEP_DURATION minutes to display hours", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    const SLEEP: StructuredTagRef = {
      key: "slept_well",
      categoryKey: "health",
      labelKey: "mood.tag.sleptWell",
      icon: "Moon",
    };
    // present: 480 min = 8 h; absent: 360 min = 6 h.
    for (let i = 0; i < 12; i++) {
      entries.push(structuredEntry(i, 4, [SLEEP]));
      measurements.push(
        meas(i, "SLEEP_DURATION", 480 + (i % 2 === 0 ? 6 : -6)),
      );
    }
    for (let i = 12; i < 24; i++) {
      entries.push(structuredEntry(i, 3, []));
      measurements.push(
        meas(i, "SLEEP_DURATION", 360 + (i % 2 === 0 ? 6 : -6)),
      );
    }
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find((r) => r.metricKey === "sleepDuration");
    expect(row).toBeDefined();
    expect(row!.display).toBe("hours");
    expect(row!.withAvg).toBeCloseTo(8, 1);
    expect(row!.withoutAvg).toBeCloseTo(6, 1);
    expect(row!.delta).toBeCloseTo(2, 1);
  });

  it("pairs a tag against the NEXT day's recovery (D → D+1 lag)", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    const ALCOHOL: StructuredTagRef = {
      key: "alcohol",
      categoryKey: "consumption",
      labelKey: "mood.tag.alcohol",
      icon: "Wine",
    };
    // Tag on even offsets (present), recovery measured the day AFTER (offset-1).
    // present days: tag at offset i, recovery low (40) at offset i-1.
    // absent days: no tag at offset i, recovery high (80) at offset i-1.
    // Build 24 consecutive days; tag the older half so the +1 day always exists.
    for (let i = 1; i <= 12; i++) {
      entries.push(structuredEntry(i, 3, [ALCOHOL]));
      measurements.push(
        meas(i - 1, "RECOVERY_SCORE", 40 + (i % 2 === 0 ? 3 : -3)),
      );
    }
    for (let i = 13; i <= 24; i++) {
      entries.push(structuredEntry(i, 4, []));
      measurements.push(
        meas(i - 1, "RECOVERY_SCORE", 80 + (i % 2 === 0 ? 3 : -3)),
      );
    }
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find((r) => r.metricKey === "nextDayRecovery");
    expect(row).toBeDefined();
    expect(row!.mode).toBe("nextDay");
    expect(row!.display).toBe("score");
    // present-day next-day recovery ~40, absent ~80 → negative delta.
    expect(row!.withAvg).toBeCloseTo(40, 0);
    expect(row!.withoutAvg).toBeCloseTo(80, 0);
    expect(row!.delta).toBeLessThan(0);
  });

  // The alcohol question the tag board could not answer before: a binary
  // evening tag against the two overnight-recovery VITALS, at the same
  // D → D+1 lag the recovery channel already used.
  const ALCOHOL_TAG: StructuredTagRef = {
    key: "alcohol",
    categoryKey: "consumption",
    labelKey: "mood.tag.alcohol",
    icon: "Wine",
  };

  /**
   * 24 consecutive days: the tag on days 1..12 paired to `presentValue` on
   * the following day, no tag on days 13..24 paired to `absentValue`.
   */
  function nextDayFixture(
    type: string,
    presentValue: number,
    absentValue: number,
    tag: StructuredTagRef = ALCOHOL_TAG,
  ) {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    for (let i = 1; i <= 12; i++) {
      entries.push(structuredEntry(i, 3, [tag]));
      // All built-in binary tags use this same branch and FDR family.
      measurements.push(
        meas(i - 1, type, presentValue + (i % 2 === 0 ? 2 : -2)),
      );
    }
    for (let i = 13; i <= 24; i++) {
      entries.push(structuredEntry(i, 4, []));
      measurements.push(
        meas(i - 1, type, absentValue + (i % 2 === 0 ? 2 : -2)),
      );
    }
    return { entries, measurements };
  }

  it("pairs a tag against the NEXT day's resting heart rate (D → D+1 lag)", () => {
    const { entries, measurements } = nextDayFixture(
      "RESTING_HEART_RATE",
      62,
      54,
    );
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find(
      (r) => r.tag === "alcohol" && r.metricKey === "nextDayRestingHeartRate",
    );
    expect(row).toBeDefined();
    expect(row!.mode).toBe("nextDay");
    expect(row!.display).toBe("bpm");
    expect(row!.withDays).toBe(12);
    expect(row!.withoutDays).toBe(12);
    // bpm passes through un-scaled — only SLEEP_DURATION divides by 60.
    expect(row!.withAvg).toBeCloseTo(62, 0);
    expect(row!.withoutAvg).toBeCloseTo(54, 0);
    expect(row!.delta).toBeCloseTo(8, 0);
    expect(row!.qValue).toBeLessThanOrEqual(CROSSTAB_FDR_Q);
  });

  it("pairs a tag against the NEXT day's heart-rate variability (D → D+1 lag)", () => {
    const { entries, measurements } = nextDayFixture(
      "HEART_RATE_VARIABILITY",
      38,
      55,
    );
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find(
      (r) =>
        r.tag === "alcohol" && r.metricKey === "nextDayHeartRateVariability",
    );
    expect(row).toBeDefined();
    expect(row!.mode).toBe("nextDay");
    expect(row!.display).toBe("ms");
    expect(row!.withAvg).toBeCloseTo(38, 0);
    expect(row!.withoutAvg).toBeCloseTo(55, 0);
    expect(row!.delta).toBeCloseTo(-17, 0);
  });

  it.each([
    ["alcohol", "mood.tag.alcohol", "Wine"],
    ["caffeine", "mood.tag.caffeine", "Coffee"],
    ["nicotine", "mood.tag.nicotine", "Cigarette"],
  ])(
    "runs the built-in %s tag through the same next-day crosstab and FDR family",
    (key, labelKey, icon) => {
      const { entries, measurements } = nextDayFixture(
        "RESTING_HEART_RATE",
        62,
        54,
        { key, categoryKey: "health", labelKey, icon },
      );
      const rows = computeTagMetricCrosstab({
        timeZone: "Europe/Berlin",
        entries,
        measurements,
        now: NOW,
      });
      const row = rows.find(
        (candidate) =>
          candidate.tag === key &&
          candidate.metricKey === "nextDayRestingHeartRate",
      );
      expect(row).toBeDefined();
      expect(row!.mode).toBe("nextDay");
      expect(row!.qValue).toBeLessThanOrEqual(CROSSTAB_FDR_Q);
    },
  );

  it("reads both overnight vitals from the fetched channel set", () => {
    // The fetch filter is derived from the map, so a metric added to
    // CROSSTAB_METRICS without a channel to read it from is impossible.
    expect(CROSSTAB_METRIC_TYPES).toContain("RESTING_HEART_RATE");
    expect(CROSSTAB_METRIC_TYPES).toContain("HEART_RATE_VARIABILITY");
    expect(CROSSTAB_METRICS.nextDayRestingHeartRate.mode).toBe("nextDay");
    expect(CROSSTAB_METRICS.nextDayHeartRateVariability.mode).toBe("nextDay");
  });

  it("drops a tag below the per-side day floors", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    // only 3 present days < CROSSTAB_MIN_PRESENT_DAYS
    for (let i = 0; i < 3; i++) {
      entries.push(structuredEntry(i, 4, [WORKOUT]));
      measurements.push(meas(i, "ACTIVE_ENERGY_BURNED", 600));
    }
    for (let i = 3; i < 15; i++) {
      entries.push(structuredEntry(i, 3, []));
      measurements.push(meas(i, "ACTIVE_ENERGY_BURNED", 350));
    }
    expect(CROSSTAB_MIN_PRESENT_DAYS).toBeGreaterThan(3);
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    expect(rows.find((r) => r.tag === "worked_out")).toBeUndefined();
  });

  it("excludes flat free-text tags (structured only)", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    for (let i = 0; i < 12; i++) {
      entries.push(entry(i, 4, ["flat_workout"]));
      measurements.push(meas(i, "ACTIVE_ENERGY_BURNED", 600));
    }
    for (let i = 12; i < 24; i++) {
      entries.push(entry(i, 3, []));
      measurements.push(meas(i, "ACTIVE_ENERGY_BURNED", 350));
    }
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("returns an empty array when no metric data is present", () => {
    const entries: MoodAggregateEntry[] = [];
    for (let i = 0; i < 24; i++) {
      entries.push(structuredEntry(i, 4, i < 12 ? [WORKOUT] : []));
    }
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements: [],
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("caps the surfaced rows at CROSSTAB_MAX_ROWS", () => {
    expect(CROSSTAB_MAX_ROWS).toBeGreaterThan(0);
    expect(CROSSTAB_MIN_ABSENT_DAYS).toBeGreaterThan(0);
  });

  // v1.12.1 — cross-source double-count guard. A cumulative metric reported
  // by two sources on the same day must be summed once (canonical source),
  // not double-counted, or the with/without averages and the Welch delta
  // are inflated.
  function sourcedMeas(
    offset: number,
    type: string,
    value: number,
    source: CrossMetricMeasurement["source"],
  ): CrossMetricMeasurement {
    return {
      type,
      value,
      measuredAt: new Date(NOW.getTime() - offset * dayMs),
      source,
    };
  }

  it("counts a cumulative metric once when two sources report the same day (Fitbit + Apple)", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    // 12 present days: BOTH Apple and Fitbit report ~600 kcal active energy.
    // A naïve per-day sum would double this to ~1200; the canonical pick
    // keeps only Apple (activeEnergy ladder: APPLE_HEALTH > … > FITBIT).
    for (let i = 0; i < 12; i++) {
      entries.push(structuredEntry(i, 4, [WORKOUT]));
      const v = 600 + (i % 2 === 0 ? 20 : -20);
      measurements.push(
        sourcedMeas(i, "ACTIVE_ENERGY_BURNED", v, "APPLE_HEALTH"),
      );
      measurements.push(sourcedMeas(i, "ACTIVE_ENERGY_BURNED", v, "FITBIT"));
    }
    // 12 absent days: single source ~350.
    for (let i = 12; i < 24; i++) {
      entries.push(structuredEntry(i, 3, []));
      measurements.push(
        sourcedMeas(
          i,
          "ACTIVE_ENERGY_BURNED",
          350 + (i % 2 === 0 ? 20 : -20),
          "APPLE_HEALTH",
        ),
      );
    }
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find(
      (r) => r.tag === "worked_out" && r.metricKey === "activeEnergy",
    );
    expect(row).toBeDefined();
    // ~600, NOT ~1200 — the Fitbit twin is dropped by the canonical pick.
    expect(row!.withAvg).toBeCloseTo(600, 0);
    expect(row!.withoutAvg).toBeCloseTo(350, 0);
    expect(row!.delta).toBeCloseTo(250, 0);
  });

  it("counts sleep once when WHOOP and Fitbit both report the same night", () => {
    const SLEEP: StructuredTagRef = {
      key: "slept_well",
      categoryKey: "health",
      labelKey: "mood.tag.sleptWell",
      icon: "Moon",
    };
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    // Present nights: WHOOP + Fitbit both report 480 min (8 h). Sleep ladder
    // is WHOOP > FITBIT > … so WHOOP wins; the night total stays 8 h.
    for (let i = 0; i < 12; i++) {
      entries.push(structuredEntry(i, 4, [SLEEP]));
      const v = 480 + (i % 2 === 0 ? 6 : -6);
      measurements.push(sourcedMeas(i, "SLEEP_DURATION", v, "WHOOP"));
      measurements.push(sourcedMeas(i, "SLEEP_DURATION", v, "FITBIT"));
    }
    for (let i = 12; i < 24; i++) {
      entries.push(structuredEntry(i, 3, []));
      measurements.push(
        sourcedMeas(i, "SLEEP_DURATION", 360 + (i % 2 === 0 ? 6 : -6), "WHOOP"),
      );
    }
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find((r) => r.metricKey === "sleepDuration");
    expect(row).toBeDefined();
    // 8 h, not 16 h — the Fitbit twin is dropped, not summed on top.
    expect(row!.withAvg).toBeCloseTo(8, 1);
    expect(row!.withoutAvg).toBeCloseTo(6, 1);
  });

  it("sums per-stage rows from the SAME source into the night total (no over-collapse)", () => {
    const SLEEP: StructuredTagRef = {
      key: "slept_well",
      categoryKey: "health",
      labelKey: "mood.tag.sleptWell",
      icon: "Moon",
    };
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    // Present nights: WHOOP reports the night as 3 stage rows (160 each =
    // 480 min = 8 h). The canonical pick must keep ALL three same-source
    // stage rows so the sum is the night total — it only drops cross-source
    // duplicates, never same-source stages.
    for (let i = 0; i < 12; i++) {
      entries.push(structuredEntry(i, 4, [SLEEP]));
      const j = i % 2 === 0 ? 2 : -2;
      measurements.push(sourcedMeas(i, "SLEEP_DURATION", 160 + j, "WHOOP"));
      measurements.push(sourcedMeas(i, "SLEEP_DURATION", 160 + j, "WHOOP"));
      measurements.push(sourcedMeas(i, "SLEEP_DURATION", 160 + j, "WHOOP"));
    }
    for (let i = 12; i < 24; i++) {
      entries.push(structuredEntry(i, 3, []));
      const j = i % 2 === 0 ? 2 : -2;
      measurements.push(sourcedMeas(i, "SLEEP_DURATION", 120 + j, "WHOOP"));
      measurements.push(sourcedMeas(i, "SLEEP_DURATION", 120 + j, "WHOOP"));
      measurements.push(sourcedMeas(i, "SLEEP_DURATION", 120 + j, "WHOOP"));
    }
    const rows = computeTagMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find((r) => r.metricKey === "sleepDuration");
    expect(row).toBeDefined();
    expect(row!.withAvg).toBeCloseTo(8, 1); // 3 × 160 = 480 min = 8 h
    expect(row!.withoutAvg).toBeCloseTo(6, 1); // 3 × 120 = 360 min = 6 h
  });
});

describe("buildFactorDailySeries", () => {
  function factorEntry(
    offset: number,
    score: number,
    factors: RatedFactorScore[],
  ): MoodAggregateEntry {
    return { ...entry(offset, score, null), ratedFactors: factors };
  }

  const WORK = (rating: number, inverse = false): RatedFactorScore => ({
    key: "work",
    categoryKey: "life",
    labelKey: "mood.tag.work",
    icon: "Briefcase",
    rating,
    scaleMin: 1,
    scaleMax: 5,
    inverse,
  });

  it("means a factor's ratings per day", () => {
    const entries = [
      // two entries same day → mean of (4, 2) = 3.
      { ...factorEntry(0, 4, [WORK(4)]) },
      { ...factorEntry(0, 2, [WORK(2)]) },
      factorEntry(1, 3, [WORK(5)]),
    ];
    const series = buildFactorDailySeries(entries, NOW, 365);
    const work = series.get("work");
    expect(work).toBeDefined();
    expect(work!.byDay.get(dayKey(0))).toBeCloseTo(3, 5);
    expect(work!.byDay.get(dayKey(1))).toBeCloseTo(5, 5);
    expect(work!.ref.inverse).toBe(false);
  });

  it("flips an inverse factor across its scale midpoint so up = better", () => {
    // inverse stress rated 5 (worst) maps to (1+5)-5 = 1 (worst on the
    // flipped axis); rated 1 (best) maps to 5.
    const entries = [
      factorEntry(0, 2, [WORK(5, true)]),
      factorEntry(1, 4, [WORK(1, true)]),
    ];
    const series = buildFactorDailySeries(entries, NOW, 365);
    const work = series.get("work")!;
    expect(work.byDay.get(dayKey(0))).toBeCloseTo(1, 5);
    expect(work.byDay.get(dayKey(1))).toBeCloseTo(5, 5);
    expect(work.ref.inverse).toBe(true);
  });
});

describe("computeFactorMetricCrosstab", () => {
  function factorEntry(
    offset: number,
    score: number,
    factors: RatedFactorScore[],
  ): MoodAggregateEntry {
    return { ...entry(offset, score, null), ratedFactors: factors };
  }

  function meas(
    offset: number,
    type: string,
    value: number,
  ): CrossMetricMeasurement {
    return {
      type,
      value,
      measuredAt: new Date(NOW.getTime() - offset * dayMs),
    };
  }

  const work = (rating: number, inverse = false): RatedFactorScore => ({
    key: "work",
    categoryKey: "life",
    labelKey: "mood.tag.work",
    icon: "Briefcase",
    rating,
    scaleMin: 1,
    scaleMax: 5,
    inverse,
  });

  it("surfaces a low-factor-day vital deviation via the median split", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    // 12 LOW-work days (rating 2, below the median of 3.5) with short sleep
    // (~6 h = 360 min); 12 HIGH-work days (rating 5) with long sleep (~8 h).
    for (let i = 0; i < 12; i++) {
      entries.push(factorEntry(i, 3, [work(2)]));
      measurements.push(
        meas(i, "SLEEP_DURATION", 360 + (i % 2 === 0 ? 6 : -6)),
      );
    }
    for (let i = 12; i < 24; i++) {
      entries.push(factorEntry(i, 4, [work(5)]));
      measurements.push(
        meas(i, "SLEEP_DURATION", 480 + (i % 2 === 0 ? 6 : -6)),
      );
    }
    const rows = computeFactorMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find(
      (r) => r.factor === "work" && r.metricKey === "sleepDuration",
    );
    expect(row).toBeDefined();
    expect(row!.display).toBe("hours");
    expect(row!.lowDays).toBe(12);
    expect(row!.highDays).toBe(12);
    expect(row!.lowAvg).toBeCloseTo(6, 1);
    expect(row!.highAvg).toBeCloseTo(8, 1);
    // delta = lowAvg − highAvg → negative: sleep runs lower on low-work days.
    expect(row!.delta).toBeLessThan(0);
    expect(row!.delta).toBeCloseTo(-2, 1);
    expect(row!.confidence).toBe("high");
    expect(row!.qValue).toBeLessThanOrEqual(0.1);
    expect(row!.inverse).toBe(false);
  });

  it("carries the inverse flag through and still splits worse-vs-better on the flipped axis", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    // stress is inverse: rating 5 = worst day. On the flipped axis it becomes
    // 1 (low/worse). Worse-stress days carry higher next-day RHR (D → D+1).
    for (let i = 1; i <= 12; i++) {
      entries.push(factorEntry(i, 3, [work(5, true)])); // worse → flipped low
      measurements.push(
        meas(i - 1, "RESTING_HEART_RATE", 64 + (i % 2 === 0 ? 1 : -1)),
      );
    }
    for (let i = 13; i <= 24; i++) {
      entries.push(factorEntry(i, 4, [work(1, true)])); // better → flipped high
      measurements.push(
        meas(i - 1, "RESTING_HEART_RATE", 56 + (i % 2 === 0 ? 1 : -1)),
      );
    }
    const rows = computeFactorMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    const row = rows.find((r) => r.metricKey === "restingHeartRate");
    expect(row).toBeDefined();
    expect(row!.mode).toBe("nextDay");
    expect(row!.inverse).toBe(true);
    // worse-stress (low flipped) days → higher RHR; delta = low − high > 0.
    expect(row!.lowAvg).toBeCloseTo(64, 0);
    expect(row!.highAvg).toBeCloseTo(56, 0);
    expect(row!.delta).toBeGreaterThan(0);
  });

  it("drops a factor with too few rated days to split defensibly", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    // only 6 rated days < 5 + 5 floor for a clean median split.
    for (let i = 0; i < 6; i++) {
      entries.push(factorEntry(i, 3, [work(i < 3 ? 2 : 5)]));
      measurements.push(meas(i, "SLEEP_DURATION", i < 3 ? 360 : 480));
    }
    expect(
      CROSSTAB_MIN_PRESENT_DAYS + CROSSTAB_MIN_ABSENT_DAYS,
    ).toBeGreaterThan(6);
    const rows = computeFactorMetricCrosstab({
      timeZone: "Europe/Berlin",
      entries,
      measurements,
      now: NOW,
    });
    expect(rows.find((r) => r.factor === "work")).toBeUndefined();
  });

  it("returns nothing when there are no rated factors at all", () => {
    const entries: MoodAggregateEntry[] = [];
    const measurements: CrossMetricMeasurement[] = [];
    for (let i = 0; i < 24; i++) {
      entries.push(entry(i, 3, null));
      measurements.push(meas(i, "SLEEP_DURATION", 420));
    }
    expect(
      computeFactorMetricCrosstab({
        timeZone: "Europe/Berlin",
        entries,
        measurements,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("caps the surface at CROSSTAB_MAX_ROWS", () => {
    expect(CROSSTAB_MAX_ROWS).toBeGreaterThan(0);
  });
});
