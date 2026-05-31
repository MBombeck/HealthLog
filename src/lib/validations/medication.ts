import { z } from "zod/v4";

import { SCHEDULE_TYPES } from "@/lib/medications/scheduling/recurrence";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
/**
 * Clinical-category values stored in the `medication_categories` side-
 * table (TEXT column). v1.5.4 adds `DIABETES` and `ANTIBIOTIC` so the
 * wizard's Step 2 taxonomy can write a first-class bucket for those
 * two rows instead of collapsing them into `OTHER`. The column is a
 * plain TEXT field — no Prisma enum exists to migrate; the Zod values
 * list is the only enforcement layer.
 */
export const MEDICATION_CATEGORY_VALUES = [
  "BLOOD_PRESSURE",
  "VITAMIN",
  "SUPPLEMENT",
  "PAIN_RELIEF",
  "ALLERGY",
  "DIGESTIVE",
  "THYROID",
  "HORMONE",
  "SKIN",
  "SLEEP_AID",
  "DIABETES",
  "ANTIBIOTIC",
  "OTHER",
] as const;
export type MedicationCategoryValue = (typeof MEDICATION_CATEGORY_VALUES)[number];

/**
 * v1.4.25 W4d — Prisma-level treatment class. Orthogonal to
 * `MEDICATION_CATEGORY_VALUES` (the clinical taxonomy that lives in the
 * `medication_categories` side-table). GLP1 turns on the GLP-1
 * specialist surfaces — injection-site picker, titration history, pen
 * inventory, GLP-1-aware Coach replies. Future treatment classes drop
 * into this list (INSULIN, BIOLOGIC, FERTILITY, …).
 */
export const MEDICATION_TREATMENT_CLASS_VALUES = ["GENERIC", "GLP1"] as const;
export type MedicationTreatmentClass =
  (typeof MEDICATION_TREATMENT_CLASS_VALUES)[number];

/**
 * v1.6.0 — route of administration. Decoupled from `treatmentClass`:
 * the injection-site picker surfaces for any `INJECTION` dose, and a
 * one-time injection is `oneShot: true` + `deliveryForm: "INJECTION"`.
 * ORAL is the default the migration backfilled onto every existing row.
 */
export const MEDICATION_DELIVERY_FORM_VALUES = [
  "ORAL",
  "INJECTION",
  "OTHER",
] as const;
export type MedicationDeliveryForm =
  (typeof MEDICATION_DELIVERY_FORM_VALUES)[number];

/**
 * v1.5 — RRULE string shape check.
 *
 * Not a full RFC 5545 parser (that lives in the `rrule` npm package on
 * the server side). The regex catches the subset HealthLog mints from
 * the wizard / form: a `FREQ=` line with optional `INTERVAL=`,
 * `BYDAY=`, `BYMONTHDAY=`, `BYMONTH=`, `COUNT=`, `UNTIL=` properties
 * separated by `;`. Any pathological-looking shape (the `FREQ=SECONDLY`
 * DoS surface, `;COUNT=999999999`) is filtered at the server route
 * layer with a hard cap on emitted occurrences.
 */
const RRULE_PROPS =
  /^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;(?:INTERVAL=\d{1,3}|BYDAY=(?:MO|TU|WE|TH|FR|SA|SU)(?:,(?:MO|TU|WE|TH|FR|SA|SU))*|BYMONTHDAY=-?\d{1,2}(?:,-?\d{1,2})*|BYMONTH=\d{1,2}(?:,\d{1,2})*|COUNT=\d{1,4}|UNTIL=\d{8}T\d{6}Z))*$/;

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
      .describe("Optional human label (e.g. \"Morning\", \"Evening\")."),
    dose: z
      .string()
      .max(50)
      .optional()
      .describe(
        "Per-schedule dose override. NULL means the schedule inherits `Medication.dose`.",
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
        "Cyclic \"on\" weeks (1..52). Required when `scheduleType` is CYCLIC; ignored otherwise.",
      ),
    /** v1.7.0 — cyclic "off" weeks. Required when `scheduleType === "CYCLIC"`. */
    cyclicOffWeeks: z
      .number()
      .int()
      .min(0)
      .max(52)
      .optional()
      .describe(
        "Cyclic \"off\" weeks (0..52). Required when `scheduleType` is CYCLIC; ignored otherwise.",
      ),
  })
  .refine(
    (s) => !(s.rrule && s.rollingIntervalDays),
    {
      message:
        "A schedule can be calendar-anchored (rrule) or rolling, not both",
      path: ["rrule"],
    },
  )
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
  .meta({
    id: "MedicationScheduleInput",
    description:
      "Single schedule entry on a medication. v1.5 introduces `timesOfDay`, `rrule`, `rollingIntervalDays`, and `reminderGraceMinutes` as first-class fields; `windowStart`, `windowEnd`, `daysOfWeek`, and `intervalWeeks` are preserved through the v1.5.x line for backwards compatibility. **`rrule` and `rollingIntervalDays` are mutually exclusive** — supplying both fails 422 (`rrule_xor_rolling`). The DB enforces the same invariant via a CHECK constraint.",
  });

