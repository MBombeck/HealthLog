/**
 * The care calendar feed's request contract.
 *
 * Only the options are writable. The token and the record are never body
 * fields: the record is the caller's own, and the token is minted by the
 * server.
 */
import { z } from "zod/v4";

/** The feed's title modes. Mirrors `CareCalendarFeedTitleMode`. */
export const careFeedTitleModeEnum = z.enum(["DISCREET", "DESCRIPTIVE"]);

export const careFeedOptionsPatchSchema = z
  .object({
    includeVisits: z.boolean().optional(),
    includeCheckups: z.boolean().optional(),
    includeVaccinations: z.boolean().optional(),
    titleMode: careFeedTitleModeEnum.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one option is required",
  });

export type CareFeedOptionsPatch = z.infer<typeof careFeedOptionsPatchSchema>;
