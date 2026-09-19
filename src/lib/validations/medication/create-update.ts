import { z } from "zod/v4";

import {
  MEDICATION_CATEGORY_VALUES,
  MEDICATION_DELIVERY_FORM_VALUES,
  MEDICATION_TREATMENT_CLASS_VALUES,
  UNITS_PER_DOSE_MESSAGE,
  atcCodeField,
  injectionSiteEnum,
  isSupportedUnitsPerDose,
  INJECTION_SITE_VALUES,
  rxNormCodeField,
} from "./base";
import { scheduleSchema } from "./schedule";
import { assertStableExternalId } from "@/lib/validations/external-id";

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
  /**
   * v1.16.11 (#316) — as-needed (PRN) medication. No fixed schedule:
   * never due, never reminded, excluded from compliance, active
   * indefinitely. Intakes log ad-hoc and consume inventory. Carries
   * ZERO schedules — a `schedules` array alongside `asNeeded: true` is
   * a 422. Mutually exclusive with `oneShot`.
   */
  asNeeded: z
    .boolean()
    .optional()
    .describe(
      "As-needed (PRN) medication (pain relief, rescue inhaler). When true the medication carries NO schedules (supplying any schedule entry is a 422): it is never due, never reminded, and excluded from compliance rates/streaks, but intakes still log (ad-hoc), inventory still consumes, and the history renders. Stays active indefinitely. Mutually exclusive with `oneShot`.",
    ),
};

/**
 * v1.16.11 — shared as-needed cross-field refines for the create +
 * update bodies: `asNeeded` and `oneShot` are mutually exclusive, and
 * an as-needed medication cannot carry schedule entries.
 */
const AS_NEEDED_ONE_SHOT_MESSAGE =
  "asNeeded and oneShot are mutually exclusive";
const AS_NEEDED_SCHEDULES_MESSAGE =
  "An as-needed medication cannot carry schedules";

