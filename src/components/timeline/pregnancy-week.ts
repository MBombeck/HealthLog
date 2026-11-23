/**
 * The pregnancy week a timeline day falls in (v1.49).
 *
 * The cycle lane carries the pregnancy as a `pregnancy` span from its first
 * day (the server places it, `src/lib/cycle/pregnancy.ts`). A value point
 * inside that span names the week beside its date, so a blood pressure or a
 * weight reads in the pregnancy's own frame. Completed weeks, counted from
 * the span's first day; nothing about what the week means.
 */
import { dayDiff } from "@/lib/cycle/day-math";
import type { TimelineItem } from "@/lib/day/contract";

export interface PregnancyStretch {
  start: string;
  /** Last day, or null while ongoing. */
  end: string | null;
}

/** The pregnancy spans among a lane's items. */
export function pregnancyStretches(
  items: readonly TimelineItem[],
): PregnancyStretch[] {
  return items
    .filter((i) => i.kind === "pregnancy")
    .map((i) => ({ start: i.start, end: i.open ? null : i.end }));
}

/** Completed weeks on `day`, or null outside every stretch. */
export function pregnancyWeekOn(
  stretches: readonly PregnancyStretch[],
  day: string,
): number | null {
  for (const s of stretches) {
    if (day < s.start) continue;
    if (s.end !== null && day > s.end) continue;
    return Math.floor(dayDiff(day, s.start) / 7);
  }
  return null;
}
