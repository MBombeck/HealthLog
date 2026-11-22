import { describe, expect, it } from "vitest";

import { CHART_RANGE_TABS } from "@/components/charts/chart-range-tabs";
import { pickRollupGranularityForWindow } from "@/lib/rollups/measurement-read-wmy";

import {
  bucketPeriod,
  firstWindowDayUtc,
  pickRangeBucket,
  pointPeriodLabel,
  RANGE_TAB_GRAIN,
  todayUtc,
} from "../range-grain";

const DAY = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);

describe("pickRangeBucket()", () => {
  // The fixed tabs name their grain: the data's span does not move it. A
  // 90-day window never spans more than 90 days, which is exactly why a
  // span threshold turned the 90-day tab daily.
  it.each([0, 1, 30, 89, 90, 91, 400, 2000])(
    "7 and 30 days stay daily, 90 days is weekly, whatever the span (%d days)",
    (span) => {
      expect(pickRangeBucket(7, span)).toBe("day");
      expect(pickRangeBucket(30, span)).toBe("day");
      expect(pickRangeBucket(90, span)).toBe("week");
    },
  );

  it.each([
    [0, "day"],
    [90, "day"],
    [91, "week"],
    [730, "week"],
    [731, "month"],
  ] as const)("All goes by the span: %d days -> %s", (span, expected) => {
    expect(pickRangeBucket(0, span)).toBe(expected);
  });

  it("names a grain for every fixed range tab", () => {
    for (const tab of CHART_RANGE_TABS) {
      if (tab.days === 0) continue;
      expect(RANGE_TAB_GRAIN[tab.days], `tab ${tab.days}`).toBeDefined();
    }
  });

  // The server's tier must never be coarser than the grain the client
  // captions, or a "weekly avg" chip would sit over monthly rows.
  it("is never finer than the rows the server serves for a fixed tab", () => {
    const coarseness = { day: 0, week: 1, month: 2 } as const;
    const server = { DAY: 0, WEEK: 1, MONTH: 2, YEAR: 3 } as const;
    for (const tab of CHART_RANGE_TABS) {
      if (tab.days === 0) continue;
      expect(
        server[pickRollupGranularityForWindow(tab.days)],
        `tab ${tab.days}`,
      ).toBeLessThanOrEqual(coarseness[pickRangeBucket(tab.days, tab.days)]);
    }
  });
});

describe("firstWindowDayUtc()", () => {
  // The charts keep a day when its noon-UTC timestamp is at or after the
  // cutoff; the first window day must be exactly the earliest such day.
  it.each([
    "2026-11-22T00:00:00.000Z",
    "2026-11-22T11:59:59.999Z",
    "2026-11-22T12:00:00.000Z",
    "2026-11-22T12:00:00.001Z",
    "2026-11-22T23:59:59.999Z",
  ])("matches the slice predicate for a cutoff at %s", (iso) => {
    const cutoff = Date.parse(iso);
    const first = firstWindowDayUtc(cutoff);
    expect(first % DAY).toBe(0);
    expect(first + DAY / 2).toBeGreaterThanOrEqual(cutoff);
    expect(first - DAY / 2).toBeLessThan(cutoff);
  });
});

describe("todayUtc()", () => {
  it("encodes the calendar day of the zone, not of UTC", () => {
    const now = new Date("2026-11-22T23:30:00.000Z");
    expect(todayUtc("UTC", now)).toBe(utc("2026-11-22"));
    expect(todayUtc("Europe/Berlin", now)).toBe(utc("2026-11-23"));
    expect(todayUtc("America/New_York", now)).toBe(utc("2026-11-22"));
  });
});

describe("bucketPeriod()", () => {
  const monday = utc("2026-11-16");

  it("covers Monday to Sunday for a full week inside the window", () => {
    expect(
      bucketPeriod(monday, "week", {
        firstDay: utc("2026-08-25"),
        lastDay: utc("2026-11-30"),
      }),
    ).toEqual({ start: monday, end: utc("2026-11-22") });
  });

  it("ends today for the week still running", () => {
    expect(
      bucketPeriod(monday, "week", {
        firstDay: null,
        lastDay: utc("2026-11-19"),
      }),
    ).toEqual({ start: monday, end: utc("2026-11-19") });
  });

  it("starts at the window's first day for the week the window opens in", () => {
    expect(
      bucketPeriod(monday, "week", {
        firstDay: utc("2026-11-20"),
        lastDay: utc("2026-12-31"),
      }),
    ).toEqual({ start: utc("2026-11-20"), end: utc("2026-11-22") });
  });

  it("runs to the month's last day, February included", () => {
    expect(
      bucketPeriod(utc("2028-02-01"), "month", {
        firstDay: null,
        lastDay: utc("2028-12-31"),
      }),
    ).toEqual({ start: utc("2028-02-01"), end: utc("2028-02-29") });
  });
});

describe("pointPeriodLabel()", () => {
  const formatDate = (date: Date) => date.toISOString().slice(0, 10);
  const t = (key: string, params?: Record<string, string | number>) =>
    `${key}:${params?.start}..${params?.end}`;

  it("prints a daily point as its day", () => {
    expect(
      pointPeriodLabel({ timestamp: utc("2026-11-16") }, formatDate, t),
    ).toBe("2026-11-16");
  });

  it("prints a week as the days it covers", () => {
    expect(
      pointPeriodLabel(
        {
          timestamp: utc("2026-11-16"),
          __periodStart: utc("2026-11-16"),
          __periodEnd: utc("2026-11-19"),
        },
        formatDate,
        t,
      ),
    ).toBe("charts.bucketPeriod:2026-11-16..2026-11-19");
  });

  it("prints a one-day stretch as that day", () => {
    expect(
      pointPeriodLabel(
        {
          timestamp: utc("2026-11-16"),
          __periodStart: utc("2026-11-16"),
          __periodEnd: utc("2026-11-16"),
        },
        formatDate,
        t,
      ),
    ).toBe("2026-11-16");
  });
});
