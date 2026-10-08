import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    strainTrimpCache: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

// v1.27.5 — the RECOVERY read attaches the readiness-blend components; the
// blend engine itself is covered by its own suite, so it is mocked here.
vi.mock("../readiness", () => ({
  computeReadiness: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { computeReadiness } from "../readiness";
import {
  computeWellnessScore,
  bandWellnessScore,
  type WellnessScoreValue,
} from "../wellness-scores";
import { SPARKLINE_MAX_POINTS } from "../types";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T08:00:00Z");
const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
const cacheFindUnique = prisma.strainTrimpCache.findUnique as ReturnType<
  typeof vi.fn
>;
const userFindUnique = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const readinessMock = vi.mocked(computeReadiness);

beforeEach(() => {
  findMany.mockReset();
  cacheFindUnique.mockReset();
  cacheFindUnique.mockResolvedValue(null);
  // The recovery resolver buckets by the user's local wake-day; the reader
  // loads the zone when none is passed. Default the cohort to Europe/Berlin.
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue({ timezone: "Europe/Berlin" });
  // Default: the blend gates (below the min-component floor) — the recovery
  // read must survive that and simply omit the breakdown.
  readinessMock.mockReset();
  readinessMock.mockResolvedValue({ status: "insufficient" } as never);
});

describe("bandWellnessScore", () => {
  it("higher is better for recovery", () => {
    expect(bandWellnessScore("RECOVERY_SCORE", 80)).toBe("green");
    expect(bandWellnessScore("RECOVERY_SCORE", 50)).toBe("yellow");
    expect(bandWellnessScore("RECOVERY_SCORE", 20)).toBe("red");
  });

  it("higher is worse for stress (band inverts)", () => {
    expect(bandWellnessScore("STRESS_SCORE", 80)).toBe("red");
    expect(bandWellnessScore("STRESS_SCORE", 50)).toBe("yellow");
    expect(bandWellnessScore("STRESS_SCORE", 20)).toBe("green");
  });
});

describe("computeWellnessScore", () => {
  it("returns insufficient with no_score_in_window when the job hasn't run", async () => {
    findMany.mockResolvedValue([]);
    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.reason).toBe("no_score_in_window");
    }
  });

  it("reads the latest persisted score and a trailing trend", async () => {
    findMany.mockResolvedValue([
      { value: 72, measuredAt: new Date("2026-06-02T06:00:00Z") },
      { value: 60, measuredAt: new Date("2026-06-01T06:00:00Z") },
      { value: 64, measuredAt: new Date("2026-05-31T06:00:00Z") },
    ]);
    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const v = r.value as WellnessScoreValue;
      expect(v.score).toBe(72);
      expect(v.band).toBe("green");
      // 72 - mean(60, 64) = 72 - 62 = 10
      expect(v.trendDelta).toBe(10);
      expect(v.daysInWindow).toBe(3);
      // Sparkline series: window rows oldest → newest (rows are read desc).
      expect(v.series).toEqual([64, 60, 72]);
    }
  });

  it("null trend when only one score exists", async () => {
    findMany.mockResolvedValue([
      { value: 40, measuredAt: new Date("2026-06-02T06:00:00Z") },
    ]);
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).trendDelta).toBeNull();
    }
  });

  it("STRAIN carries the active anchor from the day's cache row", async () => {
    findMany.mockResolvedValue([
      { value: 55, measuredAt: new Date("2026-06-01T12:00:00Z") },
    ]);
    cacheFindUnique.mockResolvedValue({ anchor: "personal" });
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    // The cache is keyed by the scored day (the latest score's day key).
    expect(cacheFindUnique).toHaveBeenCalledWith({
      where: { userId_day: { userId: "u1", day: "2026-06-01" } },
      select: { anchor: true },
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).anchor).toBe("personal");
    }
  });

  it("STRAIN anchor is null when no cache row exists", async () => {
    findMany.mockResolvedValue([
      { value: 55, measuredAt: new Date("2026-06-01T12:00:00Z") },
    ]);
    cacheFindUnique.mockResolvedValue(null);
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).anchor).toBeNull();
    }
  });

  it("RECOVERY does not read the strain cache and carries a null anchor", async () => {
    findMany.mockResolvedValue([
      {
        value: 72,
        measuredAt: new Date("2026-06-01T12:00:00Z"),
        source: "COMPUTED",
      },
    ]);
    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(cacheFindUnique).not.toHaveBeenCalled();
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).anchor).toBeNull();
      // Gated blend (default mock) → no breakdown, read still ok.
      expect((r.value as WellnessScoreValue).components).toBeNull();
    }
  });

  it("RECOVERY attaches the readiness-blend components for a COMPUTED row", async () => {
    findMany.mockResolvedValue([
      {
        value: 72,
        measuredAt: new Date("2026-06-01T12:00:00Z"),
        source: "COMPUTED",
      },
    ]);
    const components = [
      { key: "rhr", value: 90, weight: 0.25 },
      { key: "hrv", value: 60, weight: 0.25 },
      { key: "sleep", value: 70, weight: 0.25 },
      { key: "respiratory", value: null, weight: 0 },
      { key: "mood", value: 80, weight: 0.25 },
    ];
    readinessMock.mockResolvedValue({
      status: "ok",
      value: { score: 74, band: "green", components },
    } as never);
    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    // Same engine, same user, the resolved profile timezone threaded through.
    expect(readinessMock).toHaveBeenCalledWith("u1", PROFILE, {
      now: NOW,
      tz: "Europe/Berlin",
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).components).toEqual(components);
    }
  });

  it("RECOVERY reads BOTH sources and resolves the WHOOP-native row when present", async () => {
    // ONE night written by both engines on their realistic clocks: the WHOOP
    // wake-morning stamp (Jun 02) and the COMPUTED proxy filed under the
    // day-that-ended (Jun 01). The native row is canonical → the tile shows 80,
    // not the proxy's 50, and the off-by-one does NOT spawn two recovery days.
    findMany.mockResolvedValue([
      {
        value: 80,
        measuredAt: new Date("2026-06-02T06:00:00Z"),
        source: "WHOOP",
      },
      {
        value: 50,
        measuredAt: new Date("2026-06-01T12:00:00Z"),
        source: "COMPUTED",
      },
    ]);
    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    // The read must NOT hard-filter to COMPUTED — both sources reach the resolver.
    const where = findMany.mock.calls[0][0].where as { source?: unknown };
    expect(where.source).toBeUndefined();
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).score).toBe(80);
      expect((r.value as WellnessScoreValue).band).toBe("green");
      // One night, one canonical row — the off-by-one collapsed.
      expect((r.value as WellnessScoreValue).daysInWindow).toBe(1);
      // A WHOOP-native percentage is not our blend — no decomposition, and
      // the blend engine is never invoked for it.
      expect((r.value as WellnessScoreValue).components).toBeNull();
    }
    expect(readinessMock).not.toHaveBeenCalled();
  });

  it("a widened window still collapses every night through the canonical resolver", async () => {
    // The wake-day trap: a worn band stamps the wake morning, the COMPUTED
    // proxy stamps the night that ended, so ONE night arrives as two rows a
    // calendar day apart. Only `resolveCanonicalRecovery` pairs them. With the
    // window fixed at 14 days a bypass would be invisible in most fixtures, so
    // this seeds FORTY such nights and asks for sixty days.
    const NIGHTS = 40;
    const rows: Array<{ value: number; measuredAt: Date; source: string }> = [];
    for (let back = 0; back < NIGHTS; back += 1) {
      const wake = new Date("2026-06-02T06:00:00Z");
      wake.setUTCDate(wake.getUTCDate() - back);
      const priorNoon = new Date("2026-06-01T12:00:00Z");
      priorNoon.setUTCDate(priorNoon.getUTCDate() - back);
      rows.push({ value: 80, measuredAt: wake, source: "WHOOP" });
      rows.push({ value: 50, measuredAt: priorNoon, source: "COMPUTED" });
    }
    // The reader orders newest-first; mirror that.
    rows.sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
    findMany.mockResolvedValue(rows);

    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
      windowDays: 60,
    });

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const v = r.value as WellnessScoreValue;
    // Forty nights, not eighty rows — the resolver ran over the whole window,
    // not just its head.
    expect(v.daysInWindow).toBe(NIGHTS);
    expect(r.coverage.historyDays).toBe(NIGHTS);
    // Every canonical row is the WHOOP 80, so the trend against the prior
    // nights is flat. A bypass would leave the COMPUTED 50s in the mean and
    // push this to roughly +15.
    expect(v.score).toBe(80);
    expect(v.trendDelta).toBe(0);
    expect(v.series.every((point) => point === 80)).toBe(true);
    // The sparkline stays capped however wide the window gets.
    expect(v.series.length).toBe(SPARKLINE_MAX_POINTS);
    // The read itself honoured the sixty days.
    const where = findMany.mock.calls[0][0].where as {
      measuredAt: { gte: Date };
    };
    const spanDays = Math.round(
      (NOW.getTime() - where.measuredAt.gte.getTime()) / (24 * 60 * 60 * 1000),
    );
    expect(spanDays).toBe(60);
  });

  it("reports the requested window and the days actually covered as two different numbers", async () => {
    // Three weeks of record, thirty days asked for. The window is a request,
    // not a promise: provenance carries what was asked, coverage carries what
    // backed the answer.
    const rows = Array.from({ length: 21 }, (_, back) => {
      const at = new Date("2026-06-01T12:00:00Z");
      at.setUTCDate(at.getUTCDate() - back);
      return { value: 60, measuredAt: at, source: "COMPUTED" };
    });
    findMany.mockResolvedValue(rows);
    const r = await computeWellnessScore("STRESS_SCORE", "u1", PROFILE, {
      now: NOW,
      windowDays: 30,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.provenance.windowDays).toBe(30);
    expect(r.coverage.historyDays).toBe(21);
    expect((r.value as WellnessScoreValue).daysInWindow).toBe(21);
  });

  it("STRESS still hard-filters to the COMPUTED source", async () => {
    findMany.mockResolvedValue([
      {
        value: 30,
        measuredAt: new Date("2026-06-02T12:00:00Z"),
        source: "COMPUTED",
      },
    ]);
    await computeWellnessScore("STRESS_SCORE", "u1", PROFILE, { now: NOW });
    const where = findMany.mock.calls[0][0].where as { source?: unknown };
    expect(where.source).toBe("COMPUTED");
  });
});

