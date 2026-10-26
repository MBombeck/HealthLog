import { MEASUREMENT_SOURCE_LIST_LABEL_KEYS } from "@/lib/i18n/source-labels";
import type { useTranslations } from "@/lib/i18n/context";
import { CUMULATIVE_DAY_SUM_TYPES } from "@/lib/measurements/cumulative-day-sum";
import { MEASUREMENT_NOTES_MAX_LENGTH } from "@/lib/measurements/notes-limit";
import { MEASUREMENT_SOURCES } from "@/lib/measurements/sources";

type Translate = ReturnType<typeof useTranslations>["t"];

/**
 * Cumulative types whose list view collapses to one row per profile-zone day
 * with a chevron into the per-sample chunks. Mirrors the server's
 * `CUMULATIVE_DAY_SUM_TYPES`, so the route's `groupBy=day` branch and the
 * client's filter detection agree.
 */
export const CUMULATIVE_TYPES = new Set<string>(CUMULATIVE_DAY_SUM_TYPES);

// Columns that open descending when first selected. The date column reads
// newest-first by default; every other column opens ascending.
export const MEASUREMENT_DESC_COLUMNS: ReadonlySet<string> = new Set([
  "measuredAt",
]);

export interface Measurement {
  id: string;
  type: string;
  value: number;
  unit: string;
  source: string;
  measuredAt: string;
  notes: string | null;
  /**
   * Present only on collapsed daily rows (`?type=…&groupBy=day`): drives the
   * expand chevron and the drill-down read keyed by the calendar day.
   */
  dayKey?: string;
  sampleCount?: number;
  /**
   * Present only on per-night SLEEP_DURATION rows. `value` is the night's
   * time asleep in minutes; these carry the night's context so the row
   * reads as one night, not many stage values.
   */
  sleepStage?: string | null;
  napCount?: number;
  napAsleepMinutes?: number;
  awakenings?: number;
}

/** A synthetic day or night row: many raw rows behind one `dayKey`. */
export function isGroupedRow(m: Measurement): boolean {
  return m.dayKey !== undefined && m.sampleCount !== undefined;
}

/** The labels for the sleep stages shown in the drill-down. */
export function sleepStageLabel(
  stage: string | null | undefined,
  t: Translate,
): string {
  switch (stage) {
    case "DEEP":
      return t("insights.sleep.stages.deep");
    case "REM":
      return t("insights.sleep.stages.rem");
    case "CORE":
      return t("insights.sleep.stages.core");
    case "ASLEEP":
      return t("insights.sleep.stages.asleep");
    case "AWAKE":
      return t("insights.sleep.stages.awake");
    case "IN_BED":
      return t("insights.sleep.stages.inBed");
    default:
      return stage ?? "";
  }
}

export const PAGE_SIZE = 25;
// Input cap mirrors the server Zod bound. The list preview truncates at a
// shorter width so a long note does not stretch a list row.
export const MAX_COMMENT_LENGTH = MEASUREMENT_NOTES_MAX_LENGTH;
const COMMENT_PREVIEW_LENGTH = 40;

export function truncateComment(comment: string): string {
  if (comment.length <= COMMENT_PREVIEW_LENGTH) return comment;
  return `${comment.slice(0, COMMENT_PREVIEW_LENGTH - 1)}…`;
}

export function toDateTimeLocalValue(isoString: string): string {
  const date = new Date(isoString);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/**
 * The `MeasurementSource` enum through the `measurements.source*` keys, so
 * the SCREAMING_SNAKE enum never reaches a cell or the filter. The catalogue
 * is keyed by the enum, so a provider added without its label is a type
 * error rather than a row that reads `GOOGLE_HEALTH`.
 */
export function formatMeasurementSource(source: string, t: Translate) {
  const key = MEASUREMENT_SOURCE_LIST_LABEL_KEYS[
    source as keyof typeof MEASUREMENT_SOURCE_LIST_LABEL_KEYS
  ] as string | undefined;
  // A row written by a server the client does not know yet still renders as
  // its own value rather than as a missing translation key.
  return key ? t(key) : source;
}

/** The sources the filter offers, from the shared Zod enum. */
export const MEASUREMENT_SOURCE_OPTIONS = MEASUREMENT_SOURCES;

/**
 * A date input's `YYYY-MM-DD` as the offset-bearing ISO datetime the list's
 * `from` / `to` params need: `from` at the local start of the day, `to` at
 * its local end, so a single-day range returns the whole day.
 */
export function dayBoundaryIso(
  day: string,
  boundary: "start" | "end",
): string | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  const date =
    boundary === "start"
      ? new Date(y, m - 1, d, 0, 0, 0, 0)
      : new Date(y, m - 1, d, 23, 59, 59, 999);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * Per-source badge colour: Apple Health in the pink of the iOS app's accent,
 * everything else the outline default.
 */
export function sourceBadgeClass(source: string): string {
  if (source === "APPLE_HEALTH") {
    return "border-brand-pink/50 bg-brand-pink/15 text-brand-pink";
  }
  return "";
}
