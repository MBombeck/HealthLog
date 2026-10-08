"use client";

import { DAY_TOOL_NAME } from "@/lib/day/contract";
import type { CoachStep } from "@/lib/ai/coach/types";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { isCalendarDateKey } from "@/lib/tz/date-only";

import { DayLink } from "./day-link";

/**
 * The days a Coach answer read, as chips under it: "Days in this answer".
 *
 * Taken from the turn's tool calls, never from the answer's words. A date
 * the model writes can be wrong or ambiguous; the day a `get_day` call read
 * is exactly the day the answer stands on. A step that failed read nothing
 * and gives no chip.
 */
export function daysFromCoachSteps(steps: readonly CoachStep[]): string[] {
  const days = new Set<string>();
  for (const step of steps) {
    if ((step.tool as string) !== DAY_TOOL_NAME) continue;
    if (step.status !== "done" && step.status !== "empty") continue;
    if (step.day && isCalendarDateKey(step.day)) days.add(step.day);
  }
  return [...days].sort();
}

export function CoachDayChips({ steps }: { steps: readonly CoachStep[] }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const days = daysFromCoachSteps(steps);
  if (days.length === 0) return null;
  return (
    <div
      data-slot="coach-day-chips"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
    >
      <span className="text-muted-foreground text-xs">
        {t("day.coachChips")}
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {days.map((day) => (
          <li key={day}>
            <DayLink
              date={day}
              size="xs"
              className="border-border hover:bg-muted inline-flex min-h-7 items-center rounded-full border px-2.5 no-underline"
            >
              {fmt.dateShortSmartCalendar(day)}
            </DayLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
