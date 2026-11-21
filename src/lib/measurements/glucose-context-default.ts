/**
 * The meal context a new glucose reading starts on. The form used to start
 * on "fasting" at any hour, so an evening reading whose context nobody
 * touched was filed as fasting and skewed the fasting average.
 *
 * The person's own habit wins: the most recent reading with a context taken
 * within 90 minutes of the same clock time on another day. Without one, the
 * hour decides: before 10:00 fasting, from then on after a meal.
 */

export type GlucoseEntryContext =
  "FASTING" | "POSTPRANDIAL" | "RANDOM" | "BEDTIME";

const CONTEXTS: ReadonlySet<string> = new Set([
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
]);

/** Readings with a context, newest first. */
interface PastReading {
  measuredAt: string;
  glucoseContext?: string | null;
}

const SIMILAR_MINUTES = 90;
const FASTING_UNTIL_HOUR = 10;

/** Minutes between two clock times, the short way round midnight. */
function clockDistance(a: Date, b: Date): number {
  const minutes = (d: Date) => d.getHours() * 60 + d.getMinutes();
  const diff = Math.abs(minutes(a) - minutes(b));
  return Math.min(diff, 24 * 60 - diff);
}

export function defaultGlucoseContext(
  at: Date,
  history: ReadonlyArray<PastReading> = [],
): GlucoseEntryContext {
  for (const reading of history) {
    const context = reading.glucoseContext;
    if (!context || !CONTEXTS.has(context)) continue;
    const when = new Date(reading.measuredAt);
    if (Number.isNaN(when.getTime())) continue;
    if (clockDistance(when, at) <= SIMILAR_MINUTES) {
      return context as GlucoseEntryContext;
    }
  }
  return at.getHours() < FASTING_UNTIL_HOUR ? "FASTING" : "POSTPRANDIAL";
}