/**
 * v1.5 — medication-level course window + one-shot flag. The fields
 * are optional on the create path so the existing form (no wizard
 * yet) keeps working. The route layer enforces the `oneShot` + at-
 * least-one-schedule invariant for the wizard path.
 */
const courseWindowFields = {
  /**
   * Date the medication course begins. ISO YYYY-MM-DD. NULL = "from
   * creation" (the legacy implicit anchor).
   */
  startsOn: z.iso
    .date()
    .transform((s) => new Date(s))
    .nullable()
    .optional()
    .describe(
      "Date the medication course begins (ISO `YYYY-MM-DD`). Anchors RRULE BYDAY / BYMONTHDAY patterns and the rolling-interval countdown's first window. NULL = active from creation (the legacy implicit behaviour). Required when `oneShot` is true.",
    ),
  /**
   * Date the medication course ends. ISO YYYY-MM-DD. NULL = chronic.
   * Required to equal `startsOn` when `oneShot` is true (the route
   * normalises this; the schema doesn't because they're sister
   * fields and the cross-field refine is enforced at the route).
   */
  endsOn: z.iso
    .date()
    .transform((s) => new Date(s))
    .nullable()
    .optional()
    .describe(
      "Date the medication course ends (ISO `YYYY-MM-DD`). NULL = no end date (chronic). When `oneShot` is true the route normalises `endsOn` to equal `startsOn`.",
    ),
  /**
   * Single-administration medication. Auto-deactivates after the
   * single intake is logged.
   */
  oneShot: z
    .boolean()
    .optional()
    .describe(
      "Single-administration medication (e.g. flu shot, post-op single dose). When true the medication has at most one schedule with no `rrule` / `rollingIntervalDays`, and `active` auto-flips to false once the dose is logged (non-skipped).",
    ),
};

export const createMedicationSchema = z
  .object({
    name: z.string().min(1).max(100),
    dose: z.string().min(1).max(50),
    category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
    /** v1.4.25 W4d — treatment-class discriminator (GENERIC | GLP1). */
    treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
    /** v1.4.25 W4d — doses per pen/vial for inventory tracking. */
    dosesPerUnit: z.number().int().min(1).max(100).optional(),
    /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
    deliveryForm: z.enum(MEDICATION_DELIVERY_FORM_VALUES).optional(),
    notificationsEnabled: z.boolean().optional(),
    /** v1.7.0 — iOS Live Activity opt-in for this medication's reminders. */
    liveActivityEnabled: z
      .boolean()
      .optional()
      .describe(
        "iOS Live Activity opt-in for this medication's reminders. Default false. The iOS client owns the ActivityKit lifecycle; the server only stores + echoes the flag.",
      ),
    /** v1.7.0 — iOS 26 AlarmKit critical-reminder opt-in. */
    criticalAlarmEnabled: z
      .boolean()
      .optional()
      .describe(
        "iOS 26 AlarmKit critical-reminder opt-in. Default false. Critical alarms bypass the device mute switch / Focus; the server stores the preference only and hangs no server-side behaviour off it.",
      ),
    ...courseWindowFields,
    schedules: z.array(scheduleSchema).min(1, "Mindestens ein Zeitfenster"),
  })
  .refine((b) => b.oneShot !== true || !!b.startsOn, {
    message: "startsOn is required when oneShot is true",
    path: ["startsOn"],
  })
  .refine(
    (b) =>
      !b.startsOn || !b.endsOn || b.endsOn.getTime() >= b.startsOn.getTime(),
    {
      message: "endsOn must be on or after startsOn",
      path: ["endsOn"],
    },
  )
  .meta({
    id: "CreateMedicationRequest",
    description:
      "Create-medication body. The route enforces the v1.5 cross-field invariants on top of the per-schedule `rrule_xor_rolling` Zod refine: a `oneShot:true` medication may carry at most one schedule and that schedule must not declare a recurrence; `endsOn` is normalised to equal `startsOn` for one-shot doses; a recurring schedule with no `rrule`, `rollingIntervalDays`, or legacy `daysOfWeek` defaults to `rrule = \"FREQ=DAILY\"`; and `timesOfDay` is dual-written from `windowStart` when the caller omits it.",
  });

