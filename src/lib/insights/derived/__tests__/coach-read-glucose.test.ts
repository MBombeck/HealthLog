/**
 * The "Usual range" strip on the glucose page holds today against the band of
 * whole days only when today is a whole day.
 *
 * The band is built from day means, and a glucose day mean climbs with every
 * meal. At nine in the morning the day holds its fasting reading and nothing
 * after, so the strip placed that reading against whole days (fasting plus
 * lunch plus dinner) and said "below your range" on an ordinary morning. A
 * glucose day still in progress is now held against the earlier days cut at
 * the local time of today's latest reading, the same comparison the health
 * status already makes.
 *
 * Drives the real builder over the real band engine; only the database reads
 * are faked, through the same day-aggregate fold the SQL reader uses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

const findMany = vi.fn();
const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: (a: unknown) => findMany(a),
      findFirst: (a: unknown) => findFirst(a),
    },
  },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/insights/derived/baseline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/insights/derived/baseline")>()),
  loadBaselineProfile: async () => ({ ageYears: 40, sex: "MALE" }),
}));
vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: async () => ({ present: false }),
}));

import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";

const TZ = "Europe/Berlin";
// 09:00 in Berlin (CEST, UTC+2).
const NOW = new Date("2026-06-02T07:00:00Z");

interface Row {
  value: number;
  measuredAt: Date;
}

/**
 * Fourteen whole days, each with a fasting reading at 07:00 local and two
 * after meals at 13:00 and 19:00 local: day means near 132.
 */
function wholeDays(): Row[] {
  return Array.from({ length: 14 }, (_, i) => {
    const date = `2026-05-${String(18 + i).padStart(2, "0")}`;
    return [
      { value: 85, measuredAt: new Date(`${date}T05:00:00Z`) },
      { value: 160, measuredAt: new Date(`${date}T11:00:00Z`) },
      { value: 150, measuredAt: new Date(`${date}T17:00:00Z`) },
    ];
  }).flat();
}

function serve(rows: Row[]) {
  const sorted = [...rows].sort(
    (a, b) => b.measuredAt.getTime() - a.measuredAt.getTime(),
  );
  findMany.mockImplementation(
    async (args: { where: { measuredAt?: { gte?: Date } } }) => {
      const gte = args.where.measuredAt?.gte;
      return sorted.filter((r) => !gte || r.measuredAt >= gte);
    },
  );
  findFirst.mockImplementation(async () => sorted[0] ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("coach read — glucose on a day still in progress", () => {
  it("does not call a fasting morning below the usual range", async () => {
    serve([
      ...wholeDays(),
      // 07:10 local today: the fasting reading, nothing after it yet.
      { value: 86, measuredAt: new Date("2026-06-02T05:10:00Z") },
    ]);
    const strip = await buildCoachReadStrip("u1", "BLOOD_GLUCOSE", "en", {
      tz: TZ,
      now: NOW,
    });
    expect(strip.learning).toBe(false);
    expect(strip.baseline).not.toBeNull();
    expect(strip.baseline!.placement).toBe("within");
    expect(strip.baseline!.basis).toBe("sameHours");
    expect(strip.baseline!.latest).toBe(86);
    // The range is the usual one for the morning, not for whole days.
    expect(strip.baseline!.high).toBeLessThan(100);
    expect(strip.baseline!.sampleDays).toBe(14);
  });

  it("still says below when the morning is low against earlier mornings", async () => {
    serve([
      ...wholeDays(),
      { value: 62, measuredAt: new Date("2026-06-02T05:10:00Z") },
    ]);
    const strip = await buildCoachReadStrip("u1", "BLOOD_GLUCOSE", "en", {
      tz: TZ,
      now: NOW,
    });
    expect(strip.baseline!.placement).toBe("below");
    expect(strip.baseline!.basis).toBe("sameHours");
  });

  it("gives no verdict when earlier days have nothing at this hour", async () => {
    // Earlier days only ever carry an evening reading, so there is no morning
    // to compare this one with.
    serve([
      ...wholeDays().filter((r) => r.value === 150),
      { value: 86, measuredAt: new Date("2026-06-02T05:10:00Z") },
    ]);
    const strip = await buildCoachReadStrip("u1", "BLOOD_GLUCOSE", "en", {
      tz: TZ,
      now: NOW,
    });
    expect(strip.baseline).toBeNull();
    expect(strip.learning).toBe(true);
  });

  it("holds a finished day against whole days by its day mean", async () => {
    // Nothing today; the latest day is yesterday, whole. Its mean is set
    // against the whole-day band, not its last (evening) reading alone.
    serve(wholeDays());
    const strip = await buildCoachReadStrip("u1", "BLOOD_GLUCOSE", "en", {
      tz: TZ,
      now: NOW,
    });
    expect(strip.baseline!.basis).toBeUndefined();
    expect(strip.baseline!.latest).toBeCloseTo((85 + 160 + 150) / 3, 5);
    expect(strip.baseline!.placement).toBe("within");
  });

  it("keeps the single latest reading for a type whose day mean does not move with the hour", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      value: 58,
      measuredAt: new Date(
        `2026-05-${String(20 + i).padStart(2, "0")}T05:00:00Z`,
      ),
    }));
    serve([
      ...rows,
      { value: 59, measuredAt: new Date("2026-06-02T05:00:00Z") },
    ]);
    const strip = await buildCoachReadStrip("u1", "RESTING_HEART_RATE", "en", {
      tz: TZ,
      now: NOW,
    });
    expect(strip.baseline!.latest).toBe(59);
    expect(strip.baseline!.basis).toBeUndefined();
  });
});

