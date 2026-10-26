/**
 * #1280 — the course rows a medication read publishes answer "where does
 * today sit" the way the medication's own window does, including after a
 * move to a zone whose calendar day is behind the one the course ended on.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { buildCourseFields } from "@/lib/medications/courses";
import { courseStatusAt, dateOfDayKey } from "@/lib/medications/course-window";

describe("the published course status", () => {
  it("is ENDED for a course ended at an instant, read from further west", () => {
    const endedAt = new Date("2026-06-11T22:30:00.000Z");
    const row = {
      id: "course-1",
      startsOn: dateOfDayKey("2026-06-10"),
      endsOn: dateOfDayKey("2026-06-12"),
      endedAt,
      noteEncrypted: null,
    };
    const now = new Date("2026-06-11T23:30:00.000Z");
    const zone = "America/New_York";
    const fields = buildCourseFields(
      { active: true, oneShot: false },
      [row],
      new Map(),
      now,
      zone,
    );
    expect(courseStatusAt(row, now, zone)).toBe("ENDED");
    expect(fields.courses[0].status).toBe("ENDED");
    expect(fields.previousCourseEndedOn).toBe("2026-06-12");
    // Not offered: a course starting today (the 11th there) would begin
    // before the ended one's last day.
    expect(fields.canStartCourse).toBe(false);
  });
});
