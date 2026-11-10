"use client";

/**
 * Pure URL-facet helpers for the labs overview list, following the
 * documents-vault and measurements patterns: the list's filter state
 * lives in the page URL (?q&status&category&from&to) so a filtered view is
 * deep-linkable and survives navigation, reload and back/forward. Parsing is
 * lenient — an unknown facet drops silently — and serialisation omits defaults
 * so the unfiltered list keeps a clean URL.
 */
import { applyOrder } from "@/lib/module-list-prefs";
import type { ModuleSortDir } from "@/lib/settings/module-list-layout";
import {
  dateOnlyKey,
  isCalendarDateKey,
  isNoonUtcAnchor,
} from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import type { MarkerRow } from "./lab-list-rows";
import type { LabOverviewCategoryDto } from "./types";

export const LAB_STATUS_FILTERS = [
  "ALL",
  "abnormal",
  "in-range",
  "below",
  "above",
] as const;
export type LabStatusFilter = (typeof LAB_STATUS_FILTERS)[number];

export function isLabStatusFilter(value: unknown): value is LabStatusFilter {
  return typeof value === "string" && STATUS_SET.has(value);
}

export interface LabListFilters {
  /** Case-insensitive substring search over analyte name and panel. */
  q?: string;
  /** Status filter: ALL | abnormal | in-range | below | above. */
  status?: LabStatusFilter;
  /** Category key (matches category.key) or ALL. */
  category?: string;
  /**
   * "Last measured": inclusive day bounds (`?from` / `?to`, YYYY-MM-DD) on
   * the marker's newest reading (`latest.takenAt`), in the display zone.
   * Older readings are not looked at, so a marker measured inside the range
   * and again after it drops out, which is why the pill reads "Last measured".
   */
  fromDay?: string;
  toDay?: string;
}

const STATUS_SET = new Set<string>(LAB_STATUS_FILTERS);

function dayOrUndefined(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isCalendarDateKey(trimmed) ? trimmed : undefined;
}

/**
 * Build a lookup map from markerKey (`bm:<id>` or `analyte:<name>`) to category.key.
 */
export function buildMarkerCategoryMap(
  categories: readonly LabOverviewCategoryDto[] | undefined | null,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!categories) return map;
  for (const cat of categories) {
    for (const key of cat.markerKeys) {
      map.set(key, cat.key);
    }
  }
  return map;
}

/**
 * Parse the labs overview URL search params into the filter object.
 */
export function parseLabListSearchParams(
  params: URLSearchParams,
): LabListFilters {
  const filters: LabListFilters = {};

  const q = params.get("q")?.trim();
  if (q) filters.q = q;

  const status = params.get("status")?.trim();
  if (status && isLabStatusFilter(status) && status !== "ALL") {
    filters.status = status;
  }

  const category = params.get("category")?.trim();
  if (category && category !== "ALL") {
    filters.category = category;
  }

  const fromDay = dayOrUndefined(params.get("from"));
  if (fromDay) filters.fromDay = fromDay;

  const toDay = dayOrUndefined(params.get("to"));
  if (toDay) filters.toDay = toDay;

  return filters;
}

/**
 * Serialise the filter object back into the page URL query string (no leading `?`).
 * Defaults/ALL values are omitted.
 */
export function labListFiltersToSearch(filters: LabListFilters): string {
  const sp = new URLSearchParams();
  if (filters.q?.trim()) sp.set("q", filters.q.trim());
  if (filters.status && filters.status !== "ALL")
    sp.set("status", filters.status);
  if (filters.category && filters.category !== "ALL") {
    sp.set("category", filters.category);
  }
  if (filters.fromDay) sp.set("from", filters.fromDay);
  if (filters.toDay) sp.set("to", filters.toDay);
  return sp.toString();
}

