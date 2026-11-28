/**
 * v1.18.1 — illness correlation READ layer + rollup-vs-live parity.
 *
 * The reliability anchor: the same per-day series fed to the engine must
 * produce IDENTICAL findings whether it was resolved from the rollup DAY tier
 * or the live-SQL fallback. We drive `computeEpisodeCorrelation` twice over the
 * SAME underlying daily data — once with full rollup coverage (the DAY path),
 * once with a coverage miss (the live raw-read path) — and assert the engine
 * output is byte-identical (modulo the provenance `source` tag).
 *
 * Also pins the contamination-guard READ window: the baseline read window must
 * end strictly before the pre-onset lookback (no episode-span day reaches the
 * baseline query).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The DAY-native daily means the test universe holds for RESTING_HEART_RATE.
 * Baseline window sits at ~55; the episode-span (from 01-03 onward) spikes.
 * Onset 2026-01-10, lookback 7 → pre-onset starts 2026-01-03; baseline window
 * is the 30 days ending 2026-01-03. */
const DAILY: Array<{ day: string; mean: number }> = [];
{
  // 30 clean baseline days ending the day before 2026-01-03.
  let cursor = Date.parse("2026-01-02T00:00:00Z");
  // Even spread around 55 so the MAD (and band) is non-zero and stable.
  const offsets = [-2, -1, 0, 1, 2];
  for (let i = 0; i < 30; i++) {
    DAILY.unshift({
      day: new Date(cursor).toISOString().slice(0, 10),
      mean: 55 + offsets[i % offsets.length],
    });
    cursor -= 24 * 60 * 60 * 1000;
  }
  // Episode span.
  for (const [day, mean] of [
    ["2026-01-03", 56],
    ["2026-01-08", 70], // pre-onset notable
    ["2026-01-10", 74],
    ["2026-01-12", 76], // nadir
    ["2026-01-15", 64],
    ["2026-01-17", 58],
    ["2026-01-18", 55],
    ["2026-01-19", 55],
    ["2026-01-20", 55],
  ] as const) {
    DAILY.push({ day, mean });
  }
}

const NOW = new Date("2026-01-21T12:00:00Z");