export const createMedicationSchema = z
  .object({
    name: z.string().min(1).max(100),
    dose: z.string().min(1).max(50),
    category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
    /** v1.4.25 W4d — treatment-class discriminator (GENERIC | GLP1). */
    treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
    /** v1.4.25 W4d — doses per pen/vial for inventory tracking.
     *  v1.16.10 raises the cap to 1000 (large tablet packs). */
    dosesPerUnit: z.number().int().min(1).max(1000).optional(),
    /**
     * v1.16.10 — inventory units one dose consumes (2 × 2 mg tablets
     * for a 4 mg dose). Default 1. Dose-level readouts divide the
     * unit counts by this factor.
     */
    unitsPerDose: z
      .number()
      .refine(isSupportedUnitsPerDose, { message: UNITS_PER_DOSE_MESSAGE })
      .optional()
      .describe(
        "Inventory units consumed per dose. A whole number 1–100 (e.g. 2 tablets of 2 mg for a 4 mg dose) or a supported fraction for a split pill (¼ / ⅓ / ½ / ⅔ / ¾). Default 1. The intake consumption hook decrements this many units per taken dose; dose-derived readouts divide unit counts by it.",
      ),
    /**
     * v1.17.0 — optional per-medication reorder lead time in days. The
     * low-stock alert widens its trigger by this lead plus one
     * dose-interval so a sparse cadence is warned before its last dose.
     * Omitted = inherit the user-level
     * `notificationPrefs.medication.reorderLeadDays` default.
     */
    reorderLeadDays: z
      .number()
      .int()
      .min(0)
      .max(60)
      .optional()
      .describe(
        "Per-medication reorder lead time in days (0–60). The low-stock alert fires the supply early enough to reorder before the last dose. Omitted = inherit the user-level reorderLeadDays default (10).",
      ),
    /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
    deliveryForm: z.enum(MEDICATION_DELIVERY_FORM_VALUES).optional(),
    /**
     * v1.8.5 — per-medication injection-site tracking opt-in. Default
     * false. Only meaningful when `deliveryForm === "INJECTION"`.
     */
    trackInjectionSites: z
      .boolean()
      .optional()
      .describe(
        "Per-medication injection-site tracking opt-in. Default false. Only meaningful for an INJECTION delivery form; when true the client prompts (skippably) for the site after a taken dose.",
      ),
    /**
     * v1.8.5 — per-medication allowed / preferred injection sites.
     * Empty = no per-medication restriction. The effective pickable set
     * subtracts the user's global exclusion (deny wins).
     */
    allowedInjectionSites: z
      .array(injectionSiteEnum)
      .max(INJECTION_SITE_VALUES.length)
      .optional()
      .describe(
        "Per-medication allowed / preferred injection sites. Empty array = no per-medication restriction (every site offered). The effective pickable set is this list minus the user's global exclusion.",
      ),
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
    /** v1.9.0 — optional WHO ATC classification code. */
    atcCode: atcCodeField,
    /** v1.9.0 — optional RxNorm RxCUI (secondary, US). */
    rxNormCode: rxNormCodeField,
    /**
     * v1.28 — mirrored-medication provenance. Only APPLE_HEALTH is
     * accepted here (the iOS 26+ HealthKit Medications sync); the other
     * IntakeSource values stay server-owned. Both-or-neither with
     * `externalId` (refine below).
     */
    externalSource: z
      .literal("APPLE_HEALTH")
      .optional()
      .describe(
        "Marks the medication as MIRRORED from an external medication list. Only `APPLE_HEALTH` (the iOS 26+ HealthKit Medications sync) is accepted. Must be supplied together with `externalId`. A mirrored medication is source-exclusive: dose events from that source attach only to it, and the app's own dose-logging UI stays off it.",
      ),
    /**
     * v1.28 — the source's stable concept identifier (HealthKit
     * `medicationConceptIdentifier`). Re-posting the same
     * `(externalSource, externalId)` pair returns the existing
     * medication (200) instead of creating a duplicate.
     */
    externalId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "Stable external identifier of the mirrored medication (the HealthKit `medicationConceptIdentifier`, max 128 chars). Must be supplied together with `externalSource`. Idempotent: re-posting the same pair returns the existing medication with status 200 instead of minting a duplicate. The value MUST be identical across app restarts: an object description or memory address (`<Class: 0x…>`, `0x12ab34cd`) is a new value on every launch, never matches its own earlier row, and is refused with 422 rather than minting a duplicate mirror.",
      ),
    ...courseWindowFields,
    /**
     * v1.16.11 — optional at the type level so an `asNeeded: true`
     * create can omit it; the refine below keeps the legacy
     * at-least-one-schedule contract for every scheduled medication.
     */
    schedules: z.array(scheduleSchema).optional(),
  })
  .refine(
    // v1.28 — mirrored-medication provenance is a pair: a source without
    // its concept id (or vice versa) can neither dedup nor mirror.
    (b) => (b.externalSource === undefined) === (b.externalId === undefined),
    {
      message: "externalSource and externalId must be supplied together",
      path: ["externalId"],
    },
  )
  // The concept id has to be STABLE across client launches or the
  // idempotent-mirror pre-query above never matches its own earlier row
  // and every sync sweep mints another phantom medication.
  .superRefine(assertStableExternalId)
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
  .refine((b) => !(b.asNeeded === true && b.oneShot === true), {
    message: AS_NEEDED_ONE_SHOT_MESSAGE,
    path: ["asNeeded"],
  })
  .refine(
    (b) =>
      b.externalSource === "APPLE_HEALTH" ||
      b.asNeeded === true ||
      (!!b.schedules && b.schedules.length >= 1),
    {
      message: "Mindestens ein Zeitfenster",
      path: ["schedules"],
    },
  )
  .refine(
    (b) => b.asNeeded !== true || !b.schedules || b.schedules.length === 0,
    {
      message: AS_NEEDED_SCHEDULES_MESSAGE,
      path: ["schedules"],
    },
  )
  .meta({
    id: "CreateMedicationRequest",
    description:
      'Create-medication body. The route enforces the v1.5 cross-field invariants on top of the per-schedule `rrule_xor_rolling` Zod refine: a `oneShot:true` medication may carry at most one schedule and that schedule must not declare a recurrence; `endsOn` is normalised to equal `startsOn` for one-shot doses; a recurring schedule with no `rrule`, `rollingIntervalDays`, or legacy `daysOfWeek` defaults to `rrule = "FREQ=DAILY"`; and `timesOfDay` is dual-written from `windowStart` when the caller omits it. v1.16.11 — `asNeeded: true` creates a PRN medication with ZERO schedules (`schedules` must be absent or empty, 422 otherwise); a scheduled medication still requires at least one schedule entry. v1.28 — `externalSource` + `externalId` (both-or-neither) mark the medication as mirrored from Apple Health; re-posting the same pair is idempotent and returns the existing medication with status 200.',
  });

