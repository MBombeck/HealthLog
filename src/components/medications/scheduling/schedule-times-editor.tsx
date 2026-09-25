"use client";

/**
 * v1.15.18 — Zeitplan tab inline schedule editor.
 *
 * The everyday levers on an EXISTING schedule — the dose times-of-day and
 * each dose's on-time window (via `<DoseWindowEditor>`) — without
 * re-walking the wizard. Frequency / cadence-kind stays a structural
 * concern: the tab links out to "Vollständig bearbeiten" for that.
 *
 * Self-saves via `PUT /api/medications/[id]` with the FULL `schedules`
 * array (the route replaces schedules wholesale, so every cadence field
 * is preserved verbatim from the snapshot and only the times + windows
 * change). Reminder grace is a READ-ONLY echo here — its owner is the
 * Erinnerung card directly below on the same tab.
 *
 * Calm, inset-grouped, AA. No card tint.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { TimesOfDayChips } from "@/components/medications/scheduling/times-of-day-chips";
import { DoseWindowEditor } from "@/components/medications/scheduling/dose-window-editor";
import {
  type DoseWindowEntry,
  type DoseWindowScale,
} from "@/components/medications/scheduling/dose-window";
import { useTranslations } from "@/lib/i18n/context";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { apiPut } from "@/lib/api/api-fetch";

/** The schedule fields the inline editor reads + round-trips on save. */
export interface EditableSchedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  reminderGraceMinutes?: number | null;
  scheduleType?: string | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
  doseWindows?: DoseWindowEntry[] | null;
}

/** Per-schedule working state (times + windows are the only mutable parts). */
interface ScheduleEdit {
  timesOfDay: string[];
  doseWindows: DoseWindowEntry[];
}

/**
 * Classify the cadence scale for the late-tail hint. A weekly / monthly
 * RRULE or any rolling interval is day-scale (the 4-day late rule); a
 * daily / multi-daily med is intraday (the ±1h / +3h minute bands).
 */
function scaleForSchedule(s: EditableSchedule): DoseWindowScale {
  if (typeof s.rollingIntervalDays === "number" && s.rollingIntervalDays >= 2) {
    return "dayScale";
  }
  const rrule = s.rrule ?? "";
  if (/FREQ=(WEEKLY|MONTHLY|YEARLY)/.test(rrule)) return "dayScale";
  return "intraday";
}

/** Effective dose times for a schedule (timesOfDay, else legacy windowStart). */
function effectiveTimes(s: EditableSchedule): string[] {
  return s.timesOfDay && s.timesOfDay.length > 0
    ? s.timesOfDay
    : [s.windowStart];
}