const db = vi.hoisted(() => ({
  measurement: { findMany: vi.fn() },
  illnessDayLog: { findMany: vi.fn() },
}));
const rollup = vi.hoisted(() => ({
  probeRollupCoverage: vi.fn(),
  readBestGranularityRollups: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: rollup.probeRollupCoverage,
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: rollup.readBestGranularityRollups,
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));

import { computeEpisodeCorrelation } from "../correlation-read";
import { ILLNESS_SCAN_TYPES } from "../correlation";

/**
 * An ACTIVE episode (no resolvedAt) so the episode-window read's `to` is
 * effectively `now` — this exercises the trailing rollup DAY path in the
 * covered case and the trailing live path in the miss case, the exact seam
 * the parity test must pin. The baseline window stays bounded (raw both ways).
 */
const EPISODE = {
  id: "ep-parity",
  onsetAt: new Date("2026-01-10T08:00:00Z"),
  resolvedAt: null as Date | null,
  lifecycle: "ACUTE",
};

/** Daily rows within [from, to) as a raw-measurement findMany result. */
function rawRowsWithin(from: Date, to: Date) {
  const fromKey = from.toISOString().slice(0, 10);
  const toKey = to.toISOString().slice(0, 10);
  return DAILY.filter((d) => d.day >= fromKey && d.day < toKey).map((d) => ({
    value: d.mean,
    measuredAt: new Date(`${d.day}T12:00:00Z`),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // No day-log fever rows in the parity/contamination fixtures.
  db.illnessDayLog.findMany.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeEpisodeCorrelation — rollup-vs-live parity", () => {
  function onlyRhr<T>(map: Map<string, T>): Map<string, T> {
    return map;
  }

  it("produces identical findings on the DAY path and the live path", async () => {
    // ── DAY path: full coverage for RESTING_HEART_RATE, rollup serves the
    //    trailing (to == now) episode-window read; the bounded baseline read
    //    goes through measurement.findMany (to != now). ──
    const dayCoverage = onlyRhr(
      new Map<string, boolean>(
        ILLNESS_SCAN_TYPES.map((t) => [String(t), t === "RESTING_HEART_RATE"]),
      ),
    );
    rollup.probeRollupCoverage.mockResolvedValue(dayCoverage);
    rollup.readBestGranularityRollups.mockImplementation(
      async (_u: string, type: string, windowDays: number) => {
        if (type !== "RESTING_HEART_RATE") return null;
        const since = new Date(
          NOW.getTime() - windowDays * 24 * 60 * 60 * 1000,
        );
        const sinceKey = since.toISOString().slice(0, 10);
        const rows = DAILY.filter((d) => d.day >= sinceKey).map((d) => ({
          bucketStart: new Date(`${d.day}T00:00:00Z`),
          count: 1,
          mean: d.mean,
          sd: null,
          slope: null,
          r2: null,
          sumValue: null,
          minValue: d.mean,
          maxValue: d.mean,
        }));
        return rows.length > 0 ? { granularity: "DAY" as const, rows } : null;
      },
    );
    db.measurement.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { type: string; measuredAt: { gte: Date; lt: Date } };
      }) => {
        if (where.type !== "RESTING_HEART_RATE") return [];
        return rawRowsWithin(where.measuredAt.gte, where.measuredAt.lt);
      },
    );

    const dayOut = await computeEpisodeCorrelation("u1", EPISODE, "UTC", NOW);

    // ── Live path: zero rollup coverage, every read falls to findMany. The
    //    baseline engine's live fallback groups raw rows itself for the
    //    trailing read; we serve the same DAILY universe for any window. ──
    vi.clearAllMocks();
    db.illnessDayLog.findMany.mockResolvedValue([]);
    const noCoverage = new Map<string, boolean>(
      ILLNESS_SCAN_TYPES.map((t) => [String(t), false]),
    );
    rollup.probeRollupCoverage.mockResolvedValue(noCoverage);
    rollup.readBestGranularityRollups.mockResolvedValue(null);
    db.measurement.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { type: string; measuredAt: { gte: Date; lt?: Date } };
      }) => {
        if (where.type !== "RESTING_HEART_RATE") return [];
        const from = where.measuredAt.gte;
        const to = where.measuredAt.lt ?? NOW;
        return rawRowsWithin(from, to);
      },
    );

    const liveOut = await computeEpisodeCorrelation("u1", EPISODE, "UTC", NOW);

    expect(dayOut.status).toBe("ok");
    expect(liveOut.status).toBe("ok");
    if (dayOut.status !== "ok" || liveOut.status !== "ok") return;

    // Same numbers regardless of read path (the parity guarantee): the
    // DAY-rollup-fed series and the live-SQL series produce byte-identical
    // findings.
    expect(liveOut.value.recoveryGapDays).toBe(dayOut.value.recoveryGapDays);
    expect(liveOut.value.nadir).toEqual(dayOut.value.nadir);
    expect(liveOut.value.preOnset).toEqual(dayOut.value.preOnset);
    expect(liveOut.value.returns).toEqual(dayOut.value.returns);

    // And the findings are the expected golden values.
    expect(dayOut.value.nadir[0]?.day).toBe("2026-01-12");
    expect(dayOut.value.nadir[0]?.value).toBe(76);
    expect(dayOut.value.preOnset[0]?.day).toBe("2026-01-08");
    // Active episode → no felt-better marker → the gap is null but the
    // physiological return is still detected. 01-17 (58 bpm) is still 2σ
    // above a 55 ± 1.5 baseline; 01-18 is the first in-band day that then
    // holds for ≥3 observed days.
    expect(dayOut.value.recoveryGapDays).toBeNull();
    expect(dayOut.value.returns[0]?.returnedDay).toBe("2026-01-18");
  });
});

