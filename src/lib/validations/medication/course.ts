import { z } from "zod/v4";

/**
 * v1.40 (#1024) — the bodies of `POST /api/medications/{id}/courses` and
 * `PATCH /api/medications/{id}/courses/{courseId}`. A course carries a
 * calendar span and an optional note; no schedule or dose of its own.
 */
const courseDate = z.iso.date().transform((s) => new Date(s));

const courseNote = z
  .string()
  .trim()
  .max(280, "Note must be at most 280 characters")
  .nullable();

export const createMedicationCourseSchema = z
  .object({
    startsOn: courseDate.describe(
      "First day of the course (ISO `YYYY-MM-DD`, inclusive, the person's calendar).",
    ),
    endsOn: courseDate
      .nullable()
      .optional()
      .describe(
        "Last day (inclusive). NULL or absent = open; only the latest course may be open.",
      ),
    note: courseNote
      .optional()
      .describe("Why this course, in the person's words. Encrypted at rest."),
  })
  .meta({
    id: "CreateMedicationCourseRequest",
    description:
      "v1.40 — start a course. Refused when it shares a day with another course (422 `medications.course.overlap`), when it would sit after a course that has not ended (422 `medications.course.currentOpen`), on a one-time medication that already has one (422 `medications.course.oneShot`), or when it ends before it starts (422 `medications.course.invalidRange`).",
  });

export const updateMedicationCourseSchema = z
  .object({
    startsOn: courseDate.optional(),
    endsOn: courseDate.nullable().optional(),
    note: courseNote.optional(),
  })
  .refine(
    (v) =>
      v.startsOn !== undefined ||
      v.endsOn !== undefined ||
      v.note !== undefined,
    "At least one field is required",
  )
  .meta({
    id: "UpdateMedicationCourseRequest",
    description:
      "v1.40 — edit a course field by field. Same refusals as the create.",
  });
