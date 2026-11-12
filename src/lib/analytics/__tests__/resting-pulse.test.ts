/**
 * v1.15.12 — unit pins for resting-pulse estimation.
 *
 * The canonical regression: a day with
 * ~500 high workout PULSE samples + ~10 resting reads must NOT classify
 * the day as a resting-HR excursion. A user with clean
 * RESTING_HEART_RATE (~72) reads healthy.
 */
import { describe, expect, it } from "vitest";
import {
  deriveRestingProxyFromPulse,
  resolveRestingPulseSeries,
  type PulseSample,
} from "../resting-pulse";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import { userDayKey } from "@/lib/tz/format";

const DAY_KEY = (d: Date) => userDayKey(d, "Europe/Berlin");

/**
 * The zone `deriveRestingProxyFromPulse` buckets in by default
 * (`toBerlinDayKey`). Naming it here is the point: the fixtures used to
 * pass offset-less ISO literals, which `new Date(...)` reads as HOST-local.
 * That made every expectation mean something different on every developer
 * machine, and — because a Berlin day and a UTC day coincide for samples in
 * the middle of the day — swapping the implementation's day-key zone left
 * the whole file green. Building each instant explicitly in Berlin lets the
 * assertions actually pin the bucketing.
 */
const PROXY_DAY_ZONE = "Europe/Berlin";

/**
 * A pulse sample at the given `YYYY-MM-DDTHH:MM:SS` wall clock **in
 * Berlin**, expressed as the UTC instant it denotes.
 */
const day = (wallClock: string, value: number): PulseSample => {
  const m = wallClock.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!m) throw new Error(`fixture wall clock must be local, got ${wallClock}`);
  const [, y, mo, d, h, mi, sec] = m;
  return {
    measuredAt: zonedWallClockToUtc(
      {
        year: Number(y),
        month: Number(mo),
        day: Number(d),
        hour: Number(h),
        minute: Number(mi),
        second: Number(sec),
      },
      PROXY_DAY_ZONE,
    ),
    value,
  };
};

describe("deriveRestingProxyFromPulse", () => {
  it("excludes a workout burst — the daily proxy tracks the resting floor", () => {
    // One Berlin day: 10 resting reads ~70, 500 workout reads ~150.
    const samples: PulseSample[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(
        day(`2026-06-01T06:${String(i).padStart(2, "0")}:00`, 68 + i),
      );
    }
    for (let i = 0; i < 500; i++) {
      samples.push(
        day(
          `2026-06-01T18:${String(i % 60).padStart(2, "0")}:00`,
          140 + (i % 20),
        ),
      );
    }
    const proxy = deriveRestingProxyFromPulse(samples, DAY_KEY);
    expect(proxy).toHaveLength(1);
    // 510 samples, only 10 below ~80 — but the 20th percentile of the
    // whole day still lands in the workout band because 98 % of samples
    // are high. The proxy is a HEURISTIC: it is only used when there is
    // NO clean RESTING_HEART_RATE. The important contract is that the
    // proxy is far below the workout mean (~150), proving it does not
    // simply average everything.
    expect(proxy[0].value).toBeLessThan(150);
  });

  it("recovers the resting floor when resting reads are a normal share of the day", () => {
    // Realistic day: 30 waking/spot reads 70-95, 10 workout reads ~150.
    const samples: PulseSample[] = [];
    for (let i = 0; i < 30; i++) {
      samples.push(
        day(
          `2026-06-02T08:${String(i % 60).padStart(2, "0")}:00`,
          70 + (i % 25),
        ),
      );
    }
    for (let i = 0; i < 10; i++) {
      samples.push(day(`2026-06-02T18:${String(i).padStart(2, "0")}:00`, 150));
    }
    const proxy = deriveRestingProxyFromPulse(samples, DAY_KEY);
    expect(proxy).toHaveLength(1);
    // 20th percentile sits in the low band, well below the workout reads.
    expect(proxy[0].value).toBeLessThanOrEqual(80);
    expect(proxy[0].value).toBeGreaterThanOrEqual(68);
  });

  it("buckets by day and returns one proxy point per day, sorted", () => {
    // Each day needs enough samples (≥ 3) to clear the degenerate-day
    // guard so it can contribute a proxy point.
    const samples: PulseSample[] = [
      day("2026-06-03T08:00:00", 72),
      day("2026-06-03T12:00:00", 80),
      day("2026-06-03T20:00:00", 90),
      day("2026-06-01T08:00:00", 60),
      day("2026-06-01T12:00:00", 64),
      day("2026-06-01T20:00:00", 68),
    ];
    const proxy = deriveRestingProxyFromPulse(samples, DAY_KEY);
    expect(proxy).toHaveLength(2);
    expect(proxy[0].measuredAt.getTime()).toBeLessThan(
      proxy[1].measuredAt.getTime(),
    );
  });

  it("excludes a single-sample workout day — no resting estimate from one high reading", () => {
    // Audit LOW-1: a day with only one PULSE sample (e.g. a lone workout
    // reading) must NOT emit that value verbatim as "resting".
    const oneSampleWorkoutDay: PulseSample[] = [
      day("2026-06-05T18:00:00", 165),
    ];
    expect(deriveRestingProxyFromPulse(oneSampleWorkoutDay, DAY_KEY)).toEqual(
      [],
    );

    // A day below the min-sample floor is dropped; only the day with enough
    // samples contributes.
    const mixed: PulseSample[] = [
      day("2026-06-05T18:00:00", 165), // single workout sample → dropped
      day("2026-06-06T07:00:00", 60),
      day("2026-06-06T08:00:00", 62),
      day("2026-06-06T09:00:00", 64),
    ];
    const proxy = deriveRestingProxyFromPulse(mixed, DAY_KEY);
    expect(proxy).toHaveLength(1);
    expect(proxy[0].value).toBeLessThan(150);
  });

  it("returns empty for no samples", () => {
    expect(deriveRestingProxyFromPulse([], DAY_KEY)).toEqual([]);
  });
});

