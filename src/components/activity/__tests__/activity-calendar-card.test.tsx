/**
 * `<ActivityCalendarCard>` draws what the server computed (SSR markup, like
 * the other component suites). The arithmetic is pinned in
 * `src/lib/activity/__tests__/calendar-math.test.ts`; this suite pins that
 * the card shows each day's level, the workouts, and the period's figures
 * with the change the server resolved, and that the goals editor shows
 * progress.
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
import {
  ActivityGoalsForm,
  countActivityGoals,
  parseGoalField,
} from "../activity-goals-form";

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
      <ActivityCalendarCard measure="steps" onMeasureChange={() => {}} />
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

  it("shows the period's figures with the change the server resolved", () => {
    const data = calendar();
    state.data = data;
    const html = render();
    expect(html).toContain('data-metric="steps"');
    expect(html).toContain('data-metric="workouts"');
    // The card prints the server's `change`; it computes none of its own.
    const change = data.summary.steps.change;
    expect(change).not.toBeNull();
    expect(html).toContain('data-slot="activity-calendar-change"');
    // No comparison sentences, no sport chips, no week switch.
    expect(html).not.toContain("Through yesterday");
    expect(html).not.toContain("Running: 1");
    expect(html).not.toContain("activity-calendar-period");
  });

  it("marks today as in progress rather than rating it", () => {
    state.data = calendar();
    const html = render();
    expect(html).toMatch(/data-date="2026-10-21" data-level="in_progress"/);
    expect(html).toContain("Today, still in progress");
  });

  it("offers the measure as one menu only when there is more than one", () => {
    state.data = calendar();
    const html = render();
    // Steps and active minutes are available, so the measure menu shows.
    expect(html).toContain('data-slot="activity-calendar-measure"');
    expect(html).toContain('data-value="steps"');
  });
});

describe("goals editor", () => {
  it("counts the goals set and shows progress beside each", () => {
    const data = calendar();
    expect(countActivityGoals(data.goals)).toBe(2);
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ActivityGoalsForm
          formId="goals"
          goals={data.goals}
          progress={data.goalProgress}
          onSaved={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain("Steps per month");
    expect(html).toContain(
      'data-slot="activity-goal-progress" data-progress-key="stepsPerMonth"',
    );
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
