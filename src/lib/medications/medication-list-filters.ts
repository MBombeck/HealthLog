/**
 * Medication list filter predicates and types.
 *
 * Combines:
 * 1. Text search: case-insensitive trimmed name substring
 * 2. Category selection: matching category key or "ALL"
 * 3. Treatment period (date range):
 *    - Date-only inclusive overlap with any course independently
 *    - Gaps between courses do not match
 *    - Null end is open (+Infinity)
 *    - Legacy no-course rows use startsOn/endsOn; known end only has open start (-Infinity);
 *      with both absent, an active medication runs from the day it was created
 *      (`createdOn`, a day key on the account's clock) with an open end, and any
 *      other one is excluded only with an active date filter
 *    - Reversed dates (from > to) show validation and ignore the date predicate while invalid
 *    - Browser-timezone immune date comparison (lexicographical ISO calendar day strings)
 */

import { ALL_MEDICATION_CATEGORIES } from "@/lib/medications/category-filter";

export interface MedicationFilterableCourse {
  startsOn?: string | null;
  endsOn?: string | null;
}

export interface MedicationFilterable {
  name: string;
  category: string;
  startsOn?: string | null;
  endsOn?: string | null;
  courses?: MedicationFilterableCourse[];
  /** Whether the medication is taken now; a dateless active one is ongoing. */
  active?: boolean;
  /** The day it was created (`YYYY-MM-DD`, the account's zone). */
  createdOn?: string | null;
}

export interface MedicationListFilters {
  /** Case-insensitive substring search over medication name. */
  q?: string;
  /** Category key (matches category) or "ALL". */
  category?: string;
  /** Treatment period bounds (`YYYY-MM-DD`). */
  fromDay?: string;
  toDay?: string;
}

/**
 * Check whether a medication matches the combined filters.
 */
export function matchesMedicationFilters(
  med: MedicationFilterable,
  filters: MedicationListFilters,
): boolean {
  // 1. Text search (case-insensitive trimmed substring)
  const trimmedQ = filters.q?.trim();
  if (trimmedQ) {
    const query = trimmedQ.toLowerCase();
    if (!med.name.toLowerCase().includes(query)) {
      return false;
    }
  }

  // 2. Category filter
  if (filters.category && filters.category !== ALL_MEDICATION_CATEGORIES) {
    if (med.category !== filters.category) {
      return false;
    }
  }

  // 3. Treatment period date range
  const from = filters.fromDay?.trim() || undefined;
  const to = filters.toDay?.trim() || undefined;

  // If dates are reversed, ignore the date predicate while invalid
  const isReversed = Boolean(from && to && from > to);

  if ((from || to) && !isReversed) {
    if (med.courses && med.courses.length > 0) {
      // Test overlap with any course independently (gaps do not match)
      const overlapsAnyCourse = med.courses.some((course) => {
        const cStart = course.startsOn ? course.startsOn.slice(0, 10) : null;
        const cEnd = course.endsOn ? course.endsOn.slice(0, 10) : null; // null = open end
        // Defensively handle dateless course: does not match an active date filter
        if (cStart === null && cEnd === null) {
          return false;
        }
        const satisfiesFrom = !from || cEnd === null || cEnd >= from;
        const satisfiesTo = !to || cStart === null || cStart <= to;
        return satisfiesFrom && satisfiesTo;
      });
      if (!overlapsAnyCourse) {
        return false;
      }
    } else {
      // Legacy no-course rows
      const mStart = med.startsOn ? med.startsOn.slice(0, 10) : null;
      const mEnd = med.endsOn ? med.endsOn.slice(0, 10) : null;

      // Both absent: an active medication taken continuously since it was
      // created runs from that day on; anything else has no known period.
      if (mStart === null && mEnd === null) {
        if (med.active !== true || !med.createdOn) return false;
        return !to || med.createdOn.slice(0, 10) <= to;
      }

      // Known end only has open start (-Infinity)
      // Known start only has open end (+Infinity)
      const satisfiesFrom = !from || mEnd === null || mEnd >= from;
      const satisfiesTo = !to || mStart === null || mStart <= to;
      if (!satisfiesFrom || !satisfiesTo) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Filter an array of medications by the combined filter criteria.
 */
export function filterMedications<T extends MedicationFilterable>(
  medications: readonly T[],
  filters: MedicationListFilters,
): T[] {
  return medications.filter((med) => matchesMedicationFilters(med, filters));
}