/**
 * Resolve the local calendar day key (`YYYY-MM-DD`) for a lab reading.
 *
 * Data model semantics & date-only heuristic:
 * The data model (`LabResult` in Prisma and `LabResultDto`) stores `takenAt` as
 * an ISO timestamp and does not have an explicit date-only marker column (e.g.
 * `hasTime` or `dateOnly`). Instead, the codebase convention (`@/lib/tz/date-only`)
 * stores date-only imports at 12:00:00.000 UTC (`dateOnlyAtNoonUtc`).
 *
 * Inherent ambiguity:
 * An instant reading entered at exactly 12:00:00.000Z is indistinguishable from a
 * date-only anchor without schema changes. We preserve the `isNoonUtcAnchor`
 * heuristic here so that the day key used for filtering matches exactly what the
 * row displays to the user via `useLabDate` (`calendarDate(instant)` for noon-UTC
 * anchors, avoiding timezone-shift discrepancies in timezones like UTC+14).
 * Timestamps with a time of day resolve in the user's timezone via `userDayKey`.
 */
export function labReadingDayKey(takenAt: string, tz: string): string {
  const instant = new Date(takenAt);
  if (isNoonUtcAnchor(instant)) {
    return dateOnlyKey(instant);
  }
  return userDayKey(instant, tz);
}

/**
 * Filter rows by text search, reference range status, category, and date bounds.
 */
export function filterMarkerRows(
  rows: readonly MarkerRow[],
  filters: LabListFilters,
  categoryOf?: (markerKey: string) => string | undefined,
  dayKeyOf: (takenAt: string) => string = (iso) => iso.slice(0, 10),
): MarkerRow[] {
  const query = filters.q?.trim().toLowerCase();
  const status = filters.status;
  const category = filters.category;
  const fromDay = filters.fromDay;
  const toDay = filters.toDay;

  return rows.filter((row) => {
    // 1. Text search
    if (query) {
      const analyteMatch = row.analyte.toLowerCase().includes(query);
      const panelMatch = row.panel?.toLowerCase().includes(query) ?? false;
      if (!analyteMatch && !panelMatch) return false;
    }

    // 2. Reference range status
    if (status && status !== "ALL") {
      const rowStatus = row.latest.rangeStatus;
      if (status === "abnormal") {
        if (rowStatus !== "below" && rowStatus !== "above") return false;
      } else if (rowStatus !== status) {
        return false;
      }
    }

    // 3. Category — fail closed when categoryOf is unavailable
    if (category && category !== "ALL") {
      if (!categoryOf) return false;
      const markerCategory = categoryOf(row.key);
      if (markerCategory !== category) return false;
    }

    // 4. "Last measured": the newest reading's day, never an older one
    if (fromDay || toDay) {
      const takenDate = dayKeyOf(row.latest.takenAt);
      if (fromDay && takenDate < fromDay) return false;
      if (toDay && takenDate > toDay) return false;
    }

    return true;
  });
}

/**
 * The person's Labs sort (Settings > Labs) over the server's
 * most-recent-first order: `recentAsc` reverses, the alpha options sort by
 * analyte name (#43), and `manual` applies the persisted biomarker order
 * (legacy un-linked rows, which carry no biomarkerId, sort after the ordered
 * block). Under categories the same order holds inside each category. The
 * list has no sort control of its own; the saved one is the only one.
 */
export function sortMarkerRows(
  rows: readonly MarkerRow[],
  sortDir: ModuleSortDir,
  manualOrder?: readonly string[],
): MarkerRow[] {
  if (sortDir === "recentAsc") return [...rows].reverse();
  if (sortDir === "alphaAsc" || sortDir === "alphaDesc") {
    const dir = sortDir === "alphaAsc" ? 1 : -1;
    return [...rows].sort(
      (a, b) =>
        dir *
        a.analyte.localeCompare(b.analyte, undefined, { sensitivity: "base" }),
    );
  }
  if (sortDir === "manual" && manualOrder && manualOrder.length > 0) {
    return applyOrder(rows, manualOrder, (row) => row.biomarkerId ?? row.key);
  }
  return [...rows];
}