export const updateMedicationSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    dose: z.string().min(1).max(50).optional(),
    category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
    treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
    dosesPerUnit: z.number().int().min(1).max(1000).nullable().optional(),
    /** v1.16.10 — inventory units one dose consumes. Default 1.
     *  v1.16.12 — whole number 1–100 or a curated fraction (½ / ⅓ / ¼ …). */
    unitsPerDose: z
      .number()
      .refine(isSupportedUnitsPerDose, { message: UNITS_PER_DOSE_MESSAGE })
      .optional()
      .describe(
        "Inventory units consumed per dose — a whole number 1–100 or a supported split-pill fraction (¼ / ⅓ / ½ / ⅔ / ¾). The intake consumption hook decrements this many units per taken dose; already-stamped intake events keep their recorded consumption.",
      ),
    /**
     * v1.17.0 — per-medication reorder lead time in days (0–60). `null`
     * clears the override and reverts to the user-level default.
     */
    reorderLeadDays: z
      .number()
      .int()
      .min(0)
      .max(60)
      .nullable()
      .optional()
      .describe(
        "Per-medication reorder lead time in days (0–60). null clears the override and reverts to the user-level reorderLeadDays default.",
      ),
    /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
    deliveryForm: z.enum(MEDICATION_DELIVERY_FORM_VALUES).optional(),
    /** v1.8.5 — per-medication injection-site tracking opt-in. */
    trackInjectionSites: z
      .boolean()
      .optional()
      .describe(
        "Per-medication injection-site tracking opt-in. Only meaningful for an INJECTION delivery form. Set false to deactivate tracking.",
      ),
    /** v1.8.5 — per-medication allowed / preferred injection sites. */
    allowedInjectionSites: z
      .array(injectionSiteEnum)
      .max(INJECTION_SITE_VALUES.length)
      .optional()
      .describe(
        "Per-medication allowed / preferred injection sites. Empty array clears the restriction. The effective pickable set subtracts the user's global exclusion (deny wins).",
      ),
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
    /** v1.9.0 — optional WHO ATC classification code. */
    atcCode: atcCodeField,
    /** v1.9.0 — optional RxNorm RxCUI (secondary, US). */
    rxNormCode: rxNormCodeField,
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
  .refine((b) => !(b.asNeeded === true && b.oneShot === true), {
    message: AS_NEEDED_ONE_SHOT_MESSAGE,
    path: ["asNeeded"],
  })
  .refine(
    (b) => b.asNeeded !== true || !b.schedules || b.schedules.length === 0,
    {
      message: AS_NEEDED_SCHEDULES_MESSAGE,
      path: ["schedules"],
    },
  )
  .refine(
    // An empty replace-list is only legal on the as-needed path — for a
    // scheduled medication it would wipe every schedule and strand the
    // row in a state no surface can reason about.
    (b) => b.asNeeded === true || !b.schedules || b.schedules.length >= 1,
    {
      message: "Mindestens ein Zeitfenster",
      path: ["schedules"],
    },
  )
  .meta({
    id: "UpdateMedicationRequest",
    description:
      "Update-medication body. Every field is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false records the current timestamp on `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match the create path. v1.16.11 — `asNeeded: true` requires the medication to end schedule-less: supply `schedules: []` to clear an existing plan (any schedule entry is a 422); an empty `schedules` array without `asNeeded: true` is likewise a 422.",
  });

export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;
