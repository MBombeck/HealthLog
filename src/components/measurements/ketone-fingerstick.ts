/**
 * One fingerstick as one entry (#1367): the ketones, and the glucose from the
 * same drop when the meter gave one, as the batch the measurements route
 * writes in one transaction. Both readings carry the one timestamp, so the
 * server pairs them exactly when it derives the glucose-ketone index.
 *
 * Pure, so the form's write path can be pinned without rendering it.
 */
import { toCanonicalMgdl, type GlucoseUnit } from "@/lib/glucose";
import { parseDecimalEntry } from "@/lib/measurements/entry-units";

export interface FingerstickRow {
  type: "BLOOD_GLUCOSE" | "BLOOD_KETONES";
  value: number;
  measuredAt: string;
  notes?: string;
  glucoseContext?: string;
}

/**
 * The rows to post, glucose first, or null when a typed number does not read
 * as one. An empty glucose field means the meter gave ketones only.
 */
export function ketoneFingerstickBatch(input: {
  ketones: string;
  glucose: string;
  /** The unit the glucose was typed in: the account's glucose unit. */
  glucoseUnit: GlucoseUnit;
  glucoseContext: string;
  measuredAt: string;
  notes: string;
}): FingerstickRow[] | null {
  const ketones = parseDecimalEntry(input.ketones);
  if (ketones === null) return null;
  const notes = input.notes || undefined;
  const ketoneRow: FingerstickRow = {
    type: "BLOOD_KETONES",
    value: ketones,
    measuredAt: input.measuredAt,
    notes,
  };
  if (input.glucose.trim() === "") return [ketoneRow];
  const glucose = parseDecimalEntry(input.glucose);
  if (glucose === null) return null;
  return [
    {
      type: "BLOOD_GLUCOSE",
      // Stored in mg/dL whatever the reader types in.
      value: toCanonicalMgdl(glucose, input.glucoseUnit),
      measuredAt: input.measuredAt,
      notes,
      glucoseContext: input.glucoseContext,
    },
    ketoneRow,
  ];
}
