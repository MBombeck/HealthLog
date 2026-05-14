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

export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;
export type IntakeInput = z.infer<typeof intakeSchema>;
export type ListIntakeEventsInput = z.infer<typeof listIntakeEventsSchema>;
export type UpdateIntakeEventInput = z.infer<typeof updateIntakeEventSchema>;
