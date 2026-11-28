import { describe, expect, it } from "vitest";

import { shiftDateKey } from "@/lib/tz/format";
import { NO_ACTIVITY_GOALS } from "@/lib/validations/activity-goals";

import {
  BASELINE_DAYS,
  MIN_BASELINE_DAYS,
  activeMinutesOf,
  baselineStats,
  buildActivityCalendar,
  comparePeriod,
  dayLevel,
  daysInMonth,
  goalProgress,
  periodBounds,
  quantileSorted,
  shiftMonth,
  weekStartOf,
  type ActivityDayInput,
} from "../calendar-math";

function day(
  date: string,
  over: Partial<ActivityDayInput> = {},
): ActivityDayInput {
  return {
    date,
    steps: null,
    exerciseMinutes: null,
    workoutMinutes: 0,
    workoutCount: 0,
    workoutsBySport: {},
    load: null,
    ...over,
  };
}

describe("quantiles", () => {
  it("interpolates linearly between ranks (PERCENTILE.INC)", () => {
    const s = [1, 2, 3, 4, 5];
    expect(quantileSorted(s, 0)).toBe(1);
    expect(quantileSorted(s, 0.5)).toBe(3);
    expect(quantileSorted(s, 0.25)).toBe(2);
    expect(quantileSorted([10, 20], 0.5)).toBe(15);
    expect(quantileSorted([10, 20, 30, 40], 0.9)).toBeCloseTo(37);
  });

  it("refuses a baseline below the day floor", () => {
    expect(baselineStats(Array(MIN_BASELINE_DAYS - 1).fill(5000))).toBeNull();
    const stats = baselineStats(
      Array.from({ length: 20 }, (_, i) => (i + 1) * 1000),
    );
    expect(stats?.days).toBe(20);
    expect(stats?.median).toBe(10500);
  });
});

describe("day level against the person's own spread", () => {
  const stats = baselineStats(Array.from({ length: 100 }, (_, i) => i))!;
  it.each([
    [null, "none"],
    [5, "low"],
    [20, "below"],
    [50, "usual"],
    [80, "above"],
    [95, "high"],
  ] as const)("%s → %s", (value, level) => {
    expect(dayLevel(value, stats)).toBe(level);
  });

  it("is unrated without a baseline, not guessed", () => {
    expect(dayLevel(9000, null)).toBe("unrated");
  });
});

describe("active minutes never double-count a workout", () => {
  it("takes the larger of exercise and workout minutes", () => {
    expect(
      activeMinutesOf(
        day("2026-05-01", { exerciseMinutes: 40, workoutMinutes: 30 }),
        true,
      ),
    ).toBe(40);
    expect(
      activeMinutesOf(
        day("2026-05-01", { exerciseMinutes: 10, workoutMinutes: 45 }),
        true,
      ),
    ).toBe(45);
  });
  it("is 0 on a quiet day once the account has activity data, otherwise unknown", () => {
    expect(activeMinutesOf(day("2026-05-01"), true)).toBe(0);
    expect(activeMinutesOf(day("2026-05-01"), false)).toBeNull();
  });
});

describe("period bounds", () => {
  it("weeks run Monday to Sunday", () => {
    // 2026-10-21 is a Wednesday.
    expect(weekStartOf("2026-10-21")).toBe("2026-10-19");
    expect(weekStartOf("2026-10-19")).toBe("2026-10-19");
    expect(weekStartOf("2026-10-25")).toBe("2026-10-19");
    const b = periodBounds("week", "2026-10-21");
    expect([b.start, b.end]).toEqual(["2026-10-19", "2026-10-25"]);
    expect(b.readStart).toBe(shiftDateKey("2026-10-19", -BASELINE_DAYS));
  });

  it("a month grid covers whole weeks and reads six months back", () => {
    const b = periodBounds("month", "2026-02-14");
    expect([b.start, b.end]).toEqual(["2026-02-01", "2026-02-28"]);
    expect(b.gridStart).toBe("2026-01-26");
    expect(b.gridEnd).toBe("2026-03-01");
    expect(b.readStart).toBe("2025-08-01");
  });

  it("month arithmetic handles length and year turns", () => {
    expect(daysInMonth("2024-02-01")).toBe(29);
    expect(daysInMonth("2026-02-01")).toBe(28);
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftMonth("2026-12-01", 1)).toBe("2027-01-01");
  });
});