export const updateMedicationSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    dose: z.string().min(1).max(50).optional(),
    category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
    treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
    dosesPerUnit: z.number().int().min(1).max(100).nullable().optional(),
    /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
    deliveryForm: z.enum(MEDICATION_DELIVERY_FORM_VALUES).optional(),
    active: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    /** v1.7.0 — iOS Live Activity opt-in for this medication's reminders. */
    liveActivityEnabled: z
      .boolean()
      .optional()
      .describe(
        "iOS Live Activity opt-in for this medication's reminders. The iOS client owns the ActivityKit lifecycle; the server only stores + echoes the flag.",
      ),
    /** v1.7.0 — iOS 26 AlarmKit critical-reminder opt-in. */
    criticalAlarmEnabled: z
      .boolean()
      .optional()
      .describe(
        "iOS 26 AlarmKit critical-reminder opt-in. Critical alarms bypass the device mute switch / Focus; the server stores the preference only.",
      ),
    ...courseWindowFields,
    schedules: z.array(scheduleSchema).optional(),
    /**
     * v1.5.5 — top-level primary-schedule grace bridge. The detail
     * page settings section saves the reminder-window in minutes for
     * the medication's primary schedule without re-sending the full
     * `schedules` array. The route normalises this value onto the
     * primary schedule's `reminderGraceMinutes` before the Prisma
     * update so the persisted shape stays per-schedule. NULL clears
     * the override and falls back to the legacy `windowEnd -
     * windowStart` span.
     */
    reminderGraceMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable()
      .optional()
      .describe(
        "Detail-page bridge: primary-schedule reminder-window in minutes. The route maps the value onto the primary schedule's `reminderGraceMinutes` field; ignored when a full `schedules` array is also supplied.",
      ),
  })
  .refine((b) => b.oneShot !== true || !!b.startsOn, {
    message: "startsOn is required when oneShot is true",
    path: ["startsOn"],
  })
  .refine(
    (b) =>
      !b.startsOn || !b.endsOn || b.endsOn.getTime() >= b.startsOn.getTime(),
    {
      message: "endsOn must be on or after startsOn",
      path: ["endsOn"],
    },
  )
  .meta({
    id: "UpdateMedicationRequest",
    description:
      "Update-medication body. Every field is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false records the current timestamp on `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match the create path.",
  });

export const intakeSchema = z
  .object({
    medicationId: z
      .string()
      .min(1)
      .describe(
        "Server-narrowed from the URL path. The route layer overwrites whatever the body supplies before Zod parsing so a caller cannot log an intake against another medication.",
      ),
    scheduledFor: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "Slot the dose belongs to. Defaults to `takenAt` (or `now()` when both are absent) so the compliance pairing logic can pin the dose to a schedule slot.",
      ),
    takenAt: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "When the dose was actually taken. NULL when `skipped` is true; defaults to `now()` for non-skipped intakes.",
      ),
    skipped: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "True to log a skipped slot (no consumption, no inventory decrement, one-shot medications stay active).",
      ),
    idempotencyKey: z
      .string()
      .max(128)
      .optional()
      .describe(
        "Caller-issued de-dup key. A second POST with the same key returns the original event without creating a new row.",
      ),
  })
  .meta({
    id: "MedicationIntakeRequest",
    description:
      "Per-medication intake log body. Idempotent via `idempotencyKey`; the server also dedupes by a 60-second sliding window when the key is absent. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for one-shot medications — flip `active` to false.",
  });

export const externalIntakeSchema = z.object({
  medicationName: z.string().min(1).max(200),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  idempotencyKey: z.string().max(128),
});

export const listIntakeEventsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z
    .enum(["scheduledFor", "takenAt", "source", "createdAt"])
    .optional()
    .default("scheduledFor"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  /**
   * v1.4.37 W3 — server-side status filter so the medication detail
   * page (IntakeHistoryListV2) can hide unconfirmed / planned rows.
   *
   *  - "all" (default): every event, preserves the byte-stable contract
   *    the iOS Swift client and existing dashboard consumers depend on.
   *  - "taken": only rows where the dose was confirmed taken
   *    (`takenAt IS NOT NULL AND skipped = false`).
   *  - "skipped": only rows the user explicitly skipped (`skipped = true`).
   *  - "completed": taken OR skipped — anything the user actually
   *    actioned. Excludes the ambiguous "missed / never confirmed"
   *    rows (`takenAt IS NULL AND skipped = false`) that the v1 list
   *    rendered as "verpasst" before the v1 component retired.
   */
  status: z
    .enum(["all", "taken", "skipped", "completed"])
    .optional()
    .default("all"),
});

export const updateIntakeEventSchema = z.object({
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .nullable()
    .optional(),
  skipped: z.boolean().optional(),
  scheduledFor: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
});

