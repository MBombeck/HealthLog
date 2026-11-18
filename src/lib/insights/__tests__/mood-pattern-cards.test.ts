import { describe, expect, it } from "vitest";

import type { MoodAggregateEntry } from "@/lib/insights/mood-aggregates";
import { shiftDateKey } from "@/lib/tz/format";

import {
  computeMoodPatterns,
  moodPatternsWire,
  PATTERN_MIN_DAYS_PER_SIDE,
  weekdayOfKey,
} from "../mood-pattern-cards";

const TODAY = "2026-10-11"; // a Sunday

/** A deterministic pseudo-random stream (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entry(
  date: string,
  score: number,
  extra: Partial<MoodAggregateEntry> = {},
): MoodAggregateEntry {
  return {
    date,
    score,
    tags: null,
    moodLoggedAt: new Date(`${date}T18:00:00.000Z`),
    ...extra,
  };
}

function days(n: number, score: (date: string, i: number) => number) {
  return Array.from({ length: n }, (_, i) => {
    const date = shiftDateKey(TODAY, -(n - 1 - i));
    return entry(date, score(date, i));
  });
}

function run(entries: MoodAggregateEntry[], noteDays = new Set<string>()) {
  return computeMoodPatterns({
    entries,
    noteDays,
    todayKey: TODAY,
    windowDays: 365,
  });
}

describe("computeMoodPatterns", () => {
  it("finds a clear weekend effect and names it", () => {
    const r = rng(7);
    const entries = days(120, (date) =>
      Math.min(
        5,
        Math.max(1, (weekdayOfKey(date) >= 5 ? 4.2 : 3) + (r() - 0.5)),
      ),
    );
    const patterns = run(entries);
    const weekend = patterns.find((p) => p.kind === "weekend");
    expect(weekend).toBeDefined();
    expect(weekend).toMatchObject({
      id: "weekend",
      direction: "higher",
      strength: "strong",
    });
    expect(weekend!.sampleSize.subject).toBeGreaterThanOrEqual(
      PATTERN_MIN_DAYS_PER_SIDE,
    );
    expect(weekend!.values.subject).toBeGreaterThan(weekend!.values.comparison);
    // Saturday or Sunday is the best weekday, and only one is published.
    const best = patterns.filter((p) => p.kind === "best_weekday");
    expect(best.length).toBeLessThanOrEqual(1);
    if (best[0]) expect(best[0].values.weekday).toBeGreaterThanOrEqual(5);
  });

  it("finds nothing in noise", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed);
      const entries = days(180, () => 1 + Math.round(r() * 4));
      expect(run(entries), `seed ${seed}`).toEqual([]);
    }
  });

  it("holds every comparison to eight days a side", () => {
    // Twelve days, all with a strong weekend split: too few weekend days.
    const r = rng(16);
    const entries = days(
      12,
      (date) => (weekdayOfKey(date) >= 5 ? 4.6 : 1.4) + (r() - 0.5) * 0.4,
    );
    expect(run(entries).find((p) => p.kind === "weekend")).toBeUndefined();
  });

  it("compares days with a note against days without", () => {
    const r = rng(11);
    const entries = days(
      90,
      (_, i) => (i % 3 === 0 ? 2 : 4) + (r() - 0.5) * 0.4,
    );
    const noteDays = new Set(
      entries.filter((_, i) => i % 3 === 0).map((e) => e.date),
    );
    const notes = run(entries, noteDays).find((p) => p.kind === "notes");
    expect(notes).toMatchObject({ id: "notes", direction: "lower" });
  });

  it("compares days with several entries against single-entry days", () => {
    const r = rng(12);
    const base = days(
      90,
      (_, i) => (i % 2 === 0 ? 4.5 : 3) + (r() - 0.5) * 0.4,
    );
    const extra = base
      .filter((_, i) => i % 2 === 0)
      .map((e) => entry(e.date, e.score));
    const multi = run([...base, ...extra]).find(
      (p) => p.kind === "multiple_entries",
    );
    expect(multi).toMatchObject({ direction: "higher" });
  });

  it("reads a tag's association with the NEXT day", () => {
    const r = rng(13);
    const tag = {
      key: "alcohol",
      categoryKey: "health",
      labelKey: "mood.tag.alcohol",
      icon: null,
    };
    const tagged = new Set<number>();
    const entries = days(120, (_, i) => {
      // The day after a tagged day is low.
      return tagged.has(i - 1) ? 2 + r() * 0.4 : 4 + r() * 0.4;
    });
    entries.forEach((e, i) => {
      if (i % 4 === 0) {
        tagged.add(i);
        e.structuredTags = [tag];
      }
    });
    // Recompute the scores now that the tag days are known.
    for (let i = 0; i < entries.length; i += 1) {
      entries[i].score = tagged.has(i - 1) ? 2 + r() * 0.4 : 4 + r() * 0.4;
    }
    const delayed = run(entries).find((p) => p.kind === "delayed_tag");
    expect(delayed).toMatchObject({
      id: "delayed_tag:alcohol",
      direction: "lower",
      values: { tagKey: "alcohol" },
    });
  });

  it("reads the day after a below-median day", () => {
    const r = rng(14);
    const entries: MoodAggregateEntry[] = [];
    let prevLow = false;
    for (let i = 0; i < 150; i += 1) {
      const date = shiftDateKey(TODAY, -(149 - i));
      // Persistent mood: a low day is followed by another low-ish day.
      const low: boolean = r() < (prevLow ? 0.85 : 0.15);
      entries.push(entry(date, low ? 2 + r() * 0.5 : 4 + r() * 0.5));
      prevLow = low;
    }
    const previous = run(entries).find((p) => p.kind === "previous_day");
    expect(previous).toMatchObject({ id: "previous_day", direction: "lower" });
  });

  it("only counts days inside the window", () => {
    const r = rng(15);
    const entries = days(
      200,
      (date) => (weekdayOfKey(date) >= 5 ? 4.5 : 2.5) + (r() - 0.5) * 0.4,
    );
    const recent = computeMoodPatterns({
      entries,
      noteDays: new Set(),
      todayKey: TODAY,
      windowDays: 30,
    }).find((p) => p.kind === "weekend");
    expect(recent).toBeDefined();
    expect(recent!.sampleSize.subject).toBeGreaterThanOrEqual(8);
    expect(recent!.sampleSize.subject + recent!.sampleSize.comparison).toBe(30);
  });
});

describe("moodPatternsWire", () => {
  it("names a catalogue tag in the reader's language and a custom one verbatim, and drops q", () => {
    const wire = moodPatternsWire(
      [
        {
          id: "delayed_tag:alcohol",
          kind: "delayed_tag",
          strength: "moderate",
          direction: "lower",
          values: {
            subject: 2.1,
            comparison: 4,
            delta: -1.9,
            tagKey: "alcohol",
          },
          sampleSize: { subject: 20, comparison: 80 },
          tag: { labelKey: "mood.tag.alcohol", label: null },
          qValue: 0.01,
        },
        {
          id: "delayed_tag:custom:x",
          kind: "delayed_tag",
          strength: "weak",
          direction: "higher",
          values: { subject: 4, comparison: 3, delta: 1, tagKey: "custom:x" },
          sampleSize: { subject: 9, comparison: 50 },
          tag: { labelKey: "custom:x", label: "Choir" },
          qValue: 0.08,
        },
      ],
      (key) => `t:${key}`,
    );
    expect(wire[0].values.tagLabel).toBe("t:mood.tag.alcohol");
    expect(wire[1].values.tagLabel).toBe("Choir");
    expect(wire[0]).not.toHaveProperty("qValue");
    expect(wire[0]).not.toHaveProperty("tag");
    expect(moodPatternsWire(undefined, (k) => k)).toEqual([]);
  });
});

describe("pattern values stay on the mood scale (#176)", () => {
  it("averages the logged 1–5 scores and never rescales them", () => {
    // Weekdays around 2, weekend days around 4, on the 1–5 scale.
    const r = rng(11);
    const entries = days(120, (date) =>
      Math.min(
        5,
        Math.max(1, (weekdayOfKey(date) >= 5 ? 4 : 2) + (r() - 0.5) / 2),
      ),
    );
    const patterns = run(entries);
    const weekend = patterns.find((p) => p.kind === "weekend");
    expect(weekend).toBeDefined();
    expect(weekend!.values.subject).toBeCloseTo(4, 0);
    expect(weekend!.values.comparison).toBeCloseTo(2, 0);
    for (const p of patterns) {
      for (const v of [p.values.subject, p.values.comparison]) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(5);
      }
    }
    // The wire carries the same numbers.
    const wire = moodPatternsWire(patterns, (k) => k);
    expect(wire.find((p) => p.kind === "weekend")?.values).toMatchObject({
      subject: weekend!.values.subject,
      comparison: weekend!.values.comparison,
    });
  });
});
