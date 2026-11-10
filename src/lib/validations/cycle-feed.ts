/**
 * The cycle calendar feed's request contract (#1350).
 *
 * Only the options are writable. The token, the record and the carrier are
 * never body fields: the record comes from the resolved session, the carrier
 * is the actor, and the token is minted by the server.
 */
import { z } from "zod/v4";

/** The feed's title modes. Mirrors `CycleCalendarFeedTitleMode`. */
export const cycleFeedTitleModeEnum = z.enum(["DISCREET", "DESCRIPTIVE"]);

/** How a forecast period is drawn. Mirrors `CycleCalendarFeedForecastStyle`. */
export const cycleFeedForecastStyleEnum = z.enum(["EXACT", "MARGIN", "BAND"]);

/**
 * The style a newly minted feed starts with. The column's own default is BAND,
 * which keeps every feed minted before the option on the events it had; a new
 * one starts with the calculated days and their margin drawn apart.
 */
export const NEW_FEED_FORECAST_STYLE: z.infer<
  typeof cycleFeedForecastStyleEnum
> = "MARGIN";

/** Forecast cycles ahead. The feed caps itself further by band width. */
export const FEED_HORIZON_MIN = 1;
export const FEED_HORIZON_MAX = 6;
/** Observed cycles included as history. */
export const FEED_HISTORY_MIN = 0;
export const FEED_HISTORY_MAX = 12;

export const cycleFeedOptionsPatchSchema = z
  .object({
    horizonCycles: z
      .number()
      .int()
      .min(FEED_HORIZON_MIN)
      .max(FEED_HORIZON_MAX)
      .optional(),
    historyCycles: z
      .number()
      .int()
      .min(FEED_HISTORY_MIN)
      .max(FEED_HISTORY_MAX)
      .optional(),
    includeFertile: z.boolean().optional(),
    titleMode: cycleFeedTitleModeEnum.optional(),
    forecastStyle: cycleFeedForecastStyleEnum.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one option is required",
  });

export type CycleFeedOptionsPatch = z.infer<typeof cycleFeedOptionsPatchSchema>;