/**
 * v1.5.5 — bulk-delete request body. The detail-page intake-history
 * preview surfaces a multi-select that posts the resulting eventIds
 * here. The cap matches `listIntakeEventsSchema.limit` (500) so the
 * client never selects more rows than the table can return at once.
 * Server-side guarantees scoped-by-medication ownership via
 * `assertMedicationOwnership` + a `userId` predicate on the
 * `deleteMany`.
 */
export const bulkDeleteIntakeEventsSchema = z.object({
  eventIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

export type BulkDeleteIntakeEventsInput = z.infer<
  typeof bulkDeleteIntakeEventsSchema
>;

/**
 * v1.4.25 W19b — inventory (pen / vial) CRUD validators.
 *
 * The Prisma model carries a 4-state enum
 * (ACTIVE | IN_USE | EXPIRED | USED_UP); the API surface only lets
 * the user explicitly transition into IN_USE (mark-as-first-use) or
 * USED_UP (manual override). EXPIRED is owned by the daily cron and
 * the intake hook, so the PATCH schema deliberately omits it.
 */
export const createInventoryItemSchema = z.object({
  dosesTotal: z.number().int().min(1).max(100),
  printedExpiry: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .nullable()
    .optional(),
  purchasedAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .nullable()
    .optional(),
  notes: z.string().max(200).nullable().optional(),
});

export const updateInventoryItemSchema = z.object({
  markAsFirstUseAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  markAsUsedUp: z.boolean().optional(),
  printedExpiry: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .nullable()
    .optional(),
  notes: z.string().max(200).nullable().optional(),
});

export type CreateInventoryItemInput = z.infer<
  typeof createInventoryItemSchema
>;
export type UpdateInventoryItemInput = z.infer<
  typeof updateInventoryItemSchema
>;

/**
 * v1.4.25 W21 Fix-K — `POST /api/medications/[id]/glp1` body validators.
 *
 * The convenience route accepts either a `doseChange` or an `inventory`
 * payload (the route picks one). Both branches were hand-rolled
 * `typeof === "number"` checks pre-Fix-K, which let `NaN`, `Infinity`,
 * negative doses, and unbounded notes slip through.
 *
 * Bounds:
 * - `doseValue` is finite, non-negative, capped at 100 mg (covers every
 *   real-world GLP-1 step with headroom).
 * - `doseUnit` is a short string (mg / mcg / IE).
 * - `note` is capped at 500 characters so the field can't be used as a
 *   blob smuggler.
 * - `effectiveFrom` is constrained to a ±5-year window around now —
 *   a paper-record back-fill or a planned future step both fit, but
 *   "1970" / "9999" do not.
 * - `delta` is a non-zero finite integer in [−100, 100] (the existing
 *   inventory route caps `dosesTotal` at 100 doses per pen).
 * - `reason` is a bounded string (the route logs it; raw blob bad).
 */
const MAX_DOSE_MG = 100;
const MAX_NOTE_CHARS = 500;
const MAX_REASON_CHARS = 200;
const MIN_EFFECTIVE_FROM = new Date("2020-01-01T00:00:00Z");
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export const glp1DoseChangePostSchema = z.object({
  effectiveFrom: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .refine((d) => d.getTime() >= MIN_EFFECTIVE_FROM.getTime(), {
      message: "effectiveFrom must be on or after 2020-01-01",
    })
    .refine((d) => d.getTime() <= Date.now() + FIVE_YEARS_MS, {
      message: "effectiveFrom must be within 5 years of now",
    }),
  doseValue: z.number().finite().min(0).max(MAX_DOSE_MG),
  doseUnit: z.string().min(1).max(10),
  note: z.string().max(MAX_NOTE_CHARS).nullable().optional(),
});

export const glp1InventoryPostSchema = z.object({
  delta: z
    .number()
    .int()
    .finite()
    .min(-100)
    .max(100)
    .refine((n) => n !== 0, { message: "delta must be non-zero" }),
  reason: z.string().min(1).max(MAX_REASON_CHARS),
});

export const glp1PostBodySchema = z
  .object({
    doseChange: glp1DoseChangePostSchema.optional(),
    inventory: glp1InventoryPostSchema.optional(),
  })
  .refine((b) => Boolean(b.doseChange) !== Boolean(b.inventory), {
    message: "Body must carry exactly one of doseChange or inventory",
  });

export type Glp1DoseChangePostInput = z.infer<typeof glp1DoseChangePostSchema>;
export type Glp1InventoryPostInput = z.infer<typeof glp1InventoryPostSchema>;
export type Glp1PostBodyInput = z.infer<typeof glp1PostBodySchema>;

export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;
export type IntakeInput = z.infer<typeof intakeSchema>;
export type ListIntakeEventsInput = z.infer<typeof listIntakeEventsSchema>;
export type UpdateIntakeEventInput = z.infer<typeof updateIntakeEventSchema>;
