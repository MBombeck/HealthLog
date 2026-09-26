/**
 * v1.17.1 — Measurement / Vorsorge (preventive-care) reminders.
 *
 * A reminder class distinct from the medication loop: "measure BP every
 * 7 days", "annual blood panel", "log weight weekly". Tied to a
 * measurement TYPE (auto-resolving when a matching reading lands) or to a
 * free-text checklist label (resolving only on a manual "Erledigt").
 *
 * The cadence vocabulary reuses the medication recurrence engine: a
 * `intervalDays` rolling cadence OR an RFC-5545 `rrule`. The server
 * computes the canonical `nextDueAt` so web ↔ iOS show identical numbers
 * (server-authoritative; the client consumes the resolved DTO, never
 * recomputes).
 */
import { z } from "zod/v4";

/**
 * The auto-resolve target types. Kept as an explicit allow-list rather
 * than the full `MeasurementType` enum: a Vorsorge reminder only makes
 * sense for the metrics a user actively goes and measures on a cadence —
 * vitals + the body-composition family a scale produces.
 *
 * v1.18.1 (V3) widens the original 7 to the full ~15 active-measurement
 * set. The DB column is the full `MeasurementType` enum, so this is a
 * pure application-layer change — no migration.
 *
 * DELIBERATELY excluded: passive wearable scores + cumulative activity +
 * device events (RECOVERY_SCORE, ACTIVITY_STEPS, IRREGULAR_RHYTHM_*, …),
 * and the passive nightly samples RESTING_HEART_RATE / HEART_RATE_VARIABILITY
 * / VO2_MAX — nudging a user to "go measure" a passive sample makes no
 * sense (they still auto-satisfy any free-text reminder via a LabResult if
 * ever wanted, but they are not "remind me to measure" targets).
 *
 * BP is matched on `BLOOD_PRESSURE_SYS` as the canonical sentinel — a BP
 * reading is two rows (SYS + DIA) and matching either would double-count;
 * SYS is the agreed "a BP was measured" anchor. A single step-on-the-scale
 * event writes WEIGHT + several body-composition rows at once, so any one
 * of them satisfies its linked reminder.
 */
export const measurementReminderTypeEnum = z
  .enum([
    // Vitals
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "PULSE",
    "BLOOD_GLUCOSE",
    "OXYGEN_SATURATION",
    "BODY_TEMPERATURE",
    // Body composition (one scale reading produces the whole family)
    "BODY_FAT",
    "FAT_MASS",
    "FAT_FREE_MASS",
    "MUSCLE_MASS",
    "LEAN_BODY_MASS",
    "BONE_MASS",
    "TOTAL_BODY_WATER",
    "VISCERAL_FAT",
    "BODY_MASS_INDEX",
    "WAIST_CIRCUMFERENCE",
    // v1.27.6 — the mental-wellbeing screeners become plannable Vorsorge
    // items. Not a passive wearable score: a screening is an active "go and
    // do it" action exactly like stepping on the scale. Auto-resolves from
    // the server-owned COMPUTED PHQ9_SCORE / GAD7_SCORE row the assessment
    // route writes on completion. Gated on the opt-in mentalHealth module in
    // the dispatcher (see `moduleForMeasurementType`).
    "PHQ9_SCORE",
    "GAD7_SCORE",
    // v1.27.9 — WHO-5 + SCI join the plannable screenings on the identical
    // contract (auto-resolve on the server-owned COMPUTED score row, module-
    // gated in the dispatcher).
    "WHO5_SCORE",
    "SCI_SCORE",
  ])
  .meta({
    id: "MeasurementReminderType",
    description:
      "Auto-resolve target metric (vitals + body-composition family + the PHQ-9 / GAD-7 / WHO-5 / SCI screenings). BP resolves on BLOOD_PRESSURE_SYS (the SYS row is the 'a BP was measured' sentinel); a screening reminder resolves on the server-written *_SCORE row when a check-in completes. Omit for a free-text Vorsorge that resolves only on a manual satisfy or a matching lab result.",
  });

export type MeasurementReminderType = z.infer<
  typeof measurementReminderTypeEnum
>;

/**
 * v1.27.6 — the reminder types that are SCREENINGS, not numeric readings.
 * Every surface with a per-reminder primary action branches on this: a
 * screening routes to the check-in page (`/mental-wellbeing`) instead of
 * opening the numeric MeasurementForm — a score is never typed in, it
 * falls out of a completed test (which then auto-satisfies the reminder).
 */
export const SCREENING_REMINDER_TYPES: ReadonlySet<string> = new Set([
  "PHQ9_SCORE",
  "GAD7_SCORE",
  "WHO5_SCORE",
  "SCI_SCORE",
]);