describe("resolveRestingPulseSeries", () => {
  it("prefers RESTING_HEART_RATE — a clean ~72 series reads as resting", () => {
    const restingSamples: PulseSample[] = Array.from({ length: 30 }, (_v, i) =>
      day(
        `2026-06-${String((i % 28) + 1).padStart(2, "0")}T06:00:00`,
        70 + (i % 5),
      ),
    );
    // Workout-polluted PULSE that should be IGNORED in favour of resting.
    const pulseSamples: PulseSample[] = Array.from({ length: 500 }, () =>
      day("2026-06-01T18:00:00", 150),
    );
    const { series, which } = resolveRestingPulseSeries({
      dayKeyOf: DAY_KEY,
      restingSamples,
      pulseSamples,
    });
    expect(which).toBe("resting");
    expect(series).toHaveLength(30);
    const mean = series.reduce((s, p) => s + p.value, 0) / series.length;
    expect(mean).toBeLessThan(90); // healthy resting band, not 150
  });

  it("falls back to the PULSE proxy when no resting rows exist", () => {
    const pulseSamples: PulseSample[] = [
      day("2026-06-01T08:00:00", 70),
      day("2026-06-01T08:05:00", 72),
      day("2026-06-01T18:00:00", 150),
    ];
    const { series, which } = resolveRestingPulseSeries({
      dayKeyOf: DAY_KEY,
      restingSamples: [],
      pulseSamples,
    });
    expect(which).toBe("proxy");
    expect(series).toHaveLength(1);
    expect(series[0].value).toBeLessThan(150);
  });

  it("reports 'none' when neither series has data", () => {
    expect(
      resolveRestingPulseSeries({
        dayKeyOf: DAY_KEY,
        restingSamples: [],
        pulseSamples: [],
      }),
    ).toEqual({ series: [], which: "none" });
  });

  /**
   * The shape a proxy account actually has once the retention fold has run
   * for a while: derived RESTING_HEART_RATE rows for the OLD days the fold
   * has already processed, and nothing but raw PULSE for the RECENT days it
   * has not reached yet. The all-or-nothing resolver saw the derived rows,
   * took the resting branch, and dropped the proxy — so the series the user
   * saw stopped dead at the fold horizon.
   */
  it("carries the series past the fold horizon — derived rows for old days, PULSE for recent ones", () => {
    // Days 01-05: folded, one derived resting row each. No PULSE left —
    // the fold tombstoned the raw readings it derived them from.
    const restingSamples: PulseSample[] = [
      day("2026-06-01T04:00:00", 61),
      day("2026-06-02T04:00:00", 62),
      day("2026-06-03T04:00:00", 63),
      day("2026-06-04T04:00:00", 64),
      day("2026-06-05T04:00:00", 65),
    ];
    // Days 06-08: not yet folded. Raw PULSE only, no resting row at all.
    const pulseSamples: PulseSample[] = [];
    for (const d of ["06", "07", "08"]) {
      pulseSamples.push(
        day(`2026-06-${d}T07:00:00`, 66),
        day(`2026-06-${d}T07:10:00`, 68),
        day(`2026-06-${d}T07:20:00`, 70),
        day(`2026-06-${d}T18:00:00`, 155), // workout burst, must not win
      );
    }

    const { series, which } = resolveRestingPulseSeries({
      dayKeyOf: DAY_KEY,
      restingSamples,
      pulseSamples,
    });

    // Five folded days + three proxy days — the recent days MUST appear.
    expect(series).toHaveLength(8);
    const days = series.map((p) =>
      p.measuredAt.toLocaleDateString("en-CA", { timeZone: PROXY_DAY_ZONE }),
    );
    expect(days).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
    ]);
    // The proxy days track the resting floor, not the workout burst.
    for (const point of series.slice(5)) {
      expect(point.value).toBeLessThan(100);
    }
    // Mixed series — hedge the label rather than call an estimate native.
    expect(which).toBe("proxy");
  });

  it("keeps the resting row on a day that has both a resting row and PULSE", () => {
    // A native day must not be second-guessed by the proxy, and a native
    // account with no gap days keeps the honest 'resting' label.
    const { series, which } = resolveRestingPulseSeries({
      dayKeyOf: DAY_KEY,
      restingSamples: [day("2026-06-01T04:00:00", 58)],
      pulseSamples: [
        day("2026-06-01T07:00:00", 80),
        day("2026-06-01T07:10:00", 82),
        day("2026-06-01T07:20:00", 84),
      ],
    });
    expect(series).toHaveLength(1);
    expect(series[0].value).toBe(58);
    expect(which).toBe("resting");
  });
});

