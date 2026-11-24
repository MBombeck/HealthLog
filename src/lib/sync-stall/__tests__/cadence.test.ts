import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  CADENCE_FACTOR,
  HISTORY_DAYS,
  MAX_THRESHOLD_MS,
  MIN_DELIVERY_DAYS,
  hourBucket,
  judgeStall,
  learnCadence,
  stallThresholdMs,
} from "../cadence";
import { DEVICE_STALL_FLOOR_MS } from "../devices";
import { STALE_AFTER_MS } from "@/lib/push-relay/healthkit-catch-up";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-20T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** Deliveries every `gapMs` over `days` days, ending at `end`. */
function every(gapMs: number, days: number, end: Date): Date[] {
  const out: Date[] = [];
  for (let t = end.getTime(); t > end.getTime() - days * DAY; t -= gapMs) {
    out.push(new Date(t));
  }
  return out;
}

describe("learnCadence", () => {
  it("counts delivery days and the median gap inside the history window only", () => {
    const until = ago(DAY);
    const hourly = every(HOUR, 14, until);
    // One delivery long before the window must not count.
    const cadence = learnCadence([...hourly, ago(40 * DAY)], until);
    expect(cadence.deliveredDays).toBeGreaterThanOrEqual(HISTORY_DAYS);
    expect(cadence.typicalGapMs).toBe(HOUR);
  });

  it("keeps a long weekend from stretching the gap", () => {
    const until = ago(DAY);
    const daily = every(DAY, 14, until).filter(
      (_, i) => i !== 3 && i !== 4, // two days off
    );
    expect(learnCadence(daily, until).typicalGapMs).toBe(DAY);
  });

  it("has no gap with fewer than two deliveries", () => {
    expect(learnCadence([ago(2 * DAY)], ago(DAY))).toEqual({
      deliveredDays: 1,
      typicalGapMs: null,
    });
  });
});

describe("stallThresholdMs", () => {
  it("holds a source that delivers many times a day to the floor", () => {
    const cadence = { deliveredDays: 14, typicalGapMs: HOUR };
    expect(stallThresholdMs(DAY, cadence)).toBe(DAY);
  });

  it("waits for twice the gap of a source that delivers once a day", () => {
    const cadence = { deliveredDays: 14, typicalGapMs: DAY };
    expect(stallThresholdMs(DAY, cadence)).toBe(CADENCE_FACTOR * DAY);
  });

  it("never waits more than the cap past the floor", () => {
    const cadence = { deliveredDays: 10, typicalGapMs: 10 * DAY };
    expect(stallThresholdMs(DAY, cadence)).toBe(DAY + MAX_THRESHOLD_MS);
  });
});

describe("judgeStall", () => {
  const hourly = { deliveredDays: 14, typicalGapMs: HOUR };

  it("is fresh inside the floor and for a source that never delivered", () => {
    expect(
      judgeStall({
        floorMs: DAY,
        lastAt: ago(23 * HOUR),
        cadence: hourly,
        now: NOW,
      }),
    ).toEqual({ kind: "fresh" });
    expect(
      judgeStall({ floorMs: DAY, lastAt: null, cadence: hourly, now: NOW }),
    ).toEqual({ kind: "fresh" });
  });

  it("asks for the history only once the floor has passed", () => {
    expect(
      judgeStall({
        floorMs: DAY,
        lastAt: ago(25 * HOUR),
        cadence: null,
        now: NOW,
      }),
    ).toEqual({ kind: "needs_history" });
  });

  it("stalls a daily source after 24 hours, since its last delivery", () => {
    expect(
      judgeStall({
        floorMs: DAY,
        lastAt: ago(25 * HOUR),
        cadence: hourly,
        now: NOW,
      }),
    ).toEqual({ kind: "stalled", since: ago(25 * HOUR), thresholdMs: DAY });
  });

  it("only judges a source that delivered on most of the last 14 days", () => {
    const sometimes = {
      deliveredDays: MIN_DELIVERY_DAYS - 1,
      typicalGapMs: HOUR,
    };
    expect(
      judgeStall({
        floorMs: DAY,
        lastAt: ago(3 * DAY),
        cadence: sometimes,
        now: NOW,
      }),
    ).toEqual({ kind: "not_expected" });
    expect(
      judgeStall({
        floorMs: DAY,
        lastAt: ago(3 * DAY),
        cadence: { ...sometimes, deliveredDays: MIN_DELIVERY_DAYS },
        now: NOW,
      }).kind,
    ).toBe("stalled");
  });

  it("waits within the cadence of a once-a-day source", () => {
    const daily = { deliveredDays: 14, typicalGapMs: DAY };
    expect(
      judgeStall({
        floorMs: DAY,
        lastAt: ago(36 * HOUR),
        cadence: daily,
        now: NOW,
      }),
    ).toEqual({ kind: "within_cadence", thresholdMs: 2 * DAY });
  });

  it("measures in absolute time, so a DST change moves no threshold", () => {
    // Europe/Berlin springs forward on 2026-03-29 and falls back on
    // 2026-10-25: the local day is 23 or 25 hours long, the threshold is not.
    for (const now of [
      new Date("2026-03-29T12:00:00.000Z"),
      new Date("2026-10-25T12:00:00.000Z"),
    ]) {
      const before = new Date(now.getTime() - DAY + HOUR);
      const after = new Date(now.getTime() - DAY - HOUR);
      expect(
        judgeStall({ floorMs: DAY, lastAt: before, cadence: hourly, now }).kind,
      ).toBe("fresh");
      expect(
        judgeStall({ floorMs: DAY, lastAt: after, cadence: hourly, now }).kind,
      ).toBe("stalled");
    }
  });
});

describe("the iPhone floor", () => {
  it("leaves the silent catch-up wake to ask first", () => {
    expect(DEVICE_STALL_FLOOR_MS).toBe(DAY);
    expect(STALE_AFTER_MS).toBeLessThan(DEVICE_STALL_FLOOR_MS);
  });

  it("buckets a delivery into its UTC hour", () => {
    expect(hourBucket(new Date("2026-11-20T12:34:56.789Z")).toISOString()).toBe(
      "2026-11-20T12:00:00.000Z",
    );
  });
});
