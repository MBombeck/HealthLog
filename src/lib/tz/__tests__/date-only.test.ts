import { describe, expect, it } from "vitest";
import {
  ageInYears,
  dateOfBirthForStorage,
  dateOfBirthKey,
  isNoonUtcAnchor,
  dateOnlyAtNoonUtc,
  dateOnlyKey,
  dateOnlyWindow,
  dayKeyAsUtcMidnight,
  isCalendarDateKey,
  isDateOnlyKey,
  statedDateKey,
} from "../date-only";
import { daysBetweenDateKeys, weekdayOfDateKey } from "../format";

describe("date-only values", () => {
  it("stores a date at noon UTC and reads it back", () => {
    const stored = dateOnlyAtNoonUtc("2026-06-10");
    expect(stored.toISOString()).toBe("2026-06-10T12:00:00.000Z");
    expect(dateOnlyKey(stored)).toBe("2026-06-10");
  });

  it("reads a row stored at UTC midnight as the same date", () => {
    expect(dateOnlyKey(dayKeyAsUtcMidnight("2026-06-10"))).toBe("2026-06-10");
  });

  it("tells a shape from a real calendar date", () => {
    expect(isDateOnlyKey("2026-02-30")).toBe(true);
    expect(isCalendarDateKey("2026-02-30")).toBe(false);
    expect(isCalendarDateKey("2028-02-29")).toBe(true);
    expect(isCalendarDateKey("2026-6-1")).toBe(false);
  });

  it("reads the date a string states", () => {
    expect(statedDateKey("2026-06-10")).toBe("2026-06-10");
    expect(statedDateKey("2026-06-10T23:30:00-07:00")).toBe("2026-06-10");
    expect(statedDateKey(" 2026-06-10 ")).toBe("2026-06-10");
    expect(statedDateKey("June 10, 2026")).toBe("2026-06-10");
    expect(statedDateKey("2026-02-30")).toBeNull();
    expect(statedDateKey("not a date")).toBeNull();
  });
});

describe("calendar key arithmetic", () => {
  it("counts whole days between keys across a DST change", () => {
    expect(daysBetweenDateKeys("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetweenDateKeys("2026-03-30", "2026-03-28")).toBe(-2);
    expect(daysBetweenDateKeys("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetweenDateKeys("bad", "2026-01-01")).toBeNaN();
  });

  it("names the weekday of a key", () => {
    expect(weekdayOfDateKey("2026-10-01")).toBe(4); // Thursday
    expect(weekdayOfDateKey("2026-10-04")).toBe(0); // Sunday
  });
});

describe("isNoonUtcAnchor", () => {
  it("recognises the stored anchor of a date-only value and nothing else", () => {
    expect(isNoonUtcAnchor(dateOnlyAtNoonUtc("2025-10-04"))).toBe(true);
    expect(isNoonUtcAnchor(new Date("2025-10-04T12:00:01.000Z"))).toBe(false);
    expect(isNoonUtcAnchor(new Date("2025-10-04T00:00:00.000Z"))).toBe(false);
    expect(isNoonUtcAnchor(new Date("2025-10-04T20:30:00.000Z"))).toBe(false);
  });
});

describe("date of birth", () => {
  // UTC-10 and UTC+13 the year round.
  const WEST = "Pacific/Honolulu";
  const EAST = "Pacific/Tongatapu";

  it("reads a date-only anchor by its date in every zone", () => {
    for (const zone of [WEST, EAST, "Europe/Berlin"]) {
      expect(dateOfBirthKey(new Date("2012-05-14T00:00:00.000Z"), zone)).toBe(
        "2012-05-14",
      );
      expect(dateOfBirthKey(new Date("2012-05-14T12:00:00.000Z"), zone)).toBe(
        "2012-05-14",
      );
    }
  });

  it("reads an instant from the iOS app as its date in the owner's zone", () => {
    // 14 May picked at 20:00 in Honolulu, and at 09:30 in Nuku'alofa.
    expect(dateOfBirthKey(new Date("2012-05-15T06:00:00.000Z"), WEST)).toBe(
      "2012-05-14",
    );
    expect(dateOfBirthKey(new Date("2012-05-13T20:30:00.000Z"), EAST)).toBe(
      "2012-05-14",
    );
  });

  it("stores a typed date and an iOS instant as the same calendar date", () => {
    const noon = "2012-05-14T12:00:00.000Z";
    expect(dateOfBirthForStorage("2012-05-14", WEST)?.toISOString()).toBe(noon);
    expect(
      dateOfBirthForStorage("2012-05-15T06:00:00.000Z", WEST)?.toISOString(),
    ).toBe(noon);
    expect(
      dateOfBirthForStorage("2012-05-13T20:30:00+00:00", EAST)?.toISOString(),
    ).toBe(noon);
  });

  it("keeps a stored value that comes back unchanged", () => {
    for (const echoed of [
      "2012-05-14T00:00:00.000Z",
      "2012-05-14T12:00:00.000Z",
    ]) {
      expect(dateOfBirthForStorage(echoed, WEST)?.toISOString()).toBe(
        "2012-05-14T12:00:00.000Z",
      );
    }
  });

  it("stores nothing for a string that names no date", () => {
    expect(dateOfBirthForStorage("2012-02-30", WEST)).toBeNull();
    expect(dateOfBirthForStorage("not a date", WEST)).toBeNull();
  });

  it("counts the age from the birthday on the owner's calendar", () => {
    const iosEntry = new Date("2012-05-13T20:30:00.000Z"); // 14 May in EAST
    expect(
      ageInYears(iosEntry, EAST, new Date("2026-05-13T10:59:00.000Z")),
    ).toBe(13);
    // 00:00 on 14 May in Nuku'alofa.
    expect(
      ageInYears(iosEntry, EAST, new Date("2026-05-13T11:00:00.000Z")),
    ).toBe(14);
    expect(
      ageInYears(
        new Date("2012-05-14T00:00:00.000Z"),
        WEST,
        new Date("2026-05-14T09:59:00.000Z"),
      ),
    ).toBe(13);
    // 00:00 on 14 May in Honolulu.
    expect(
      ageInYears(
        new Date("2012-05-14T00:00:00.000Z"),
        WEST,
        new Date("2026-05-14T10:00:00.000Z"),
      ),
    ).toBe(14);
  });
});

describe("dateOnlyWindow", () => {
  it("spans UTC midnight to the next UTC midnight, both days included", () => {
    expect(dateOnlyWindow("2026-11-11")).toEqual({
      gte: new Date("2026-11-11T00:00:00.000Z"),
      lt: new Date("2026-11-12T00:00:00.000Z"),
    });
    expect(dateOnlyWindow("2026-12-31", "2027-01-01").lt).toEqual(
      new Date("2027-01-02T00:00:00.000Z"),
    );
  });
});