describe("computeEpisodeCorrelation — user-tz day keying", () => {
  it("keys a 03:00Z reading to the user's LOCAL day (negative-offset tz)", async () => {
    // America/Los_Angeles is UTC−8 (−7 DST). A 2026-01-12T03:00Z reading is
    // 2026-01-11 19:00 local → local day 2026-01-11, NOT the UTC 2026-01-12.
    // The vital series must key by the user's day so it lines up with the
    // tz-keyed onset/feltBetter markers (the off-by-one this fix closes).
    rollup.probeRollupCoverage.mockResolvedValue(
      new Map<string, boolean>(
        ILLNESS_SCAN_TYPES.map((t) => [String(t), false]),
      ),
    );
    rollup.readBestGranularityRollups.mockResolvedValue(null);

    // A simple RHR universe with a notable spike whose UTC timestamp crosses
    // the local midnight. Baseline window is flat-ish at 55.
    const rows: Array<{ value: number; measuredAt: Date }> = [];
    // 20 baseline days at 55 ± small jitter, ending well before the episode.
    let cursor = Date.parse("2025-12-20T20:00:00Z");
    const jit = [-2, -1, 0, 1, 2];
    for (let i = 0; i < 20; i++) {
      rows.push({
        value: 55 + jit[i % jit.length],
        measuredAt: new Date(cursor),
      });
      cursor += 24 * 60 * 60 * 1000;
    }
    // Episode-span readings, including the boundary-crossing 03:00Z spike.
    rows.push({ value: 56, measuredAt: new Date("2026-01-10T20:00:00Z") });
    rows.push({ value: 76, measuredAt: new Date("2026-01-12T03:00:00Z") }); // local 01-11
    rows.push({ value: 74, measuredAt: new Date("2026-01-13T20:00:00Z") });
    rows.push({ value: 70, measuredAt: new Date("2026-01-15T20:00:00Z") });
    rows.push({ value: 60, measuredAt: new Date("2026-01-16T20:00:00Z") });
    rows.push({ value: 58, measuredAt: new Date("2026-01-17T20:00:00Z") });

    db.measurement.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { type: string; measuredAt: { gte: Date; lt?: Date } };
      }) => {
        if (where.type !== "RESTING_HEART_RATE") return [];
        const from = where.measuredAt.gte.getTime();
        const to = where.measuredAt.lt?.getTime() ?? NOW.getTime();
        return rows.filter(
          (r) => r.measuredAt.getTime() >= from && r.measuredAt.getTime() < to,
        );
      },
    );

    const episode = {
      id: "ep-tz",
      onsetAt: new Date("2026-01-11T08:00:00Z"), // local 01-11 00:00 LA
      resolvedAt: null as Date | null,
      lifecycle: "ACUTE",
    };

    const out = await computeEpisodeCorrelation(
      "u1",
      episode,
      "America/Los_Angeles",
      NOW,
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    // The 76 spike lands on the user-local day 2026-01-11, not the UTC 01-12.
    expect(out.value.nadir[0]?.value).toBe(76);
    expect(out.value.nadir[0]?.day).toBe("2026-01-11");
  });
});

describe("computeEpisodeCorrelation — contamination-guard read window", () => {
  it("never queries baseline rows on or after the pre-onset lookback start", async () => {
    rollup.probeRollupCoverage.mockResolvedValue(
      new Map<string, boolean>(
        ILLNESS_SCAN_TYPES.map((t) => [String(t), false]),
      ),
    );
    rollup.readBestGranularityRollups.mockResolvedValue(null);
    const seen: Array<{ gte: Date; lt?: Date }> = [];
    db.measurement.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { type: string; measuredAt: { gte: Date; lt?: Date } };
      }) => {
        if (where.type === "RESTING_HEART_RATE") seen.push(where.measuredAt);
        return [];
      },
    );

    await computeEpisodeCorrelation("u1", EPISODE, "UTC", NOW);

    // The pre-onset lookback starts at onset − 7 days = 2026-01-03.
    const lookbackStart = Date.parse("2026-01-03T08:00:00Z");
    // The bounded baseline read (the one with a `lt`) must END at/ before
    // the lookback start — no baseline query may reach into the episode span.
    const boundedBaseline = seen.filter((w) => w.lt !== undefined);
    expect(boundedBaseline.length).toBeGreaterThan(0);
    for (const w of boundedBaseline) {
      expect(w.lt!.getTime()).toBeLessThanOrEqual(lookbackStart);
    }
  });
});

