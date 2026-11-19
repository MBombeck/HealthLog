/**
 * The request schema of `POST /api/symptoms/events/batch`, shared by the
 * route and the OpenAPI registry.
 */
import { z } from "zod/v4";

import { isoDateTime } from "@/lib/validations/datetime";

export const MAX_SYMPTOM_BATCH_ENTRIES = 500;

/**
 * Types are checked here, values per entry: an unknown code, an intensity
 * off the scale, a source other than `APPLE_HEALTH` or an implausible time
 * skips that entry and the rest of the batch still lands.
 */
export const symptomBatchEntrySchema = z.object({
  code: z.string().min(1).max(80),
  occurredAt: isoDateTime().transform((s) => new Date(s)),
  endAt: isoDateTime()
    .transform((s) => new Date(s))
    .optional(),
  intensity: z.number().finite(),
  // Stability is checked per entry, not at the field: a schema-level refusal
  // would fail the whole batch on one bad row.
  // @external-id-checked-per-entry: src/lib/symptoms/apple-health-ingest.ts
  externalId: z.string().min(1).max(120),
  source: z.string().min(1).max(40),
});

export const symptomBatchPayloadSchema = z.object({
  entries: z
    .array(symptomBatchEntrySchema)
    .min(1)
    .max(MAX_SYMPTOM_BATCH_ENTRIES),
});

/** The batch's outer shape alone, read before the entries are checked. */
export const symptomBatchShapeSchema = z.object({
  entries: z.array(z.unknown()).min(1),
});
