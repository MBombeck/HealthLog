import { z } from "zod/v4";

const phaseModeSchema = z.enum(["MINUTES", "PERCENT"]);

export const phaseConfigSchema = z.object({
  greenValue: z.number().int().min(0).max(1440),
  greenMode: phaseModeSchema,
  yellowValue: z.number().int().min(0).max(1440),
  yellowMode: phaseModeSchema,
  orangeValue: z.number().int().min(0).max(1440),
  orangeMode: phaseModeSchema,
  redValue: z.number().int().min(0).max(1440),
  redMode: phaseModeSchema,
});

export type PhaseConfigInput = z.infer<typeof phaseConfigSchema>;
