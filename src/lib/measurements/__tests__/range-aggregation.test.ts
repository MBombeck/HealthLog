import { describe, it, expect } from "vitest";
import {
  aggregateRows,
  pickAggregateGrain,
  rangeLengthDays,
  DAILY_AGGREGATE_THRESHOLD_DAYS,
  WEEKLY_AGGREGATE_THRESHOLD_DAYS,
  MONTHLY_AGGREGATE_THRESHOLD_DAYS,
  BUCKET_CAP,
} from "../range-aggregation";

describe("range-aggregation", () => {
  describe("pickAggregateGrain", () => {
    it("returns raw for ranges at or under the daily threshold", () => {
      expect(pickAggregateGrain(7)).toBe("raw");
      expect(pickAggregateGrain(30)).toBe("raw");
      expect(pickAggregateGrain(DAILY_AGGREGATE_THRESHOLD_DAYS)).toBe("raw");
    });

    it("returns daily for ranges between 90 and 365 days", () => {
      expect(pickAggregateGrain(DAILY_AGGREGATE_THRESHOLD_DAYS + 1)).toBe(
        "daily",
      );
      expect(pickAggregateGrain(180)).toBe("daily");
      expect(pickAggregateGrain(WEEKLY_AGGREGATE_THRESHOLD_DAYS)).toBe("daily");
    });

    it("returns weekly for ranges over one year up to two years", () => {
      expect(pickAggregateGrain(WEEKLY_AGGREGATE_THRESHOLD_DAYS + 1)).toBe(
        "weekly",
      );
      expect(pickAggregateGrain(MONTHLY_AGGREGATE_THRESHOLD_DAYS)).toBe(
        "weekly",
      );
    });

    it("returns monthly for ranges over two years", () => {
      expect(pickAggregateGrain(MONTHLY_AGGREGATE_THRESHOLD_DAYS + 1)).toBe(
        "monthly",
      );
      expect(pickAggregateGrain(3650)).toBe("monthly");
    });

    it("honours an explicit grain override", () => {
      expect(pickAggregateGrain(7, "daily")).toBe("daily");
      expect(pickAggregateGrain(7, "weekly")).toBe("weekly");
      expect(pickAggregateGrain(7, "monthly")).toBe("monthly");
      // "raw" override falls through to the threshold ladder.
      expect(pickAggregateGrain(500, "raw")).toBe("weekly");
    });
  });

  describe("BUCKET_CAP", () => {
    it("caps daily at 365 buckets and monthly at 24", () => {
      expect(BUCKET_CAP.daily).toBe(365);
      expect(BUCKET_CAP.monthly).toBe(24);
      expect(BUCKET_CAP.weekly).toBeGreaterThan(BUCKET_CAP.monthly);
    });
  });

  describe("rangeLengthDays", () => {
    it("counts inclusive days for the same calendar window", () => {
      const from = new Date("2026-05-01T00:00:00.000Z");
      const to = new Date("2026-05-08T00:00:00.000Z");
      expect(rangeLengthDays(from, to)).toBe(7);
    });

    it("returns at least 1 for sub-day windows", () => {
      const t = new Date("2026-05-01T00:00:00.000Z");
      expect(rangeLengthDays(t, t)).toBe(1);
    });
  });

  describe("aggregateRows", () => {
    it("collapses to one row per day per type with mean values", () => {
      const t0 = new Date("2026-05-01T08:00:00.000Z");
      const t1 = new Date("2026-05-01T18:00:00.000Z");
      const t2 = new Date("2026-05-02T08:00:00.000Z");
      const rows = [
        { type: "PULSE", value: 60, measuredAt: t0 },
        { type: "PULSE", value: 80, measuredAt: t1 },
        { type: "PULSE", value: 70, measuredAt: t2 },
      ];

      const out = aggregateRows(rows, "daily");
      expect(out).toHaveLength(2);
      expect(out[0].avg).toBe(70);
      expect(out[0].count).toBe(2);
      expect(out[1].avg).toBe(70);
      expect(out[1].count).toBe(1);
    });

    it("collapses to one row per ISO week (Monday-anchored) with weekly", () => {
      // 2026-05-04 is a Monday; surrounding days share the same bucket.
      const monday = new Date("2026-05-04T10:00:00.000Z");
      const tuesday = new Date("2026-05-05T10:00:00.000Z");
      const nextMonday = new Date("2026-05-11T10:00:00.000Z");
      const rows = [
        { type: "WEIGHT", value: 75.0, measuredAt: monday },
        { type: "WEIGHT", value: 75.5, measuredAt: tuesday },
        { type: "WEIGHT", value: 76.0, measuredAt: nextMonday },
      ];
      const out = aggregateRows(rows, "weekly");
      expect(out).toHaveLength(2);
      expect(out[0].count).toBe(2);
      expect(out[0].avg).toBeCloseTo(75.25, 5);
      expect(out[1].count).toBe(1);
    });

    it("keeps per-type buckets separate on the same day", () => {
      const t = new Date("2026-05-01T12:00:00.000Z");
      const rows = [
        { type: "PULSE", value: 70, measuredAt: t },
        { type: "WEIGHT", value: 75, measuredAt: t },
      ];
      const out = aggregateRows(rows, "daily");
      expect(out).toHaveLength(2);
      const types = new Set(out.map((r) => r.type));
      expect(types).toEqual(new Set(["PULSE", "WEIGHT"]));
    });

    it("collapses to one row per UTC calendar month with monthly", () => {
      const a = new Date("2025-01-05T10:00:00.000Z");
      const b = new Date("2025-01-20T10:00:00.000Z");
      const c = new Date("2025-02-10T10:00:00.000Z");
      const rows = [
        { type: "WEIGHT", value: 75, measuredAt: a },
        { type: "WEIGHT", value: 76, measuredAt: b },
        { type: "WEIGHT", value: 77, measuredAt: c },
      ];
      const out = aggregateRows(rows, "monthly");
      expect(out).toHaveLength(2);
      expect(out[0].count).toBe(2);
      expect(out[0].avg).toBeCloseTo(75.5, 5);
      expect(out[1].count).toBe(1);
      expect(out[1].avg).toBe(77);
      expect(out[0].bucketStart.toISOString()).toBe(
        "2025-01-01T00:00:00.000Z",
      );
      expect(out[1].bucketStart.toISOString()).toBe(
        "2025-02-01T00:00:00.000Z",
      );
    });
  });
});