describe("coach read — the latest reading's day", () => {
  function restingUpTo(newest: Date): Row[] {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      value: 58,
      measuredAt: new Date(
        `2026-05-${String(18 + i).padStart(2, "0")}T05:00:00Z`,
      ),
    }));
    return [...rows, { value: 59, measuredAt: newest }];
  }

  async function restingStrip(newest: Date) {
    serve(restingUpTo(newest));
    return buildCoachReadStrip("u1", "RESTING_HEART_RATE", "en", {
      tz: TZ,
      now: NOW,
    });
  }

  it("says an older reading is not today's and dates it", async () => {
    const strip = await restingStrip(new Date("2026-05-29T05:00:00Z"));
    expect(strip.baseline!.latest).toBe(59);
    expect(strip.baseline!.latestDate).toBe("2026-05-29");
    expect(strip.baseline!.latestIsToday).toBe(false);
  });

  it("marks a reading from this morning as today's", async () => {
    const strip = await restingStrip(new Date("2026-06-02T05:00:00Z"));
    expect(strip.baseline!.latestDate).toBe("2026-06-02");
    expect(strip.baseline!.latestIsToday).toBe(true);
  });

  it("reads the day in the reader's zone, not in UTC", async () => {
    // 22:30 UTC on the 1st is 00:30 on the 2nd in Berlin: today.
    const after = await restingStrip(new Date("2026-06-01T22:30:00Z"));
    expect(after.baseline!.latestDate).toBe("2026-06-02");
    expect(after.baseline!.latestIsToday).toBe(true);
    // 21:50 UTC is 23:50 on the 1st in Berlin: yesterday.
    const before = await restingStrip(new Date("2026-06-01T21:50:00Z"));
    expect(before.baseline!.latestDate).toBe("2026-06-01");
    expect(before.baseline!.latestIsToday).toBe(false);
  });

  it("dates a finished glucose day, and marks a day in progress as today", async () => {
    serve(wholeDays());
    const finished = await buildCoachReadStrip("u1", "BLOOD_GLUCOSE", "en", {
      tz: TZ,
      now: NOW,
    });
    expect(finished.baseline!.latestDate).toBe("2026-05-31");
    expect(finished.baseline!.latestIsToday).toBe(false);

    serve([
      ...wholeDays(),
      { value: 86, measuredAt: new Date("2026-06-02T05:10:00Z") },
    ]);
    const today = await buildCoachReadStrip("u1", "BLOOD_GLUCOSE", "en", {
      tz: TZ,
      now: NOW,
    });
    expect(today.baseline!.basis).toBe("sameHours");
    expect(today.baseline!.latestDate).toBe("2026-06-02");
    expect(today.baseline!.latestIsToday).toBe(true);
  });
});
