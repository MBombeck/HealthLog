/**
 * v1.40 (#1024) — the course fields every medication read carries, as the
 * client consumes them. Server-resolved: render, never recompute.
 */
export interface MedicationCourseWire {
  id: string;
  /** `YYYY-MM-DD`, inclusive. */
  startsOn: string;
  /** `YYYY-MM-DD`, inclusive; null = open. */
  endsOn: string | null;
  status: "UPCOMING" | "CURRENT" | "ENDED";
  takenDoses: number;
  note: string | null;
}

export interface MedicationCourseFields {
  courses?: MedicationCourseWire[];
  courseCount?: number;
  previousCourseEndedOn?: string | null;
  canStartCourse?: boolean;
}

/**
 * The 1-based number of the course running or about to run, when the
 * medication has more than one; null otherwise (nothing to number).
 */
export function currentCourseNumber(
  fields: MedicationCourseFields,
): number | null {
  const courses = fields.courses ?? [];
  if (courses.length < 2) return null;
  const index = courses.findIndex((c) => c.status !== "ENDED");
  return index === -1 ? null : index + 1;
}
