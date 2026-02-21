import { describe, expect, it } from "vitest";
import {
  parseScheduleRecurrence,
  serializeScheduleRecurrence,
} from "@/lib/medication-schedule";

describe("medication schedule recurrence", () => {
  it("parses default recurrence from empty values", () => {
    expect(parseScheduleRecurrence(null)).toEqual({
      daysOfWeek: [],
      intervalWeeks: 1,
    });
    expect(parseScheduleRecurrence("")).toEqual({
      daysOfWeek: [],
      intervalWeeks: 1,
    });
  });

  it("parses legacy day-only CSV", () => {
    expect(parseScheduleRecurrence("1,3,5")).toEqual({
      daysOfWeek: [1, 3, 5],
      intervalWeeks: 1,
    });
  });

  it("parses encoded interval + day format", () => {
    expect(parseScheduleRecurrence("i3;1,3,5")).toEqual({
      daysOfWeek: [1, 3, 5],
      intervalWeeks: 3,
    });
  });

  it("normalizes invalid encoded values", () => {
    expect(parseScheduleRecurrence("i9;3,3,10,-1,2")).toEqual({
      daysOfWeek: [2, 3],
      intervalWeeks: 1,
    });
  });

  it("serializes defaults and custom recurrences", () => {
    expect(
      serializeScheduleRecurrence({ daysOfWeek: [], intervalWeeks: 1 }),
    ).toBeNull();
    expect(
      serializeScheduleRecurrence({ daysOfWeek: [1, 3, 5], intervalWeeks: 1 }),
    ).toBe("1,3,5");
    expect(
      serializeScheduleRecurrence({ daysOfWeek: [1, 3], intervalWeeks: 2 }),
    ).toBe("i2;1,3");
    expect(
      serializeScheduleRecurrence({ daysOfWeek: [], intervalWeeks: 4 }),
    ).toBe("i4;");
  });
});
