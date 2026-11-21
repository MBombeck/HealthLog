/**
 * The scheduled report's period maths: which period has closed on the
 * record's clock, and the instant bounds of the report for it, across clock
 * changes, month ends, leap days and year turns.
 */
import { describe, expect, it } from "vitest";

import {
  latestClosedPeriod,
  reportRangeForPeriod,
  reportScheduleSourceId,
  stampReportSchedule,
} from "@/lib/doctor-report/schedule";
import { parseReportSchedule } from "@/lib/doctor-report/schedule-shape";
import { normaliseDateRange } from "@/lib/doctor-report-data";

const BERLIN = "Europe/Berlin";
const LA = "America/Los_Angeles";

describe("latestClosedPeriod", () => {
  it("is the month before on any day of a month", () => {
    const p = latestClosedPeriod(
      "MONTHLY",
      new Date("2026-11-21T12:00:00Z"),
      BERLIN,
    );
    expect(p).toEqual({
      cadence: "MONTHLY",
      key: "2026-10",
      firstDay: "2026-10-01",
      lastDay: "2026-10-31",
    });
  });

  it("follows the record's clock, not UTC, at the turn of a month", () => {
    // 23:30 UTC on 31 October is already 1 November in Berlin…
    const late = new Date("2026-10-31T23:30:00Z");
    expect(latestClosedPeriod("MONTHLY", late, BERLIN).key).toBe("2026-10");
    // …and still 31 October in Los Angeles, where October has not closed.
    expect(latestClosedPeriod("MONTHLY", late, LA).key).toBe("2026-09");
  });

  it("turns the year for January", () => {
    const p = latestClosedPeriod(
      "MONTHLY",
      new Date("2027-01-01T08:00:00Z"),
      BERLIN,
    );
    expect(p.key).toBe("2026-12");
    expect(p.lastDay).toBe("2026-12-31");
  });

  it("ends February on the leap day", () => {
    const p = latestClosedPeriod(
      "MONTHLY",
      new Date("2028-03-10T08:00:00Z"),
      BERLIN,
    );
    expect(p).toMatchObject({ key: "2028-02", lastDay: "2028-02-29" });
    const q = latestClosedPeriod(
      "MONTHLY",
      new Date("2027-03-10T08:00:00Z"),
      BERLIN,
    );
    expect(q).toMatchObject({ key: "2027-02", lastDay: "2027-02-28" });
  });

  it("names quarters, and the first quarter reaches into last year", () => {
    expect(
      latestClosedPeriod("QUARTERLY", new Date("2026-11-21T12:00:00Z"), BERLIN),
    ).toMatchObject({
      key: "2026-Q3",
      firstDay: "2026-07-01",
      lastDay: "2026-09-30",
    });
    expect(
      latestClosedPeriod("QUARTERLY", new Date("2026-02-01T12:00:00Z"), BERLIN),
    ).toMatchObject({
      key: "2025-Q4",
      firstDay: "2025-10-01",
      lastDay: "2025-12-31",
    });
    expect(
      latestClosedPeriod(
        "QUARTERLY",
        new Date("2026-04-01T00:30:00+02:00"),
        BERLIN,
      ).key,
    ).toBe("2026-Q1");
  });

  it("is last year for the yearly cadence", () => {
    expect(
      latestClosedPeriod("YEARLY", new Date("2026-06-01T12:00:00Z"), BERLIN),
    ).toMatchObject({
      key: "2025",
      firstDay: "2025-01-01",
      lastDay: "2025-12-31",
    });
  });
});

describe("reportRangeForPeriod", () => {
  const march = latestClosedPeriod(
    "MONTHLY",
    new Date("2026-04-15T12:00:00Z"),
    BERLIN,
  );
  const october = latestClosedPeriod(
    "MONTHLY",
    new Date("2026-11-15T12:00:00Z"),
    BERLIN,
  );

  it("starts and ends at local midnight across the spring clock change", () => {
    const { start, end } = reportRangeForPeriod(march, "PERIOD", BERLIN);
    // 1 March is CET (+01:00), 1 April is CEST (+02:00).
    expect(start.toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-31T21:59:59.999Z");
    // 743 hours, still 31 days.
    expect(
      normaliseDateRange(
        { startDate: start.toISOString(), endDate: end.toISOString() },
        new Date(),
        BERLIN,
      ).days,
    ).toBe(31);
  });

  it("starts and ends at local midnight across the autumn clock change", () => {
    const { start, end } = reportRangeForPeriod(october, "PERIOD", BERLIN);
    expect(start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-31T22:59:59.999Z");
    expect(
      normaliseDateRange(
        { startDate: start.toISOString(), endDate: end.toISOString() },
        new Date(),
        BERLIN,
      ).days,
    ).toBe(31);
  });

  it("reaches back the window's days from the end of the period", () => {
    const r90 = reportRangeForPeriod(october, "LAST_90_DAYS", BERLIN);
    expect(r90.firstDay).toBe("2026-08-03");
    expect(r90.end.toISOString()).toBe("2026-10-31T22:59:59.999Z");
    const r365 = reportRangeForPeriod(october, "LAST_365_DAYS", BERLIN);
    expect(r365.firstDay).toBe("2025-11-01");
    expect(
      normaliseDateRange(
        {
          startDate: r365.start.toISOString(),
          endDate: r365.end.toISOString(),
        },
        new Date(),
        BERLIN,
      ).days,
    ).toBe(365);
  });

  it("covers a whole year for the yearly period", () => {
    const year = latestClosedPeriod(
      "YEARLY",
      new Date("2026-01-01T12:00:00Z"),
      BERLIN,
    );
    const { start, end } = reportRangeForPeriod(year, "PERIOD", BERLIN);
    expect(start.toISOString()).toBe("2024-12-31T23:00:00.000Z");
    expect(end.toISOString()).toBe("2025-12-31T22:59:59.999Z");
  });
});

describe("the schedule blob", () => {
  it("keys a period's report by cadence and period", () => {
    expect(
      reportScheduleSourceId(
        latestClosedPeriod(
          "QUARTERLY",
          new Date("2026-11-21T12:00:00Z"),
          BERLIN,
        ),
      ),
    ).toBe("QUARTERLY:2026-Q3");
  });

  it("reads off for null and for a shape it does not know", () => {
    expect(parseReportSchedule(null)).toBeNull();
    expect(parseReportSchedule({ v: 2, cadence: "MONTHLY" })).toBeNull();
    expect(
      parseReportSchedule({
        v: 1,
        cadence: "WEEKLY",
        window: "PERIOD",
        lastPeriod: null,
        lastOutcome: null,
        lastRunAt: null,
      }),
    ).toBeNull();
  });

  it("stamps the period and the outcome, keeping the choice", () => {
    const schedule = {
      v: 1 as const,
      cadence: "MONTHLY" as const,
      window: "LAST_90_DAYS" as const,
      lastPeriod: null,
      lastOutcome: null,
      lastRunAt: null,
    };
    const now = new Date("2026-11-01T04:25:00Z");
    const period = latestClosedPeriod("MONTHLY", now, BERLIN);
    expect(stampReportSchedule(schedule, period, "stored", now)).toEqual({
      ...schedule,
      lastPeriod: "2026-10",
      lastOutcome: "stored",
      lastRunAt: now.toISOString(),
    });
  });
});
