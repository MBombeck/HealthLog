import { z } from "zod/v4";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const scheduleSchema = z.object({
  windowStart: z.string().regex(timeRegex, "Format: HH:mm"),
  windowEnd: z.string().regex(timeRegex, "Format: HH:mm"),
  label: z.string().max(50).optional(),
});

export const createMedicationSchema = z.object({
  name: z.string().min(1).max(100),
  dose: z.string().min(1).max(50),
  schedules: z.array(scheduleSchema).min(1, "Mindestens ein Zeitfenster"),
});

export const updateMedicationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  dose: z.string().min(1).max(50).optional(),
  active: z.boolean().optional(),
  schedules: z.array(scheduleSchema).optional(),
});

export const intakeSchema = z.object({
  medicationId: z.string().min(1),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  skipped: z.boolean().optional().default(false),
  idempotencyKey: z.string().max(128).optional(),
});

export const externalIntakeSchema = z.object({
  medicationName: z.string().min(1),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  idempotencyKey: z.string().max(128),
});

export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;
export type IntakeInput = z.infer<typeof intakeSchema>;
