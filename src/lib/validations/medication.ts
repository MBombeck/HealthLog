import { z } from "zod/v4";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
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
  "OTHER",
] as const;

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

export const scheduleSchema = z.object({
  windowStart: z.string().regex(timeRegex, "Format: HH:mm"),
  windowEnd: z.string().regex(timeRegex, "Format: HH:mm"),
  label: z.string().max(50).optional(),
  dose: z.string().max(50).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  intervalWeeks: z.number().int().min(1).max(4).optional(),
});

export const createMedicationSchema = z.object({
  name: z.string().min(1).max(100),
  dose: z.string().min(1).max(50),
  category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
  /** v1.4.25 W4d — treatment-class discriminator (GENERIC | GLP1). */
  treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
  /** v1.4.25 W4d — doses per pen/vial for inventory tracking. */
  dosesPerUnit: z.number().int().min(1).max(100).optional(),
  schedules: z.array(scheduleSchema).min(1, "Mindestens ein Zeitfenster"),
});

export const updateMedicationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  dose: z.string().min(1).max(50).optional(),
  category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
  treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
  dosesPerUnit: z.number().int().min(1).max(100).nullable().optional(),
  active: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  schedules: z.array(scheduleSchema).optional(),
});

export const intakeSchema = z.object({
  medicationId: z.string().min(1),
  scheduledFor: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  skipped: z.boolean().optional().default(false),
  idempotencyKey: z.string().max(128).optional(),
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