describe("computeEpisodeCorrelation — sleep-as-context read", () => {
  it("reconstructs baseline + episode nights and surfaces the observation, deduping multi-source nights", async () => {
    rollup.probeRollupCoverage.mockResolvedValue(
      new Map<string, boolean>(
        ILLNESS_SCAN_TYPES.map((t) => [String(t), false]),
      ),
    );
    rollup.readBestGranularityRollups.mockResolvedValue(null);

    // A banded RHR vital (flat-ish at 55) clears the engine coverage floor.
    const rhrRows: Array<{ value: number; measuredAt: Date }> = [];
    {
      let cursor = Date.parse("2025-12-05T12:00:00Z");
      const jit = [-2, -1, 0, 1, 2];
      for (let i = 0; i < 40; i++) {
        rhrRows.push({
          value: 55 + jit[i % jit.length],
          measuredAt: new Date(cursor),
        });
        cursor += 24 * 60 * 60 * 1000;
      }
    }

    // Sleep rows. Baseline nights ~420 min (7h); episode nights ~510 min
    // (8.5h) → +90 min. The episode 2026-01-11 night is DOUBLE-WRITTEN by two
    // sources (WHOOP + Apple Health); the canonical reconstruction must count
    // it ONCE, not sum it to ~1020 min and inflate the delta.
    // A "night" is one asleep block whose wake-day is the local calendar day.
    type SleepRow = {
      value: number;
      measuredAt: Date;
      sleepStage: null;
      source: string;
      deviceType: string | null;
    };
    const sleepRows: SleepRow[] = [];
    const asleepNight = (
      wakeDay: string,
      minutes: number,
      source: string,
    ): SleepRow => ({
      // The block ENDS at 07:00Z on the wake-day; one ASLEEP sample of `minutes`.
      value: minutes,
      measuredAt: new Date(`${wakeDay}T07:00:00Z`),
      sleepStage: null,
      source,
      deviceType: source,
    });
    // Baseline nights (well before the pre-onset lookback start 2026-01-03).
    for (const day of [
      "2025-12-20",
      "2025-12-21",
      "2025-12-22",
      "2025-12-23",
      "2025-12-24",
      "2025-12-25",
    ]) {
      sleepRows.push(asleepNight(day, 420, "WHOOP"));
    }
    // Episode nights (active span ≥ onset 2026-01-10).
    sleepRows.push(asleepNight("2026-01-10", 510, "WHOOP"));
    // Double-written night — same wake-day, two writers.
    sleepRows.push(asleepNight("2026-01-11", 510, "WHOOP"));
    sleepRows.push(asleepNight("2026-01-11", 510, "APPLE_HEALTH"));
    sleepRows.push(asleepNight("2026-01-12", 510, "WHOOP"));

    db.measurement.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: {
          type: string;
          measuredAt: { gte: Date; lt?: Date; lte?: Date };
        };
      }) => {
        const from = where.measuredAt.gte.getTime();
        const to =
          where.measuredAt.lt?.getTime() ??
          where.measuredAt.lte?.getTime() ??
          NOW.getTime();
        if (where.type === "RESTING_HEART_RATE") {
          return rhrRows.filter(
            (r) =>
              r.measuredAt.getTime() >= from && r.measuredAt.getTime() <= to,
          );
        }
        if (where.type === "SLEEP_DURATION") {
          return sleepRows.filter(
            (r) =>
              r.measuredAt.getTime() >= from && r.measuredAt.getTime() <= to,
          );
        }
        return [];
      },
    );

    const episode = {
      id: "ep-sleep",
      onsetAt: new Date("2026-01-10T08:00:00Z"),
      resolvedAt: null as Date | null,
      lifecycle: "ACUTE",
    };

    const out = await computeEpisodeCorrelation("u1", episode, "UTC", NOW);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const sleep = out.value.sleepContext;
    expect(sleep).not.toBeNull();
    expect(sleep?.baselineMeanMinutes).toBe(420);
    // The double-written 01-11 night is counted ONCE → episode mean ≈ 510, not
    // a doubled ~680 that summing two writers would produce.
    expect(sleep?.episodeMeanMinutes).toBe(510);
    expect(sleep?.deltaMinutes).toBe(90);
    expect(sleep?.nightsCounted).toBe(3);
  });
});
