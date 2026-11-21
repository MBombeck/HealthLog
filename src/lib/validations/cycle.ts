/**
 * Cycle-tracking request/response validation (v1.15.0).
 *
 * Source of truth for the `/api/cycle/*` wire contract (ios-contract §2).
 * The Zod schemas here are reused by the OpenAPI registry so the spec
 * stays single-source. `userId` is NEVER a body field — it is narrowed
 * from the session/Bearer in every route.
 *
 * Dates are `YYYY-MM-DD` strings (the MoodEntry tz-anchored convention);
 * instants are ISO-8601 with offset.
 */
import { z } from "zod/v4";
import { isPlausibleEntryInstant } from "@/lib/validations/entry-instant";
import { assertStableExternalId } from "@/lib/validations/external-id";
import { isoDateTime } from "@/lib/validations/datetime";
import {
  POSTPARTUM_WEEKS_MAX,
  POSTPARTUM_WEEKS_MIN,
} from "@/lib/cycle/pregnancy";

/**
 * v1.17 — `loggedAt` instant on the cycle wire stays a string (the iOS
 * contract reads it back verbatim), so the plausibility bound is applied as
 * a `.refine` over the parsed instant rather than the date-typed
 * `validateEntryInstant` wrapper. Same `isPlausibleEntryInstant` predicate
 * the measurement / mood / medication-intake paths use: no future instant
 * beyond the 5-min skew, no instant before 1900.
 */
const boundedLoggedAt = isoDateTime().refine(
  (s) => isPlausibleEntryInstant(new Date(s)),
  {
    message: "loggedAt must be a plausible instant (not future, not pre-1900)",
  },
);

/* ── enums (mirror the Prisma enums) ─────────────────────────────── */

export const flowLevelEnum = z.enum([
  "NONE",
  "SPOTTING",
  "LIGHT",
  "MEDIUM",
  "HEAVY",
]);

export const ovulationTestEnum = z.enum([
  "NEGATIVE",
  "POSITIVE_LH_SURGE",
  "ESTROGEN_SURGE",
  "INDETERMINATE",
]);

export const cervicalMucusEnum = z.enum([
  "DRY",
  "STICKY",
  "CREAMY",
  "WATERY",
  "EGG_WHITE",
]);

/** Symptothermal secondary-symptom choice (mirrors the Prisma enum). */
export const secondarySymptomEnum = z.enum(["MUCUS", "CERVIX"]);

/** The three Sensiplan cervix signs (mirror the Prisma enums). */
export const cervixPositionEnum = z.enum(["LOW", "HIGH"]);
export const cervixFirmnessEnum = z.enum(["FIRM", "SOFT"]);
export const cervixOpeningEnum = z.enum(["CLOSED", "OPEN"]);

export const homeTestResultEnum = z.enum([
  "NEGATIVE",
  "POSITIVE",
  "INDETERMINATE",
]);

export const contraceptiveKindEnum = z.enum([
  "NONE",
  "UNSPECIFIED",
  "IMPLANT",
  "INJECTION",
  "IUD",
  "INTRAVAGINAL_RING",
  "ORAL",
  "PATCH",
  "EMERGENCY",
]);

export const cycleTrackingGoalEnum = z.enum([
  "GENERAL_HEALTH",
  "AVOID_PREGNANCY",
  "TRYING_TO_CONCEIVE",
  "PERIMENOPAUSE",
  "OFF",
]);

/**
 * Day-log source. MANUAL (web / single POST) or APPLE_HEALTH (the
 * HealthKit batch ingest). Mirrors `MeasurementSource`; the wire spelling
 * is APPLE_HEALTH, not "HEALTHKIT".
 */
export const cycleSourceEnum = z.enum(["MANUAL", "APPLE_HEALTH"]);

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

/** The single-day read query: `GET /api/cycle/day-logs?date=YYYY-MM-DD`. */
export const cycleDayLogQuerySchema = z.object({ date: dateString });

/* ── day-log capture (single + bulk shared input) ────────────────── */

/**
 * The canonical day-log input. Shared by the single POST, the PATCH, and
 * the bulk drain. `note` is encrypted at rest (`notesEncrypted`); every
 * other field is queryable plaintext (feeds rollups / correlation).
 */