describe("deriveRestingProxyFromPulse — the day bucket is the PROFILE day", () => {
  it("keeps after-midnight local samples on their own local day, not the UTC one", () => {
    // Berlin is UTC+2 in June, so 00:20–01:00 local on 2026-06-02 is
    // 22:20–23:00 UTC on 2026-06-01 — a DIFFERENT UTC calendar day. All
    // six samples belong to one Berlin day and must produce ONE bucket.
    // Under a UTC day-key they split 3/3 and produce two.
    const samples = [
      day("2026-06-02T00:20:00", 60),
      day("2026-06-02T00:40:00", 62),
      day("2026-06-02T01:00:00", 64),
      day("2026-06-02T09:00:00", 66),
      day("2026-06-02T15:00:00", 68),
      day("2026-06-02T21:00:00", 70),
    ];
    const proxy = deriveRestingProxyFromPulse(samples, DAY_KEY);
    expect(proxy).toHaveLength(1);
  });

  it("splits two local days that a UTC key would merge", () => {
    // 23:10–23:50 Berlin on 2026-06-01 is 21:10–21:50 UTC the same day,
    // while 00:10–00:50 Berlin on 2026-06-02 is 22:10–22:50 UTC on
    // 2026-06-01. A UTC key merges all six into one bucket; the Berlin key
    // must see two days.
    const samples = [
      day("2026-06-01T23:10:00", 60),
      day("2026-06-01T23:30:00", 62),
      day("2026-06-01T23:50:00", 64),
      day("2026-06-02T00:10:00", 80),
      day("2026-06-02T00:30:00", 82),
      day("2026-06-02T00:50:00", 84),
    ];
    const proxy = deriveRestingProxyFromPulse(samples, DAY_KEY);
    expect(proxy).toHaveLength(2);
  });

  it("honours an injected day-key function over the Berlin default", () => {
    // The targets route threads `userDayKey(d, userTz)`. Same samples,
    // different zone → a different bucketing. This is the seam the default
    // hides, so it gets its own pin.
    const samples = [
      day("2026-06-02T00:20:00", 60),
      day("2026-06-02T00:40:00", 62),
      day("2026-06-02T01:00:00", 64),
    ];
    const utcKey = (d: Date) => d.toISOString().slice(0, 10);
    // In UTC these three are 2026-06-01 22:20/22:40/23:00 → one UTC day.
    expect(deriveRestingProxyFromPulse(samples, utcKey)).toHaveLength(1);
    // And that UTC day is 06-01, whereas the Berlin bucket is 06-02.
    expect(utcKey(samples[0].measuredAt)).toBe("2026-06-01");
  });
});