/** Whether a reminder's `measurementType` targets a screening check-in. */
export function isScreeningReminderType(
  type: string | null | undefined,
): boolean {
  return type != null && SCREENING_REMINDER_TYPES.has(type);
}

/**
 * RFC-5545 RRULE guard. The recurrence engine parses it; here we only
 * bound the length and require the `FREQ=` token so a typo doesn't reach
 * the engine. Full validation is the engine's job (it tolerates a
 * malformed rule by emitting no slots rather than throwing).
 */
const rruleField = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => /FREQ=/i.test(v), {
    message: "rrule must contain a FREQ= component",
  });

/**
 * Shared cadence refinement: exactly one of `intervalDays` / `rrule` is
 * required on create. Both NULL would leave `nextDueAt` uncomputable.
 */
const cadenceRefinement = (
  data: { intervalDays?: number | null; rrule?: string | null },
  ctx: z.RefinementCtx,
): void => {
  const hasInterval =
    data.intervalDays !== undefined && data.intervalDays !== null;
  const hasRrule = data.rrule !== undefined && data.rrule !== null;
  if (!hasInterval && !hasRrule) {
    ctx.addIssue({
      code: "custom",
      message: "Provide either intervalDays or rrule",
      path: ["intervalDays"],
    });
  }
  if (hasInterval && hasRrule) {
    ctx.addIssue({
      code: "custom",
      message: "Provide only one of intervalDays or rrule",
      path: ["rrule"],
    });
  }
};

export const createMeasurementReminderSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    measurementType: measurementReminderTypeEnum.nullish(),
    intervalDays: z.number().int().min(1).max(3650).nullish(),
    rrule: rruleField.nullish(),
    anchorDate: z.iso.datetime({ offset: true }).nullish(),
    notifyHour: z.number().int().min(0).max(23).default(9),
    location: z.string().trim().max(200).nullish(),
    enabled: z.boolean().default(true),
  })
  .superRefine(cadenceRefinement)
  .meta({
    id: "MeasurementReminderCreate",
    description:
      "Create a Vorsorge reminder. Exactly one of intervalDays (rolling, every N days) or rrule (RFC-5545, e.g. FREQ=YEARLY) is required. measurementType enables auto-resolve from an incoming reading; omit it for a free-text checklist reminder.",
  });

export type CreateMeasurementReminderInput = z.infer<
  typeof createMeasurementReminderSchema
>;

/**
 * Update is fully partial. Cadence fields stay mutually-exclusive but
 * are not required (an edit that only changes the label leaves the
 * cadence alone). The route re-derives `nextDueAt` after applying the
 * patch.
 */
export const updateMeasurementReminderSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    measurementType: measurementReminderTypeEnum.nullish(),
    intervalDays: z.number().int().min(1).max(3650).nullish(),
    rrule: rruleField.nullish(),
    anchorDate: z.iso.datetime({ offset: true }).nullish(),
    notifyHour: z.number().int().min(0).max(23).optional(),
    location: z.string().trim().max(200).nullish(),
    enabled: z.boolean().optional(),
  })
  .meta({
    id: "MeasurementReminderUpdate",
    description:
      "Partial edit of a Vorsorge reminder. Omitted fields are left untouched; nextDueAt is recomputed server-side when the cadence changes and otherwise kept (a notifyHour edit moves only the hour on the same due day).",
  });

export type UpdateMeasurementReminderInput = z.infer<
  typeof updateMeasurementReminderSchema
>;

/**
 * The canonical DTO every surface (web list, dashboard tile, iOS) mirrors.
 * `nextDueAt` is the server-computed next-due instant.
 */