describe("computeWellnessScore — strain reads the device's day strain", () => {
  // `/insights/recovery` charts the band's own DAY_STRAIN. The strain page
  // must not call the same account "not enough data": with no computed proxy
  // in the window it serves the device's day strain, on the device's scale.
  function byType(rows: Record<string, unknown[]>) {
    findMany.mockImplementation(
      async (args: { where: { type: string } }) => rows[args.where.type] ?? [],
    );
  }

  it("falls back to DAY_STRAIN when no computed strain score exists", async () => {
    byType({
      STRAIN_SCORE: [],
      DAY_STRAIN: [
        {
          value: 10.5,
          measuredAt: new Date("2026-06-02T04:00:00Z"),
          source: "WHOOP",
        },
        {
          value: 14.7,
          measuredAt: new Date("2026-06-01T04:00:00Z"),
          source: "WHOOP",
        },
      ],
    });
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const v = r.value as WellnessScoreValue;
    expect(v.device).toEqual({ value: 10.5, scaleMax: 21 });
    expect(v.score).toBe(50);
    expect(v.daysInWindow).toBe(2);
    expect(r.provenance.inputs).toEqual(["DAY_STRAIN"]);
  });

  it("keeps the computed proxy when one exists", async () => {
    byType({
      STRAIN_SCORE: [
        {
          value: 64,
          measuredAt: new Date("2026-06-01T12:00:00Z"),
          source: "COMPUTED",
        },
      ],
      DAY_STRAIN: [
        {
          value: 10.5,
          measuredAt: new Date("2026-06-02T04:00:00Z"),
          source: "WHOOP",
        },
      ],
    });
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.score).toBe(64);
    expect(r.value.device ?? null).toBeNull();
  });

  it("stays insufficient with neither", async () => {
    byType({});
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("insufficient");
  });
});