export function ScheduleTimesEditor({
  medicationId,
  schedules,
  trackIntake,
}: {
  medicationId: string;
  schedules: EditableSchedule[];
  /**
   * v1.39.1 (#1033) — the medication's intake-tracking state, echoed on the
   * save. The server keeps the stored schedule of a record-only medication
   * unless the write names `trackIntake`, because a client that does not
   * know the field cannot have seen that schedule.
   */
  trackIntake?: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const initial = useMemo<ScheduleEdit[]>(
    () =>
      schedules.map((s) => ({
        timesOfDay: effectiveTimes(s),
        doseWindows: s.doseWindows ?? [],
      })),
    [schedules],
  );

  const [edits, setEdits] = useState<ScheduleEdit[]>(initial);
  const [busy, setBusy] = useState(false);

  function patchSchedule(index: number, patch: Partial<ScheduleEdit>) {
    setEdits((prev) =>
      prev.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    );
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      // Replace schedules wholesale — preserve every cadence field from
      // the snapshot field-by-field, change only the times + windows.
      const body = {
        ...(trackIntake !== undefined && { trackIntake }),
        schedules: schedules.map((s, i) => {
          const edit = edits[i];
          const times =
            edit.timesOfDay.length > 0 ? edit.timesOfDay : [s.windowStart];
          const recurrence = parseScheduleRecurrence(s.daysOfWeek);
          // Drop windows whose timeOfDay no longer names a live dose time
          // (so a removed time can't leave an orphaned window the server
          // would 422 on).
          const liveTimes = new Set(times);
          const windows = edit.doseWindows.filter((w) =>
            liveTimes.has(w.timeOfDay),
          );
          return {
            windowStart: s.windowStart,
            windowEnd: s.windowEnd,
            label: s.label ?? undefined,
            dose: s.dose ?? undefined,
            timesOfDay: times,
            daysOfWeek: recurrence.daysOfWeek,
            intervalWeeks: recurrence.intervalWeeks,
            ...(s.rrule ? { rrule: s.rrule } : {}),
            ...(typeof s.rollingIntervalDays === "number"
              ? { rollingIntervalDays: s.rollingIntervalDays }
              : {}),
            ...(typeof s.reminderGraceMinutes === "number"
              ? { reminderGraceMinutes: s.reminderGraceMinutes }
              : {}),
            ...(s.scheduleType
              ? {
                  scheduleType: s.scheduleType as
                    "SCHEDULED" | "PRN" | "CYCLIC",
                }
              : {}),
            ...(typeof s.cyclicOnWeeks === "number"
              ? { cyclicOnWeeks: s.cyclicOnWeeks }
              : {}),
            ...(typeof s.cyclicOffWeeks === "number"
              ? { cyclicOffWeeks: s.cyclicOffWeeks }
              : {}),
            doseWindows: windows,
          };
        }),
      };

      await apiPut(`/api/medications/${medicationId}`, body);
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.zeitplan.saved"));
    } catch {
      toast.error(t("medications.detail.zeitplan.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6" data-slot="schedule-times-editor">
      {schedules.map((s, i) => {
        const edit = edits[i];
        const scale = scaleForSchedule(s);
        const grace =
          typeof s.reminderGraceMinutes === "number"
            ? s.reminderGraceMinutes
            : null;
        return (
          <div
            key={s.id}
            className="space-y-4"
            data-slot="schedule-times-editor-schedule"
            data-schedule-id={s.id}
          >
            {schedules.length > 1 ? (
              <h4 className="text-foreground text-sm font-medium">
                {s.label ??
                  t("medications.detail.zeitplan.scheduleLabel", {
                    index: i + 1,
                  })}
              </h4>
            ) : null}

            <div className="space-y-2">
              <Label className="text-foreground text-sm font-medium">
                {t("medications.detail.zeitplan.timesTitle")}
              </Label>
              <p className="text-muted-foreground text-xs">
                {t("medications.detail.zeitplan.timesNote")}
              </p>
              <TimesOfDayChips
                value={edit.timesOfDay}
                onChange={(timesOfDay) => patchSchedule(i, { timesOfDay })}
                maxChips={typeof s.rollingIntervalDays === "number" ? 1 : 8}
              />
            </div>

            <DoseWindowEditor
              timesOfDay={edit.timesOfDay}
              value={edit.doseWindows}
              onChange={(doseWindows) => patchSchedule(i, { doseWindows })}
              scale={scale}
              disabled={busy}
              idPrefix={`dose-window-${s.id}`}
            />

            {grace !== null ? (
              <p
                className="text-muted-foreground text-xs"
                data-slot="zeitplan-grace-echo"
              >
                {t("medications.detail.zeitplan.graceEcho", {
                  minutes: grace,
                })}
              </p>
            ) : null}
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          {t("medications.detail.zeitplan.fullEditNote")}
        </p>
        <Button
          onClick={() => void save()}
          disabled={busy}
          aria-busy={busy || undefined}
          className="min-h-11 shrink-0 sm:min-h-9"
          data-slot="zeitplan-save"
        >
          {t("medications.detail.zeitplan.save")}
        </Button>
      </div>
    </div>
  );
}