export const cycleDayLogInputSchema = z.object({
  date: dateString,
  flow: flowLevelEnum.optional(),
  intermenstrualBleeding: z.boolean().optional(),
  basalBodyTempC: z.number().min(30).max(45).optional(),
  // Marks the day's BBT as disturbed (fever / illness / late reading): the
  // symptothermal engine drops it from the cover line + shift evaluation.
  temperatureExcluded: z.boolean().optional(),
  ovulationTest: ovulationTestEnum.optional(),
  cervicalMucus: cervicalMucusEnum.optional(),
  // Cervix observation — the symptothermal secondary indicator when the
  // profile's secondarySymptom is CERVIX.
  cervixPosition: cervixPositionEnum.optional(),
  cervixFirmness: cervixFirmnessEnum.optional(),
  cervixOpening: cervixOpeningEnum.optional(),
  sexualActivity: z.boolean().optional(),
  protectedSex: z.boolean().nullable().optional(),
  pregnancyTest: homeTestResultEnum.optional(),
  progesteroneTest: homeTestResultEnum.optional(),
  contraceptive: contraceptiveKindEnum.optional(),
  symptoms: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        // NULL is the ordinary case, not an edge: picking a symptom without
        // tapping an intensity is how most entries are logged, and the link
        // row stores that as a plain presence. Rejecting it refused every
        // unrated symptom with a 422 the sheet could only show as
        // "Could not save".
        severity: z.number().int().min(1).max(4).nullable().optional(),
      }),
    )
    .max(40)
    .optional(),
  note: z.string().max(500).optional(),
  loggedAt: boundedLoggedAt,
  source: cycleSourceEnum.optional().default("MANUAL"),
  // Shared with the bulk ingest, which enforces external-id stability per
  // entry rather than at the field (a schema-level refusal would fail the
  // whole batch on one bad row). The single-entry POST parses through
  // `cycleDayLogCreateSchema` below, which adds the field check.
  // @external-id-checked-per-entry: src/app/api/cycle/day-logs/bulk/route.ts
  externalId: z.string().min(1).max(120).optional(),
});

export type CycleDayLogInput = z.infer<typeof cycleDayLogInputSchema>;

/**
 * Single-entry POST body. Same shape as the bulk entry plus the
 * external-id stability floor: a rotating id defeats the
 * `(userId, source, externalId)` upsert and mints a fresh day log on every
 * re-post. The bulk path deliberately keeps the permissive entry schema —
 * it reports the offending entry as `skipped` rather than failing the
 * whole batch — and applies the same rule per entry in the route.
 */
export const cycleDayLogCreateSchema = cycleDayLogInputSchema.superRefine(
  assertStableExternalId,
);

/** PATCH body — every field optional; `date`/`source`/`externalId` are immutable on update. */
export const cycleDayLogPatchSchema = z.object({
  flow: flowLevelEnum.nullable().optional(),
  intermenstrualBleeding: z.boolean().optional(),
  basalBodyTempC: z.number().min(30).max(45).nullable().optional(),
  temperatureExcluded: z.boolean().optional(),
  ovulationTest: ovulationTestEnum.nullable().optional(),
  cervicalMucus: cervicalMucusEnum.nullable().optional(),
  cervixPosition: cervixPositionEnum.nullable().optional(),
  cervixFirmness: cervixFirmnessEnum.nullable().optional(),
  cervixOpening: cervixOpeningEnum.nullable().optional(),
  sexualActivity: z.boolean().optional(),
  protectedSex: z.boolean().nullable().optional(),
  pregnancyTest: homeTestResultEnum.nullable().optional(),
  progesteroneTest: homeTestResultEnum.nullable().optional(),
  contraceptive: contraceptiveKindEnum.nullable().optional(),
  symptoms: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        // NULL is the ordinary case, not an edge: picking a symptom without
        // tapping an intensity is how most entries are logged, and the link
        // row stores that as a plain presence. Rejecting it refused every
        // unrated symptom with a 422 the sheet could only show as
        // "Could not save".
        severity: z.number().int().min(1).max(4).nullable().optional(),
      }),
    )
    .max(40)
    .optional(),
  note: z.string().max(500).nullable().optional(),
  loggedAt: boundedLoggedAt.optional(),
});

export const MAX_CYCLE_BULK_ENTRIES = 500;

export const cycleBulkSchema = z.object({
  entries: z.array(cycleDayLogInputSchema).min(1).max(MAX_CYCLE_BULK_ENTRIES),
});

/* ── period-boundary shortcut ────────────────────────────────────── */

export const cyclePeriodSchema = z
  .object({
    action: z.enum(["start", "end"]),
    date: dateString,
    externalId: z.string().min(1).max(120).optional(),
    loggedAt: boundedLoggedAt,
  })
  .superRefine(assertStableExternalId);

/* ── calendar + history queries ──────────────────────────────────── */

export const cycleCalendarQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

export const cycleHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

/* ── cycle preferences (PATCH /api/auth/me/cycle-prefs) ──────────── */

/**
 * The pregnancy / postpartum state. `state: null` returns to the
 * ordinary cycle and clears every date with it, so no pregnancy date stays
 * behind once the owner leaves the state. A date omitted from the patch keeps
 * its stored value; the route checks the merged result
 * (`pregnancyPatchProblem`).
 */
export const cyclePregnancyStateEnum = z.enum(["PREGNANT", "POSTPARTUM"]);

