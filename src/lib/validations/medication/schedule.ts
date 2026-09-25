import { z } from "zod/v4";

import { SCHEDULE_TYPES } from "@/lib/medications/scheduling/recurrence";
import { RRULE_PROPS, doseWindowEntrySchema, timeRegex } from "./base";
import {
  UNITS_PER_DOSE_MESSAGE,
  isSupportedUnitsPerDose,
} from "@/lib/medications/units-per-dose";

export const scheduleSchema = z
  .object({
    windowStart: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe(
        "Legacy single-time-of-intake (HH:mm, user local). v1.5 keeps the field for backwards compatibility with pre-wizard iOS clients; the new `timesOfDay` array supersedes it.",
      ),
    windowEnd: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe(
        "Legacy reminder-window upper bound (HH:mm). Used to derive the late-classification grace span when `reminderGraceMinutes` is null.",
      ),
    label: z
      .string()
      .max(50)
      .optional()
      .describe('Optional human label (e.g. "Morning", "Evening").'),
    dose: z
      .string()
      .max(50)
      .optional()
      .describe(
        "Per-schedule dose override. NULL means the schedule inherits `Medication.dose`.",
      ),
    unitsPerDose: z
      .number()
      .refine(isSupportedUnitsPerDose, { message: UNITS_PER_DOSE_MESSAGE })
      .optional()
      .describe(
        "Per-schedule inventory units consumed per dose (#219). Above 0 and at most 100 with at most 4 decimal places (1, 0.5, 1.5). Omitted / NULL means the schedule inherits `Medication.unitsPerDose`. Lets one medication decrement a different tablet count at different times of day (a whole tablet in the morning, a half at noon).",
      ),
    daysOfWeek: z
      .array(z.number().int().min(0).max(6))
      .optional()
      .describe(
        "Legacy day-of-week filter (0=Sunday..6=Saturday). v1.5 reads new writes through `rrule` first; this field is preserved for pre-v1.5 rows and is the input the route serialises into the persisted `days_of_week` string.",
      ),
    intervalWeeks: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe(
        "Legacy multi-week stride (1..4). Bi-weekly + tri-weekly were broken in the pre-v1.5 reminder worker; new writes encode the same intent via `rrule` (e.g. `FREQ=WEEKLY;INTERVAL=2;BYDAY=WE`).",
      ),
    /**
     * v1.5 — first-class times-of-day. One or more HH:mm entries in
     * the user's wall-clock; the engine applies them per matched day.
     * Empty array falls back to `[windowStart]` for backwards-compat.
     */
    timesOfDay: z
      .array(z.string().regex(timeRegex, "Format: HH:mm"))
      .max(8)
      .optional()
      .describe(
        "v1.5 first-class points-in-time the dose is taken (HH:mm, user local). Up to 8 entries. Absent or empty means the route stamps `[windowStart]` so the new engine always sees a populated array.",
      ),
    /**
     * v1.5 — reminder grace window (minutes). Replaces the implicit
     * `windowEnd - windowStart` span for late-classification. NULL
     * falls back to the legacy span. Capped at 24 hours.
     */
    reminderGraceMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional()
      .describe(
        "Reminder grace window in minutes. Caps at 24h. NULL falls back to the legacy `windowEnd - windowStart` span.",
      ),
    /**
     * v1.5 — RFC 5545 RRULE string for calendar-anchored cadences.
     * Mutually exclusive with `rollingIntervalDays`.
     */
    rrule: z
      .string()
      .max(200)
      .regex(RRULE_PROPS, "Invalid RRULE")
      .optional()
      .describe(
        "RFC 5545 RRULE string (subset). Use for daily / weekly-with-BYDAY / multi-week / monthly / yearly cadences. Mutually exclusive with `rollingIntervalDays`. Examples: `FREQ=DAILY`, `FREQ=WEEKLY;BYDAY=MO,WE,FR`, `FREQ=WEEKLY;INTERVAL=2;BYDAY=WE`, `FREQ=MONTHLY;BYMONTHDAY=1`, `FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1`.",
      ),
    /**
     * v1.5 — flexible-rolling interval in days, counted from the
     * latest MedicationIntakeEvent.takenAt. Mutually exclusive with
     * `rrule`. Range 1..365 days.
     */
    rollingIntervalDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(
        "Flexible-rolling interval in days, counted forward from the latest `MedicationIntakeEvent.takenAt` (the dose re-anchors when logged). Mutually exclusive with `rrule`. Range 1..365.",
      ),
    /**
     * v1.7.0 — schedule-type discriminator. SCHEDULED (default) keeps the
     * rrule / rolling / legacy cadence. PRN is as-needed (never projected,
     * reminded, or counted in compliance expected; still loggable).
     * CYCLIC wraps the inner cadence with an N-on / M-off week phase.
     */
    scheduleType: z
      .enum(SCHEDULE_TYPES)
      .optional()
      .describe(
        "Schedule type. SCHEDULED (default) = rrule / rolling / legacy cadence. PRN = as-needed (never projected, reminded, or counted in compliance expected; still loggable via the intake route). CYCLIC = N weeks on / M weeks off, gating whichever inner cadence the rrule / legacy fields describe.",
      ),
    /** v1.7.0 — cyclic "on" weeks. Required when `scheduleType === "CYCLIC"`. */
    cyclicOnWeeks: z
      .number()
      .int()
      .min(1)
      .max(52)
      .optional()
      .describe(
        'Cyclic "on" weeks (1..52). Required when `scheduleType` is CYCLIC; ignored otherwise.',
      ),
    /** v1.7.0 — cyclic "off" weeks. Required when `scheduleType === "CYCLIC"`. */
    cyclicOffWeeks: z
      .number()
      .int()
      .min(0)
      .max(52)
      .optional()
      .describe(
        'Cyclic "off" weeks (0..52). Required when `scheduleType` is CYCLIC; ignored otherwise.',
      ),
    /**
     * v1.15.18 — per-dose configurable on-time intake window (the maintainer's
     * "07:00–09:00" lever). One entry per dose time the user wants an explicit
     * range for; a `timeOfDay` with no entry keeps the symmetric ±1h default.
     * Each `timeOfDay` MUST match one of the schedule's `timesOfDay` (or the
     * legacy `windowStart`), and `start <= end` within the day. Absent → every
     * slot uses the default derivation (unchanged behaviour).
     */
    doseWindows: z
      .array(doseWindowEntrySchema)
      .max(8)
      .optional()
      .describe(
        "Per-dose on-time intake windows. Each `{ timeOfDay, start, end }` HH:mm triple sets the explicit on-time band for the matching dose time; a dose time with no entry keeps the symmetric ±1h default. `timeOfDay` must match one of `timesOfDay` (or `windowStart`); `start <= end`. Up to 8 entries. Absent leaves every slot on the default derivation. The late tail stays cadence-derived.",
      ),
  })
  .refine((s) => !(s.rrule && s.rollingIntervalDays), {
    message: "A schedule can be calendar-anchored (rrule) or rolling, not both",
    path: ["rrule"],
  })
  .refine(
    (s) =>
      s.scheduleType !== "CYCLIC" ||
      (s.cyclicOnWeeks !== undefined && s.cyclicOffWeeks !== undefined),
    {
      message: "cyclic schedules require both cyclicOnWeeks and cyclicOffWeeks",
      path: ["cyclicOnWeeks"],
    },
  )
  .refine(
    (s) =>
      s.scheduleType !== "PRN" ||
      (s.rrule === undefined && s.rollingIntervalDays === undefined),
    {
      message:
        "PRN schedules cannot carry a cadence (rrule or rollingIntervalDays)",
      path: ["scheduleType"],
    },
  )
  .refine(
    (s) =>
      s.rollingIntervalDays === undefined ||
      s.rollingIntervalDays === null ||
      !s.timesOfDay ||
      s.timesOfDay.length <= 1,
    {
      message: "rolling-cadence schedules accept at most one time of day",
      path: ["timesOfDay"],
    },
  )
  .refine(
    (s) => {
      // Every per-dose window must name a real dose time. The effective dose
      // times are `timesOfDay` when set, else the single legacy `windowStart`
      // (mirrors the engine's `effectiveTimesOfDay`).
      if (!s.doseWindows || s.doseWindows.length === 0) return true;
      const times = new Set(
        s.timesOfDay && s.timesOfDay.length > 0
          ? s.timesOfDay
          : [s.windowStart],
      );
      return s.doseWindows.every((w) => times.has(w.timeOfDay));
    },
    {
      message:
        "Each doseWindows.timeOfDay must match one of the schedule's timesOfDay",
      path: ["doseWindows"],
    },
  )
  .refine(
    (s) => {
      // A dose time may carry at most one explicit window.
      if (!s.doseWindows || s.doseWindows.length === 0) return true;
      const seen = new Set<string>();
      for (const w of s.doseWindows) {
        if (seen.has(w.timeOfDay)) return false;
        seen.add(w.timeOfDay);
      }
      return true;
    },
    {
      message: "doseWindows must not repeat a timeOfDay",
      path: ["doseWindows"],
    },
  )
  .meta({
    id: "MedicationScheduleInput",
    description:
      "Single schedule entry on a medication. v1.5 introduces `timesOfDay`, `rrule`, `rollingIntervalDays`, and `reminderGraceMinutes` as first-class fields; `windowStart`, `windowEnd`, `daysOfWeek`, and `intervalWeeks` are preserved through the v1.5.x line for backwards compatibility. **`rrule` and `rollingIntervalDays` are mutually exclusive** — supplying both fails 422 (`rrule_xor_rolling`). The DB enforces the same invariant via a CHECK constraint.",
  });
