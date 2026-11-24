/**
 * Treatment series request validation, the source of truth for the
 * `/api/treatment-series*` wire contract (the OpenAPI registry reuses these).
 *
 * `userId` is never a body field. The title is the one required field on a
 * create: a series nobody can name is not findable. Every count, the status
 * and the session dates are derived on the server and are not accepted here.
 */
import { z } from "zod/v4";

import { isCalendarDateKey } from "@/lib/tz/date-only";
import { encounterKindEnum } from "@/lib/validations/encounters";

const id = z.string().min(1).max(40);

/** A calendar day, `YYYY-MM-DD`, between 1900 and ten years ahead. */
const day = z
  .string()
  .refine(isCalendarDateKey, { message: "must be a YYYY-MM-DD date" })
  .refine(
    (value) =>
      value >= "1900-01-01" &&
      value <= `${new Date().getUTCFullYear() + 10}-12-31`,
    { message: "must be a plausible date" },
  );

const title = z.string().trim().min(1).max(200);
const note = z.string().max(4000).nullable().optional();
/** Up to a few hundred: a year of daily radiation is the long end. */
const plannedSessions = z.number().int().min(1).max(500).nullable().optional();

export const treatmentSeriesCreateSchema = z
  .object({
    title,
    kind: encounterKindEnum.optional().default("THERAPY"),
    plannedSessions,
    startsOn: day,
    validUntil: day.nullable().optional(),
    prescriberId: id.nullable().optional(),
    performerId: id.nullable().optional(),
    episodeId: id.nullable().optional(),
    note,
  })
  .strict()
  .refine((b) => !b.validUntil || b.validUntil >= b.startsOn, {
    path: ["validUntil"],
    message: "validUntil must be on or after startsOn",
  });

export type TreatmentSeriesCreate = z.infer<typeof treatmentSeriesCreateSchema>;

/**
 * Partial edit; an omitted key is left alone, an explicit null clears it.
 * `endedOn` is "End series" (a day) or reopening it (null). A body naming
 * nothing is a 422.
 */
export const treatmentSeriesUpdateSchema = z
  .object({
    title: title.optional(),
    kind: encounterKindEnum.optional(),
    plannedSessions,
    startsOn: day.optional(),
    validUntil: day.nullable().optional(),
    endedOn: day.nullable().optional(),
    prescriberId: id.nullable().optional(),
    performerId: id.nullable().optional(),
    episodeId: id.nullable().optional(),
    note,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "name at least one field to change",
  });

export type TreatmentSeriesUpdate = z.infer<typeof treatmentSeriesUpdateSchema>;

export const treatmentSeriesListQuerySchema = z
  .object({
    /** Only the series given for this condition episode. */
    episodeId: id.optional(),
  })
  .strict();