export const measurementReminderDto = z
  .object({
    id: z.string(),
    label: z.string(),
    measurementType: measurementReminderTypeEnum.nullable(),
    intervalDays: z.number().int().nullable(),
    rrule: z.string().nullable(),
    anchorDate: z.iso.datetime({ offset: true }).nullable(),
    endsOn: z.iso.datetime({ offset: true }).nullable(),
    origin: z.enum(["VORSORGE", "COACH"]),
    notifyHour: z.number().int(),
    location: z.string().nullable(),
    nextDueAt: z.iso.datetime({ offset: true }).nullable(),
    lastSatisfiedAt: z.iso.datetime({ offset: true }).nullable(),
    snoozedUntil: z.iso.datetime({ offset: true }).nullable(),
    lastSkippedAt: z.iso.datetime({ offset: true }).nullable(),
    skipCount: z.number().int(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MeasurementReminderDTO",
    description:
      "A Vorsorge reminder. nextDueAt is server-computed (server-authoritative). A free-text reminder carries measurementType=null and resolves only on a manual satisfy. origin distinguishes a user-created (VORSORGE) reminder from one minted by a Coach cadence suggestion (COACH); endsOn bounds a finite course window (null = open-ended). snoozedUntil/lastSkippedAt/skipCount are resolved values: snoozed means snoozedUntil > now, a skipped cycle means lastSkippedAt > lastSatisfiedAt; clients compare against the clock and never recompute cadence. lastSatisfiedAt stays the only completed signal — skip and snooze never move it.",
  });

/**
 * v1.18.6 — explicit-completion result. The `complete` route is the
 * user-action equivalent of the cron auto-satisfy: it stamps
 * `lastSatisfiedAt` and re-anchors `nextDueAt` through the SAME shared
 * primitive, so it fires no notification of its own and is idempotent.
 *
 * `completed` reports whether THIS call advanced the reminder (true) or was
 * a forward-only no-op because a prior satisfy / matching reading already
 * fulfilled the current cycle (false). Either way the response is a 200 so
 * a client that completes an already-completed reminder need not special-case
 * the second tap. `reminder` carries the canonical post-completion DTO.
 */
export const measurementReminderCompletionDto = z
  .object({
    completed: z.boolean(),
    reminder: measurementReminderDto,
  })
  .meta({
    id: "MeasurementReminderCompletion",
    description:
      "Result of an explicit reminder completion. completed=true when this call advanced lastSatisfiedAt; completed=false when an earlier satisfy or a matching reading already fulfilled the current cycle (idempotent no-op). reminder is the canonical post-completion DTO.",
  });

/**
 * v1.37.20 (#223) — snooze body. Day precision on purpose: the client names
 * a local calendar day, the server resolves it to that day's notifyHour in
 * the profile timezone. No client-supplied instant ever anchors the cadence.
 * The range gate (tomorrow .. +5 years) lives in the route, where the
 * profile timezone is known.
 */
export const snoozeMeasurementReminderSchema = z
  .object({
    until: z.iso.date(),
  })
  .meta({
    id: "MeasurementReminderSnooze",
    description:
      "Push a reminder's current due date back to a calendar day (YYYY-MM-DD). The server resolves the day to the reminder's notifyHour in the profile timezone. Must be at least tomorrow and at most five years out. The regular cadence is untouched: lastSatisfiedAt and the anchor stay where they are, and the reminder resumes its normal interval after the snoozed cycle.",
  });

export type SnoozeMeasurementReminderInput = z.infer<
  typeof snoozeMeasurementReminderSchema
>;

/**
 * v1.37.20 (#223) — skip result. `skipped=false` is the forward-only no-op
 * (a concurrent skip or satisfy already advanced the row).
 */
export const measurementReminderSkipDto = z
  .object({
    skipped: z.boolean(),
    reminder: measurementReminderDto,
  })
  .meta({
    id: "MeasurementReminderSkip",
    description:
      "Result of skipping the current due cycle. skipped=true when this call recorded the skip and restarted the interval from the skip instant; skipped=false when a concurrent skip or satisfy already advanced the row (idempotent no-op). A skip never touches lastSatisfiedAt — it is recorded honestly as a skip, not a completion.",
  });

/**
 * v1.37.20 (iOS #68) — completion-ledger query + row. History starts with
 * the release that ships the ledger; the single-cursor engine holds nothing
 * to backfill from.
 */
export const listReminderHistorySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .meta({
    id: "MeasurementReminderHistoryQuery",
    description: "Pagination for the reminder completion ledger.",
  });

export const measurementReminderEventDto = z
  .object({
    id: z.string(),
    kind: z.enum(["SATISFIED", "SKIPPED"]),
    occurredAt: z.iso.datetime({ offset: true }),
    onTime: z.boolean(),
    source: z.enum([
      "manual",
      "auto_measurement",
      "auto_lab",
      "telegram",
      "vaccination",
      "encounter",
      "skip",
    ]),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MeasurementReminderEvent",
    description:
      "One completion-ledger row: an honest fulfilment (SATISFIED) or an honest skip (SKIPPED). onTime is derived server-side at write time against the due instant that was current when the event landed — clients never re-derive it. History begins at the release that introduced the ledger.",
  });

export const measurementReminderHistoryDto = z
  .object({
    events: z.array(measurementReminderEventDto),
    meta: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
  })
  .meta({
    id: "MeasurementReminderHistory",
    description: "Paginated completion ledger for one reminder, newest first.",
  });