describe("period against the usual period", () => {
  it("compares a finished week with the median of the twelve before", () => {
    const values = new Map<string, number>();
    // Twelve earlier weeks at 7 000 a day, this week at 10 000 a day.
    const bounds = periodBounds("week", "2026-10-05");
    for (let i = 1; i <= 84; i++)
      values.set(shiftDateKey(bounds.start, -i), 7000);
    for (let i = 0; i < 7; i++)
      values.set(shiftDateKey(bounds.start, i), 10000);
    const result = comparePeriod({
      bounds,
      today: "2026-10-21",
      valueOf: (d) => values.get(d) ?? null,
      mode: "sum",
    });
    expect(result.value).toBe(70000);
    expect(result.usual).toBe(49000);
    expect(result.usualToDate).toBe(49000);
    expect(result.referencePeriods).toBe(12);
    // 70 000 against 49 000: the server resolves the change, a client draws it.
    expect(result.change).toBeCloseTo(21000 / 49000, 10);
  });

  it("compares a running period over its completed days, never today's partial day", () => {
    const bounds = periodBounds("week", "2026-10-21");
    const values = new Map<string, number>();
    for (let i = 1; i <= 84; i++)
      values.set(shiftDateKey(bounds.start, -i), 1000);
    const result = comparePeriod({
      bounds,
      today: "2026-10-21", // Wednesday: three days elapsed
      valueOf: (d) =>
        values.get(d) ?? (d <= "2026-10-21" && d >= bounds.start ? 2000 : null),
      mode: "sum",
    });
    // The total shown counts today; the comparison stops at yesterday.
    expect(result.value).toBe(6000);
    expect(result.usual).toBe(7000);
    expect(result.completedDays).toBe(2);
    expect(result.completedValue).toBe(4000);
    expect(result.usualToDate).toBe(2000);
    expect(result.change).toBe(1);
  });

  it("has nothing to compare on the first day of a period", () => {
    const bounds = periodBounds("week", "2026-10-19");
    const result = comparePeriod({
      bounds,
      today: "2026-10-19", // Monday
      valueOf: (d) => (d <= "2026-10-19" ? 1000 : null),
      mode: "sum",
    });
    expect(result.value).toBe(1000);
    expect(result.usual).toBe(7000);
    expect(result.completedDays).toBe(0);
    expect(result.completedValue).toBeNull();
    expect(result.usualToDate).toBeNull();
    expect(result.change).toBeNull();
  });

  it("compares months per day, so February meets March fairly", () => {
    const bounds = periodBounds("month", "2026-02-10");
    const result = comparePeriod({
      bounds,
      today: "2026-10-21",
      valueOf: (d) => (d < "2026-03-01" ? 100 : null),
      mode: "sum",
    });
    expect(result.value).toBe(2800);
    // Six earlier months at 100 a day → 28 days × 100.
    expect(result.usual).toBe(2800);
  });

  it("gives no usual with fewer than three earlier periods of data", () => {
    const bounds = periodBounds("week", "2026-10-05");
    const result = comparePeriod({
      bounds,
      today: "2026-10-21",
      valueOf: (d) => (d >= shiftDateKey(bounds.start, -14) ? 500 : null),
      mode: "sum",
    });
    expect(result.referencePeriods).toBe(2);
    expect(result.usual).toBeNull();
  });
});

describe("goals", () => {
  it("reports only goals that are set, for the period they belong to", () => {
    const goals = {
      ...NO_ACTIVITY_GOALS,
      workoutsPerWeek: 3,
      stepsPerMonth: 200000,
    };
    expect(goalProgress("week", goals, { workouts: 4 })).toEqual([
      { key: "workoutsPerWeek", target: 3, value: 4, met: true },
    ]);
    expect(goalProgress("month", goals, { steps: 150000 })).toEqual([
      { key: "stepsPerMonth", target: 200000, value: 150000, met: false },
    ]);
    expect(goalProgress("week", NO_ACTIVITY_GOALS, { workouts: 9 })).toEqual(
      [],
    );
  });
});

