import { beforeEach, describe, expect, it, vi } from "vitest";

const checkRateLimit = vi.hoisted(() => vi.fn());
const enqueueTodayBriefingWarm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));
vi.mock("@/lib/jobs/insight-pregenerate-shared", () => ({
  enqueueTodayBriefingWarm,
}));

import {
  __resetTodayWarmClaimsForTests,
  requestTodayBriefingWarm,
  todayWarmReasons,
  type TodayWarmInput,
} from "@/lib/daily/briefing-today-warm";

/** The nightly warm: 04:30 in Berlin on 2026-10-05. */
const NIGHTLY = "2026-10-05T02:30:00.000Z";

function input(over: Partial<TodayWarmInput>): TodayWarmInput {
  return {
    userId: "u1",
    locale: "en",
    timezone: "Europe/Berlin",
    generatedAt: NIGHTLY,
    lastSeenAt: () => null,
    now: new Date("2026-10-05T10:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  __resetTodayWarmClaimsForTests();
  checkRateLimit.mockReset().mockResolvedValue({ allowed: true });
  enqueueTodayBriefingWarm.mockReset().mockResolvedValue(undefined);
});

describe("todayWarmReasons — the reader's own morning", () => {
  it("Berlin: the nightly briefing covers the day", () => {
    expect(todayWarmReasons(input({}))).toEqual([]);
  });

  it("Los Angeles: the Berlin nightly is yesterday evening, so the morning asks", () => {
    // 07:00 on 5 October in Los Angeles; the warm ran 19:30 on the 4th.
    expect(
      todayWarmReasons(
        input({
          timezone: "America/Los_Angeles",
          now: new Date("2026-10-05T14:00:00.000Z"),
        }),
      ),
    ).toEqual(["day"]);
  });

  it("Seoul: after local midnight the 11:30 briefing is yesterday's", () => {
    // 01:00 on 6 October in Seoul; the warm ran 11:30 on the 5th.
    expect(
      todayWarmReasons(
        input({
          timezone: "Asia/Seoul",
          now: new Date("2026-10-05T16:00:00.000Z"),
        }),
      ),
    ).toEqual(["day"]);
    // 14:00 on the 5th, after the warm: covered.
    expect(
      todayWarmReasons(
        input({
          timezone: "Asia/Seoul",
          now: new Date("2026-10-05T05:00:00.000Z"),
        }),
      ),
    ).toEqual([]);
  });

  it("asks when a signal metric's first reading lands after the briefing", () => {
    // Blood pressure at 07:10 Berlin, weight at 07:12, after the 04:30 warm.
    const seen: Record<string, string> = {
      BLOOD_PRESSURE_SYS: "2026-10-05T05:10:00.000Z",
      WEIGHT: "2026-10-05T05:12:00.000Z",
      // Yesterday's pulse is not today's and asks for nothing.
      PULSE: "2026-10-04T06:50:00.000Z",
    };
    expect(
      todayWarmReasons(input({ lastSeenAt: (t) => seen[t] ?? null })),
    ).toEqual(["reading:BLOOD_PRESSURE_SYS", "reading:WEIGHT"]);
  });

  it("does not ask for a reading the briefing already read", () => {
    expect(
      todayWarmReasons(
        input({
          lastSeenAt: (t) =>
            t === "WEIGHT" ? "2026-10-05T02:00:00.000Z" : null,
        }),
      ),
    ).toEqual([]);
  });

  it("asks when the briefing's generation moment is unknown", () => {
    expect(todayWarmReasons(input({ generatedAt: null }))).toEqual(["day"]);
  });
});

describe("requestTodayBriefingWarm — once per reason per day", () => {
  it("enqueues an immediate warm for the day's first read with no briefing", async () => {
    await requestTodayBriefingWarm(
      input({
        timezone: "America/Los_Angeles",
        now: new Date("2026-10-05T14:00:00.000Z"),
      }),
    );
    expect(checkRateLimit).toHaveBeenCalledWith(
      "briefing-today:u1:2026-10-05:day",
      1,
      expect.any(Number),
    );
    expect(enqueueTodayBriefingWarm).toHaveBeenCalledWith({
      userId: "u1",
      locale: "en",
      immediate: true,
    });
  });

  it("waits out a burst of readings before the warm runs", async () => {
    await requestTodayBriefingWarm(
      input({
        lastSeenAt: (t) =>
          t === "BLOOD_PRESSURE_SYS" ? "2026-10-05T05:10:00.000Z" : null,
      }),
    );
    expect(enqueueTodayBriefingWarm).toHaveBeenCalledWith(
      expect.objectContaining({ immediate: false }),
    );
  });

  it("asks once: a second read in the same day neither queries nor enqueues", async () => {
    const la = input({
      timezone: "America/Los_Angeles",
      now: new Date("2026-10-05T14:00:00.000Z"),
    });
    await requestTodayBriefingWarm(la);
    await requestTodayBriefingWarm(la);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(enqueueTodayBriefingWarm).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue when another process already claimed the reason", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false });
    await requestTodayBriefingWarm(input({ generatedAt: null }));
    expect(enqueueTodayBriefingWarm).not.toHaveBeenCalled();
  });

  it("asks again on the next local day", async () => {
    await requestTodayBriefingWarm(input({ generatedAt: null }));
    await requestTodayBriefingWarm(
      input({
        generatedAt: null,
        now: new Date("2026-10-06T10:00:00.000Z"),
      }),
    );
    expect(enqueueTodayBriefingWarm).toHaveBeenCalledTimes(2);
  });
});

describe("requestTodayBriefingWarm — the worst day", () => {
  it("enqueues at most one warm per reason per local day, however often it is read", async () => {
    // A Postgres bucket in memory: one claim per key.
    const buckets = new Map<string, number>();
    checkRateLimit.mockImplementation(async (key: string) => {
      const n = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, n);
      return { allowed: n <= 1 };
    });
    // Every signal type gets its first reading at a different hour, and the
    // dashboard is read every two minutes from midnight to midnight, with
    // the briefing never refreshed (the worst case: every warm capped).
    const types = [
      "BLOOD_PRESSURE_SYS",
      "WEIGHT",
      "PULSE",
      "RESTING_HEART_RATE",
      "HEART_RATE_VARIABILITY",
      "BODY_TEMPERATURE",
      "BLOOD_GLUCOSE",
    ];
    const dayStart = Date.parse("2026-10-04T22:00:00.000Z"); // 00:00 Berlin
    for (let minute = 0; minute < 24 * 60; minute += 2) {
      const now = new Date(dayStart + minute * 60_000);
      await requestTodayBriefingWarm(
        input({
          generatedAt: "2026-10-04T02:30:00.000Z",
          now,
          lastSeenAt: (type) => {
            const hour = 6 + types.indexOf(type) * 2;
            const at = dayStart + hour * 3_600_000;
            return types.includes(type) && at <= now.getTime()
              ? new Date(at).toISOString()
              : null;
          },
        }),
      );
    }
    // One for the day, one per signal reading type.
    expect(enqueueTodayBriefingWarm).toHaveBeenCalledTimes(1 + types.length);
  });
});
