import { z } from "zod/v4";

export const measurementTypeEnum = z.enum([
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
]);

export const measurementSourceEnum = z.enum(["MANUAL", "WITHINGS", "IMPORT"]);

const unitMap: Record<string, string> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  SLEEP_DURATION: "hours",
  ACTIVITY_STEPS: "steps",
};

export function getUnitForType(type: string): string {
  return unitMap[type] ?? "unknown";
}

export const createMeasurementSchema = z.object({
  type: measurementTypeEnum,
  value: z.number(),
  measuredAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  notes: z.string().max(500).optional(),
  source: measurementSourceEnum.optional().default("MANUAL"),
});

export const updateMeasurementSchema = z.object({
  value: z.number().optional(),
  measuredAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const listMeasurementsSchema = z.object({
  type: measurementTypeEnum.optional(),
  from: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  to: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateMeasurementInput = z.infer<typeof createMeasurementSchema>;
export type UpdateMeasurementInput = z.infer<typeof updateMeasurementSchema>;
export type ListMeasurementsInput = z.infer<typeof listMeasurementsSchema>;
