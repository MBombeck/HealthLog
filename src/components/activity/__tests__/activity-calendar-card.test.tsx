/**
 * `<ActivityCalendarCard>` draws what the server computed (SSR markup, like
 * the other component suites). The arithmetic is pinned in
 * `src/lib/activity/__tests__/calendar-math.test.ts`; this suite pins that
 * the card shows each day's level, the workouts, the summary against the
 * usual and the goals, and that a shared record gets no goal editor.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  buildActivityCalendar,
  periodBounds,
  type ActivityDayInput,
} from "@/lib/activity/calendar-math";
import { shiftDateKey } from "@/lib/tz/format";
import { NO_ACTIVITY_GOALS } from "@/lib/validations/activity-goals";

const state: { data: unknown; shared: boolean } = {
  data: undefined,
  shared: false,
};

vi.mock("@/hooks/use-activity-calendar", () => ({
  useActivityCalendar: () => ({
    data: state.data,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSaveActivityGoals: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/hooks/use-record-capabilities", async (importOriginal) => ({
  holdsOwnerRights: (
    await importOriginal<typeof import("@/hooks/use-record-capabilities")>()
  ).holdsOwnerRights,
  useRecordCapabilities: () => ({ inSharedRecord: state.shared }),
}));

import { ActivityCalendarCard } from "../activity-calendar-card";
import { parseGoalField } from "../activity-goals-sheet";

function calendar() {
  const today = "2026-10-21";
  const bounds = periodBounds("month", today);
  const input: ActivityDayInput[] = [];
  for (let i = 1; i <= 200; i++) {
    input.push({
      date: shiftDateKey(bounds.start, -i),
      steps: 6000 + (i % 4) * 500,
      exerciseMinutes: 30,
      workoutMinutes: 0,
      workoutCount: 0,
      workoutsBySport: {},
      load: null,
    });
  }
  // This morning: a few hundred steps so far.
  input.push({
    date: today,
    steps: 400,
    exerciseMinutes: null,
    workoutMinutes: 0,
    workoutCount: 0,
    workoutsBySport: {},
    load: null,
  });
  input.push({
    date: "2026-10-05",
    steps: 20000,
    exerciseMinutes: 90,
    workoutMinutes: 75,
    workoutCount: 1,
    workoutsBySport: { running: 1 },
    load: null,
  });
  return {
    ...buildActivityCalendar({
      bounds,
      today,
      input,
      goals: {
        ...NO_ACTIVITY_GOALS,
        workoutsPerWeek: 1,
        stepsPerMonth: 100000,
      },
    }),
    timezone: "Europe/Berlin",
    loadType: null,
  };
}

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ActivityCalendarCard />
    </I18nProvider>,
  );
}

describe("ActivityCalendarCard", () => {
  it("shows a loading frame before the data arrives", () => {
    state.data = undefined;
    expect(render()).toContain('data-slot="activity-calendar-loading"');
  });

  it("draws every day of the grid with its level", () => {
    state.data = calendar();
    const html = render();
    const days = html.match(/data-slot="activity-calendar-day"/g) ?? [];
    expect(days.length).toBe(35);
    expect(html).toMatch(/data-date="2026-10-05" data-level="high"/);
    expect(html).toMatch(/data-date="2026-10-30" data-level="none"/);
    // The accessible name carries the figures and the level in words.
    expect(html).toContain("20,000 steps");
    expect(html).toContain("Far above your usual");
  });

  it("summarises the period against the usual and lists the sports", () => {
    state.data = calendar();
    const html = render();
    expect(html).toContain('data-metric="steps"');
    // A running month is compared through yesterday, not on today.
    expect(html).toContain("Through yesterday");
    expect(html).toContain("your usual by then");
    expect(html).toContain("Running: 1");
  });

  it("marks today as in progress rather than rating it", () => {
    state.data = calendar();
    const html = render();
    expect(html).toMatch(/data-date="2026-10-21" data-level="in_progress"/);
    expect(html).toContain("Today, still in progress");
  });

  it("shows goal progress and a week tick column", () => {
    state.data = calendar();
    const html = render();
    expect(html).toContain("Steps per month");
    // Stable hooks for the end-to-end spec, independent of the wording.
    expect(html).toContain(
      'data-slot="activity-calendar-goal" data-goal-key="stepsPerMonth"',
    );
    expect(html).toMatch(
      /data-slot="activity-calendar"[^>]*data-period="month"/,
    );
    expect(html).toContain(
      'data-slot="activity-calendar-week-goal" data-met="true"',
    );
    expect(html).toContain('data-slot="activity-calendar-set-goals"');
  });

  it("offers no goal editor inside somebody else's record", () => {
    state.data = calendar();
    state.shared = true;
    const html = render();
    state.shared = false;
    expect(html).not.toContain('data-slot="activity-calendar-set-goals"');
  });
});

describe("goal field parsing", () => {
  it("blank clears, digits within bounds pass, anything else is refused", () => {
    expect(parseGoalField("workoutsPerWeek", " ")).toEqual({
      ok: true,
      value: null,
    });
    expect(parseGoalField("workoutsPerWeek", "4")).toEqual({
      ok: true,
      value: 4,
    });
    expect(parseGoalField("workoutsPerWeek", "0")).toEqual({ ok: false });
    expect(parseGoalField("stepsPerWeek", "10.000")).toEqual({ ok: false });
    expect(parseGoalField("stepsPerWeek", "70000")).toEqual({
      ok: true,
      value: 70000,
    });
    expect(parseGoalField("stepsPerMonth", "99999999")).toEqual({ ok: false });
  });
});
