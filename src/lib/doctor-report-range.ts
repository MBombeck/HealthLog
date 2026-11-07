/**
 * The longest window a health report covers, in days, inclusive of both end
 * days. The export clamps a longer range to the last this many days ending
 * on its end (`normaliseDateRange`), and the window offered before a booked
 * visit is capped at it (`resolvePreparation`), so the visit card never
 * promises a report the export will not produce.
 *
 * Client-safe: no server import.
 */
export const REPORT_MAX_RANGE_DAYS = 730;
