import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChartContextResponse } from "@/lib/charts/context-markers-contract";

import { resolveContextMarks } from "../health-chart/context-marks";

/**
 * Where the context marks land on the point-index axis. The placement is
 * calendar arithmetic on day keys, so the zone the browser runs in and the
 * wall clock (a DST night included) must not move a mark by a day: the
 * last block runs the same placement under several zones with the clock
 * pinned on their changeovers.
 */
const DAY_MS = 86_400_000;

/** Daily points the way the chart holds them: noon UTC of each day key. */
function daily(keys: string[]) {
  return keys.map((k) => ({ timestamp: Date.parse(`${k}T12:00:00Z`) }));
}

function days(from: string, count: number, step = 1): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * step * DAY_MS).toISOString().slice(0, 10),
  );
}

function context(
  partial: Partial<ChartContextResponse> = {},
): ChartContextResponse {
  return {
    today: "2026-11-03",
    medications: [],
    illnesses: [],
    cyclePhases: [],
    ...partial,
  };
}

function med(date: string, id = date) {
  return {
    id,
    medicationId: "m1",
    kind: "doseChange" as const,
    date,
    estimated: false,
    name: "Ramipril",
    dose: "10 mg",
    href: "/medications/m1/history",
  };
}

const OPTIONS = { bucket: "day" as const, showCycle: false, plotWidth: 1000 };

describe("resolveContextMarks", () => {
  it("is null with nothing in the window, so the chart draws as before", () => {
    const points = daily(days("2026-10-01", 30));
    expect(resolveContextMarks(null, points, OPTIONS)).toBeNull();
    expect(resolveContextMarks(context(), points, OPTIONS)).toBeNull();
    // Marks outside the drawn days.
    expect(
      resolveContextMarks(
        context({
          medications: [med("2026-09-01")],
          illnesses: [
            {
              id: "e",
              start: "2026-08-01",
              end: "2026-08-05",
              label: "Flu",
              href: "/illness/e",
            },
          ],
        }),
        points,
        OPTIONS,
      ),
    ).toBeNull();
    // One point is no axis to place anything on.
    expect(
      resolveContextMarks(
        context({ medications: [med("2026-10-01")] }),
        daily(["2026-10-01"]),
        OPTIONS,
      ),
    ).toBeNull();
  });

  it("places a mark on its day, and between readings in proportion", () => {
    // Readings every third day.
    const points = daily(days("2026-10-01", 10, 3));
    const marks = resolveContextMarks(
      context({
        medications: [med("2026-10-04", "a"), med("2026-10-05", "b")],
      }),
      points,
      OPTIONS,
    );
    expect(marks?.lines[0]).toBe(1);
    expect(marks?.lines[1]).toBeCloseTo(1 + 1 / 3, 10);
  });

  it("cuts a span at the drawn edges and runs an open one to today", () => {
    const points = daily(days("2026-10-01", 31));
    const marks = resolveContextMarks(
      context({
        today: "2026-10-31",
        illnesses: [
          {
            id: "a",
            start: "2026-09-20",
            end: "2026-10-03",
            label: "Flu",
            href: "/illness/a",
          },
          {
            id: "b",
            start: "2026-10-20",
            end: null,
            label: "Cold",
            href: "/illness/b",
          },
        ],
      }),
      points,
      OPTIONS,
    );
    expect(marks?.areas).toEqual([
      { x1: 0, x2: 2.5 },
      { x1: 18.5, x2: 30 },
    ]);
    // The button of a span sits at its first drawn day.
    expect(marks?.groups.map((g) => g.x)).toEqual([0, 18.5]);
  });

  it("groups marks closer than a fingertip into one button", () => {
    const points = daily(days("2026-10-01", 91));
    // 1000 px over 90 days: 11 px a day, 24 px is about two days.
    const marks = resolveContextMarks(
      context({
        medications: [
          med("2026-10-10", "a"),
          med("2026-10-11", "b"),
          med("2026-10-20", "c"),
        ],
      }),
      points,
      OPTIONS,
    );
    expect(marks?.groups.map((g) => g.entries.length)).toEqual([2, 1]);
  });

  it("offers the cycle only on days, and draws it only when switched on", () => {
    const points = daily(days("2026-10-01", 30));
    const ctx = context({
      cyclePhases: [
        { phase: "MENSTRUAL", start: "2026-10-05", end: "2026-10-09" },
      ],
    });
    const off = resolveContextMarks(ctx, points, OPTIONS);
    expect(off).toMatchObject({ hasCycle: true, phases: [], groups: [] });
    const on = resolveContextMarks(ctx, points, {
      ...OPTIONS,
      showCycle: true,
    });
    expect(on?.phases).toEqual([{ x1: 3.5, x2: 8.5, phase: "MENSTRUAL" }]);
    // A week point averages several phases: no cycle at all.
    const weekly = resolveContextMarks(
      ctx,
      days("2026-09-28", 6, 7).map((k) => ({
        timestamp: Date.parse(`${k}T00:00:00Z`),
      })),
      { ...OPTIONS, bucket: "week", showCycle: true },
    );
    expect(weekly).toBeNull();
  });

  it("puts a mark into the week it falls in, the last week included", () => {
    // Week points at UTC midnight of each Monday.
    const points = days("2026-09-28", 6, 7).map((k) => ({
      timestamp: Date.parse(`${k}T00:00:00Z`),
    }));
    const marks = resolveContextMarks(
      context({ medications: [med("2026-10-05"), med("2026-11-08")] }),
      points,
      { ...OPTIONS, bucket: "week" },
    );
    // The Monday of the second week, and the Sunday closing the last one.
    expect(marks?.lines).toEqual([1, 5]);
  });
});

describe("resolveContextMarks across zones and DST nights", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = originalTz;
  });

  const cases: Array<[string, string]> = [
    ["Europe/Berlin", "2026-10-25T01:30:00Z"],
    ["Europe/Berlin", "2026-03-29T00:30:00Z"],
    ["America/Los_Angeles", "2026-11-01T09:30:00Z"],
    ["America/Los_Angeles", "2026-03-08T10:30:00Z"],
    ["Pacific/Auckland", "2026-04-04T14:30:00Z"],
    ["Asia/Kolkata", "2026-10-25T20:00:00Z"],
  ];

  it.each(cases)("places every day on its own point in %s at %s", (tz, now) => {
    process.env.TZ = tz;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    // Sixty days around both changeovers of the year in question.
    const center = now.slice(0, 10);
    const start = new Date(Date.parse(`${center}T00:00:00Z`) - 30 * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const keys = days(start, 61);
    const marks = resolveContextMarks(
      context({ today: center, medications: keys.map((k) => med(k)) }),
      daily(keys),
      { ...OPTIONS, plotWidth: 100_000 },
    );
    expect(marks?.lines).toEqual(keys.map((_, i) => i));
  });
});
