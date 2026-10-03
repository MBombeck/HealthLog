import { describe, expect, it } from "vitest";

import {
  canStartCourse,
  courseFromWindow,
  courseStatusOn,
  dateOfDayKey,
  isInsideCourses,
  previousCourseEndedOn,
  projectCourseWindow,
  validateCourses,
  type CourseSpan,
} from "@/lib/medications/course-window";

const d = dateOfDayKey;
const course = (start: string, end: string | null): CourseSpan => ({
  startsOn: d(start),
  endsOn: end ? d(end) : null,
});

const MARCH = course("2026-03-01", "2026-03-07");
const JUNE = course("2026-06-10", "2026-06-16");

describe("projectCourseWindow", () => {
  it("is the latest course, whatever the input order", () => {
    expect(projectCourseWindow([JUNE, MARCH])).toEqual({
      startsOn: d("2026-06-10"),
      endsOn: d("2026-06-16"),
    });
  });

  it("is empty with no course (chronic since creation)", () => {
    expect(projectCourseWindow([])).toEqual({ startsOn: null, endsOn: null });
  });

  it.each([
    ["before the first course", "2026-02-20"],
    ["inside the first course", "2026-03-03"],
    ["between the courses", "2026-04-01"],
    ["inside the latest course", "2026-06-12"],
    ["after the latest course", "2026-08-01"],
  ])("matches the course a reader of today would pick, %s", (_label, today) => {
    // The written rule: the course containing today, else the next upcoming,
    // else the most recent ended. Under the invariant that is the latest.
    const courses = [MARCH, JUNE];
    if (validateCourses(courses, today, false) !== null) return;
    const containing = courses.find(
      (c) => courseStatusOn(c, today) === "CURRENT",
    );
    const upcoming = courses.find(
      (c) => courseStatusOn(c, today) === "UPCOMING",
    );
    const picked = containing ?? upcoming ?? courses[courses.length - 1];
    expect(projectCourseWindow(courses).startsOn).toEqual(picked.startsOn);
  });
});

describe("validateCourses", () => {
  it("accepts adjacent courses and refuses a shared day", () => {
    expect(
      validateCourses(
        [MARCH, course("2026-03-08", "2026-03-10")],
        "2026-04-01",
        false,
      ),
    ).toBeNull();
    expect(
      validateCourses(
        [MARCH, course("2026-03-07", "2026-03-10")],
        "2026-04-01",
        false,
      ),
    ).toBe("overlap");
  });

  it("refuses an open course that is not the latest", () => {
    expect(
      validateCourses([course("2026-01-01", null), JUNE], "2026-07-01", false),
    ).toBe("overlap");
  });

  it("refuses a second course queued behind one that has not ended", () => {
    // Today is inside March, and June is queued after it.
    expect(validateCourses([MARCH, JUNE], "2026-03-03", false)).toBe(
      "currentOpen",
    );
    expect(validateCourses([MARCH, JUNE], "2026-03-08", false)).toBeNull();
  });

  it("refuses an end before the start", () => {
    expect(
      validateCourses(
        [course("2026-03-07", "2026-03-01")],
        "2026-04-01",
        false,
      ),
    ).toBe("invalidRange");
  });

  it("refuses a second course on a one-time medication", () => {
    expect(validateCourses([MARCH], "2026-04-01", true)).toBeNull();
    expect(validateCourses([MARCH, JUNE], "2026-07-01", true)).toBe("oneShot");
  });
});

describe("courseStatusOn", () => {
  it("is inclusive at both ends", () => {
    expect(courseStatusOn(MARCH, "2026-02-28")).toBe("UPCOMING");
    expect(courseStatusOn(MARCH, "2026-03-01")).toBe("CURRENT");
    expect(courseStatusOn(MARCH, "2026-03-07")).toBe("CURRENT");
    expect(courseStatusOn(MARCH, "2026-03-08")).toBe("ENDED");
    expect(courseStatusOn(course("2026-03-01", null), "2027-01-01")).toBe(
      "CURRENT",
    );
  });
});

describe("isInsideCourses", () => {
  it("admits the course days and not the gap", () => {
    const courses = [MARCH, JUNE];
    expect(isInsideCourses("2026-03-01", courses)).toBe(true);
    expect(isInsideCourses("2026-03-07", courses)).toBe(true);
    expect(isInsideCourses("2026-03-08", courses)).toBe(false);
    expect(isInsideCourses("2026-06-16", courses)).toBe(true);
    expect(isInsideCourses("2026-06-17", courses)).toBe(false);
  });

  it("places no restriction without courses", () => {
    expect(isInsideCourses("2026-03-08", [])).toBe(true);
  });
});

describe("previousCourseEndedOn and canStartCourse", () => {
  it("names the end of the latest ended course", () => {
    expect(previousCourseEndedOn([MARCH, JUNE], "2026-06-12")).toEqual(
      d("2026-03-07"),
    );
    expect(previousCourseEndedOn([MARCH, JUNE], "2026-07-01")).toEqual(
      d("2026-06-16"),
    );
    expect(previousCourseEndedOn([MARCH], "2026-03-03")).toBeNull();
  });

  it("offers a new course only when every course has ended", () => {
    const base = { active: true, oneShot: false, todayKey: "2026-07-01" };
    expect(canStartCourse({ ...base, courses: [MARCH, JUNE] })).toBe(true);
    expect(
      canStartCourse({
        ...base,
        courses: [MARCH, JUNE],
        todayKey: "2026-06-12",
      }),
    ).toBe(false);
    // Chronic (no course) is running; a one-time or paused medication never.
    expect(canStartCourse({ ...base, courses: [] })).toBe(false);
    expect(canStartCourse({ ...base, oneShot: true, courses: [MARCH] })).toBe(
      false,
    );
    expect(canStartCourse({ ...base, active: false, courses: [MARCH] })).toBe(
      false,
    );
  });
});

describe("courseFromWindow (the backfill and restore rule)", () => {
  it("covers every window shape", () => {
    expect(
      courseFromWindow(d("2026-03-01"), d("2026-03-07"), "2026-02-10"),
    ).toEqual(course("2026-03-01", "2026-03-07"));
    expect(courseFromWindow(d("2026-03-01"), null, "2026-02-10")).toEqual(
      course("2026-03-01", null),
    );
    // Only an end: from the creation day on the person's clock.
    expect(courseFromWindow(null, d("2026-04-01"), "2026-02-11")).toEqual(
      course("2026-02-11", "2026-04-01"),
    );
    // A backdated end before the creation: from the end day.
    expect(courseFromWindow(null, d("2026-01-15"), "2026-02-11")).toEqual(
      course("2026-01-15", "2026-01-15"),
    );
    // Start after end: a one-day course on the end day, still ended.
    expect(
      courseFromWindow(d("2026-05-10"), d("2026-05-01"), "2026-02-11"),
    ).toEqual(course("2026-05-01", "2026-05-01"));
    expect(courseFromWindow(null, null, "2026-02-11")).toBeNull();
  });
});