export const cyclePregnancyPatchSchema = z
  .object({
    state: cyclePregnancyStateEnum.nullable(),
    startDate: dateString.nullable().optional(),
    dueDate: dateString.nullable().optional(),
    deliveryDate: dateString.nullable().optional(),
    postpartumWeeks: z
      .number()
      .int()
      .min(POSTPARTUM_WEEKS_MIN)
      .max(POSTPARTUM_WEEKS_MAX)
      .optional(),
  })
  .strict();

export type CyclePregnancyPatch = z.infer<typeof cyclePregnancyPatchSchema>;

/** The stored pregnancy columns a patch merges over. */
export interface StoredPregnancyColumns {
  reproductiveState: "PREGNANT" | "POSTPARTUM" | null;
  pregnancyStartDate: string | null;
  pregnancyDueDate: string | null;
  deliveryDate: string | null;
  postpartumWeeks: number;
}

/** Merge a pregnancy patch over the stored columns. */
export function mergePregnancyPatch(
  stored: StoredPregnancyColumns,
  patch: CyclePregnancyPatch,
): StoredPregnancyColumns {
  if (patch.state === null) {
    return {
      reproductiveState: null,
      pregnancyStartDate: null,
      pregnancyDueDate: null,
      deliveryDate: null,
      postpartumWeeks: patch.postpartumWeeks ?? stored.postpartumWeeks,
    };
  }
  return {
    reproductiveState: patch.state,
    pregnancyStartDate:
      patch.startDate !== undefined
        ? patch.startDate
        : stored.pregnancyStartDate,
    pregnancyDueDate:
      patch.dueDate !== undefined ? patch.dueDate : stored.pregnancyDueDate,
    deliveryDate:
      patch.deliveryDate !== undefined
        ? patch.deliveryDate
        : stored.deliveryDate,
    postpartumWeeks: patch.postpartumWeeks ?? stored.postpartumWeeks,
  };
}

/** The codes `pregnancyPatchProblem` answers with. */
export const PREGNANCY_PATCH_ERROR_CODES = {
  startInFuture: "cycle-prefs.pregnancy.start_in_future",
  deliveryInFuture: "cycle-prefs.pregnancy.delivery_in_future",
  dueBeforeStart: "cycle-prefs.pregnancy.due_before_start",
  deliveryRequired: "cycle-prefs.pregnancy.delivery_required",
} as const;

/**
 * What is wrong with a merged state on the owner's day `today`, as an error
 * code, or null. A first day or a delivery cannot lie in the future; a due
 * date must come after the first day; POSTPARTUM needs its delivery date.
 */
export function pregnancyPatchProblem(
  merged: StoredPregnancyColumns,
  today: string,
):
  | (typeof PREGNANCY_PATCH_ERROR_CODES)[keyof typeof PREGNANCY_PATCH_ERROR_CODES]
  | null {
  if (merged.reproductiveState === null) return null;
  if (merged.pregnancyStartDate && merged.pregnancyStartDate > today) {
    return PREGNANCY_PATCH_ERROR_CODES.startInFuture;
  }
  if (merged.deliveryDate && merged.deliveryDate > today) {
    return PREGNANCY_PATCH_ERROR_CODES.deliveryInFuture;
  }
  if (
    merged.pregnancyStartDate &&
    merged.pregnancyDueDate &&
    merged.pregnancyDueDate <= merged.pregnancyStartDate
  ) {
    return PREGNANCY_PATCH_ERROR_CODES.dueBeforeStart;
  }
  if (merged.reproductiveState === "POSTPARTUM" && !merged.deliveryDate) {
    return PREGNANCY_PATCH_ERROR_CODES.deliveryRequired;
  }
  return null;
}

/**
 * Partial deep-merge body for the cycle-prefs PATCH. Mirrors the
 * notification-prefs precedent: an omitted field is left untouched.
 */
export const cyclePrefsSchema = z
  .object({
    enabled: z.boolean().optional(),
    goal: cycleTrackingGoalEnum.optional(),
    // Symptothermal secondary symptom — advanced cycle setting (MUCUS default
    // | CERVIX). Drives which second sign the double-check uses.
    secondarySymptom: secondarySymptomEnum.optional(),
    rawChartMode: z.boolean().optional(),
    predictionEnabled: z.boolean().optional(),
    discreetNotifications: z.boolean().optional(),
    sensitiveCategoryEncryption: z.boolean().optional(),
    typicalCycleLength: z.number().int().min(15).max(60).nullable().optional(),
    typicalPeriodLength: z.number().int().min(1).max(15).nullable().optional(),
    // Bound matches the engine clamp [LUTEAL_MIN, LUTEAL_MAX] (§4) so the
    // stored value never silently snaps in the predictor (QA HIGH).
    lutealPhaseLength: z.number().int().min(10).max(16).nullable().optional(),
    // Pregnancy and postpartum (see `cyclePregnancyPatchSchema`).
    pregnancy: cyclePregnancyPatchSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one preference field is required",
  });

export type CyclePrefsInput = z.infer<typeof cyclePrefsSchema>;
