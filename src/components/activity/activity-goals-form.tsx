"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSaveActivityGoals } from "@/hooks/use-activity-calendar";
import {
  ACTIVITY_GOAL_BOUNDS,
  ACTIVITY_GOAL_KEYS,
  type ActivityGoalKey,
} from "@/lib/activity/goal-bounds";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { ActivityCalendarResponse } from "@/lib/validations/activity-calendar";

type Goals = Record<ActivityGoalKey, number | null>;
type Draft = Record<ActivityGoalKey, string>;
type GoalProgress = ActivityCalendarResponse["goalProgress"][number];

function toDraft(goals: Goals): Draft {
  return Object.fromEntries(
    ACTIVITY_GOAL_KEYS.map((k) => [
      k,
      goals[k] === null ? "" : String(goals[k]),
    ]),
  ) as Draft;
}

/** How many goals are set: the value of the "Ziele" row. */
export function countActivityGoals(goals: Goals): number {
  return ACTIVITY_GOAL_KEYS.filter((k) => goals[k] !== null).length;
}

/**
 * Parse one field. Blank clears the goal; anything else must be a whole
 * number inside the bounds the server enforces. Digits only, so a grouping
 * separator typed by habit ("10.000") is refused rather than misread.
 */
export function parseGoalField(
  key: ActivityGoalKey,
  raw: string,
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  const { min, max } = ACTIVITY_GOAL_BOUNDS[key];
  if (value < min || value > max) return { ok: false };
  return { ok: true, value };
}

/**
 * The activity goals, set or cleared: the "Ziele" editor on the second level
 * of "Seite anpassen". Every goal is optional; an empty field is no goal and
 * there is no suggested number. Beside each set goal stands how far the
 * current week or month has come, as the server reports it.
 *
 * The draft starts from `goals` when the form mounts; the caller mounts it
 * fresh each time the editor opens. The footer's save button submits it
 * through `formId`.
 */
export function ActivityGoalsForm({
  formId,
  goals,
  progress,
  onSaved,
}: {
  formId: string;
  goals: Goals;
  progress: readonly GoalProgress[];
  onSaved: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const save = useSaveActivityGoals();
  const [draft, setDraft] = useState<Draft>(() => toDraft(goals));
  const [invalid, setInvalid] = useState<ActivityGoalKey[]>([]);

  const submit = () => {
    const bad: ActivityGoalKey[] = [];
    const patch: Partial<Goals> = {};
    for (const key of ACTIVITY_GOAL_KEYS) {
      const parsed = parseGoalField(key, draft[key]);
      if (!parsed.ok) bad.push(key);
      else patch[key] = parsed.value;
    }
    setInvalid(bad);
    if (bad.length > 0) return;
    save.mutate(patch, { onSuccess: onSaved });
  };

  return (
    <form
      id={formId}
      className="grid gap-4"
      data-slot="activity-goals-form"
      aria-busy={save.isPending || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {ACTIVITY_GOAL_KEYS.map((key) => {
        const id = `activity-goal-${key}`;
        const { min, max } = ACTIVITY_GOAL_BOUNDS[key];
        const isInvalid = invalid.includes(key);
        const current = progress.find((g) => g.key === key);
        return (
          <div key={key} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor={id}>{t(`activityCalendar.goal.${key}`)}</Label>
              {current ? (
                <span
                  data-slot="activity-goal-progress"
                  data-progress-key={key}
                  className="text-muted-foreground text-xs tabular-nums"
                >
                  {t("activityCalendar.goalOf", {
                    value: fmt.integer(Math.round(current.value)),
                    target: fmt.integer(current.target),
                  })}
                </span>
              ) : null}
            </div>
            <Input
              id={id}
              data-goal-key={key}
              inputMode="numeric"
              autoComplete="off"
              value={draft[key]}
              aria-invalid={isInvalid || undefined}
              aria-describedby={isInvalid ? `${id}-error` : undefined}
              placeholder={t("activityCalendar.goalsSheet.none")}
              onChange={(e) =>
                setDraft((d) => ({ ...d, [key]: e.target.value }))
              }
            />
            {isInvalid ? (
              <p
                id={`${id}-error`}
                role="alert"
                className="text-destructive text-xs"
              >
                {t("activityCalendar.goalsSheet.invalid", {
                  min: fmt.integer(min),
                  max: fmt.integer(max),
                })}
              </p>
            ) : null}
          </div>
        );
      })}
      {save.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t("activityCalendar.goalsSheet.saveError")}
        </p>
      ) : null}
    </form>
  );
}