describe("the assembled calendar", () => {
  const today = "2026-10-21";
  const bounds = periodBounds("month", today);
  // 84 baseline days of 5 000–9 000 steps, a run every Monday.
  const input: ActivityDayInput[] = [];
  for (let i = 1; i <= 200; i++) {
    const date = shiftDateKey(bounds.start, -i);
    input.push(
      day(date, {
        steps: 5000 + (i % 5) * 1000,
        workoutCount: i % 7 === 0 ? 1 : 0,
        workoutMinutes: i % 7 === 0 ? 30 : 0,
        workoutsBySport: i % 7 === 0 ? { running: 1 } : {},
      }),
    );
  }
  input.push(
    day("2026-10-02", {
      steps: 15000,
      workoutCount: 2,
      workoutMinutes: 90,
      workoutsBySport: { running: 1, cycling: 1 },
    }),
  );
  input.push(day("2026-10-03", { steps: 2000 }));
  const calendar = buildActivityCalendar({
    bounds,
    today,
    input,
    goals: { ...NO_ACTIVITY_GOALS, workoutsPerWeek: 2 },
  });

  it("draws whole weeks and marks the days after today as future", () => {
    expect(calendar.days[0].date).toBe(calendar.gridStart);
    expect(calendar.days.length % 7).toBe(0);
    const future = calendar.days.find((d) => d.date === "2026-10-22");
    expect(future?.future).toBe(true);
    expect(future?.level.steps).toBe("none");
  });

  it("rates a big day high and a short one low against the person's own spread", () => {
    expect(calendar.baseline.steps?.days).toBe(BASELINE_DAYS);
    expect(
      calendar.days.find((d) => d.date === "2026-10-02")?.level.steps,
    ).toBe("high");
    expect(
      calendar.days.find((d) => d.date === "2026-10-03")?.level.steps,
    ).toBe("low");
    expect(
      calendar.days.find((d) => d.date === "2026-10-04")?.level.steps,
    ).toBe("none");
  });

  it("shows today as in progress, never rated against whole days", () => {
    const morning = buildActivityCalendar({
      bounds,
      today,
      input: [...input, day(today, { steps: 800 })],
      goals: NO_ACTIVITY_GOALS,
    });
    const todayCell = morning.days.find((d) => d.date === today);
    expect(todayCell?.steps).toBe(800);
    expect(todayCell?.level.steps).toBe("in_progress");
    expect(todayCell?.level.activeMinutes).toBe("in_progress");
    expect(todayCell?.level.load).toBe("none");
    // Yesterday, with the same value, is rated.
    const yesterday = buildActivityCalendar({
      bounds,
      today,
      input: [...input, day("2026-10-20", { steps: 800 })],
      goals: NO_ACTIVITY_GOALS,
    }).days.find((d) => d.date === "2026-10-20");
    expect(yesterday?.level.steps).toBe("low");
  });

  it("counts workouts by sport in the period", () => {
    expect(calendar.sports).toEqual([
      { sportType: "cycling", count: 1 },
      { sportType: "running", count: 1 },
    ]);
    expect(calendar.summary.workouts.value).toBe(2);
  });

  it("marks weekly goals per calendar row, and none for a week not yet begun", () => {
    const week = calendar.weeks.find((w) => w.start === "2026-09-28");
    expect(week?.goals).toEqual([
      { key: "workoutsPerWeek", target: 2, value: 2, met: true },
    ]);
    const last = calendar.weeks[calendar.weeks.length - 1];
    expect(last.start > today).toBe(true);
    expect(last.goals).toEqual([]);
    expect(calendar.next).toBeNull();
    expect(calendar.previous).toBe("2026-09-01");
  });

  it("offers only the signals the account has", () => {
    expect(calendar.available).toEqual({
      steps: true,
      activeMinutes: true,
      workouts: true,
      load: false,
    });
  });
});
