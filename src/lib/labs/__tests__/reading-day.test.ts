import { describe, expect, it } from "vitest";
import {
  isLabDateOnly,
  labReadingDay,
  labReadingDaySearchRange,
} from "../reading-day";

describe("isLabDateOnly", () => {
  it("knows both date-only anchors and nothing else", () => {
    expect(isLabDateOnly("2026-06-10T12:00:00.000Z")).toBe(true);
    // Rows written before the noon anchor sit at UTC midnight. The client
    // once checked noon only and dated these a day early west of UTC.
    expect(isLabDateOnly("2026-06-10T00:00:00.000Z")).toBe(true);
    expect(isLabDateOnly("2026-06-10T12:00:01.000Z")).toBe(false);
    expect(isLabDateOnly(new Date("2026-06-10T07:30:00.000Z"))).toBe(false);
  });
});

describe("labReadingDay", () => {
  it("reads a date-only reading as its stated date in every zone", () => {
    const noon = new Date("2026-06-10T12:00:00.000Z");
    const legacyMidnight = new Date("2026-06-10T00:00:00.000Z");
    for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
      expect(labReadingDay(noon, tz)).toBe("2026-06-10");
      expect(labReadingDay(legacyMidnight, tz)).toBe("2026-06-10");
    }
  });

  it("accepts the ISO string and epoch forms the client holds", () => {
    expect(labReadingDay("2026-06-10T00:00:00.000Z", "America/New_York")).toBe(
      "2026-06-10",
    );
    expect(
      labReadingDay(
        Date.parse("2026-09-01T12:00:00.000Z"),
        "Pacific/Kiritimati",
      ),
    ).toBe("2026-09-01");
    expect(
      labReadingDay("2026-09-01T12:00:01.000Z", "Pacific/Kiritimati"),
    ).toBe("2026-09-02");
  });

  it("reads a hand-entered instant on the user's own day", () => {
    const draw = new Date("2026-06-09T23:00:00.000Z"); // 08:00 on the 10th in Tokyo
    expect(labReadingDay(draw, "Asia/Tokyo")).toBe("2026-06-10");
    expect(labReadingDay(draw, "America/Los_Angeles")).toBe("2026-06-09");
  });

  it("searches a range that holds the day's readings in any zone", () => {
    const range = labReadingDaySearchRange("2026-06-10");
    const kiritimatiMorning = new Date("2026-06-09T10:30:00.000Z"); // 00:30 on the 10th at UTC+14
    const utcMinus12Late = new Date("2026-06-11T10:30:00.000Z"); // 22:30 on the 10th at UTC-12
    expect(kiritimatiMorning >= range.gte && kiritimatiMorning < range.lt).toBe(
      true,
    );
    expect(utcMinus12Late >= range.gte && utcMinus12Late < range.lt).toBe(true);
  });
});
