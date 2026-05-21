import { describe, expect, it } from "vitest";
import {
  expandTodayIntakes,
  parseScheduleRecurrence,
  serializeScheduleRecurrence,
  type TodayExpandableSchedule,
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

describe("expandTodayIntakes", () => {
  // 2026-05-21 is a Thursday → weekday 4. Pin a reference instant
  // safely inside the Europe/Berlin day so every test below shares
  // the same "today" anchor regardless of the host clock.
  const REFERENCE = new Date("2026-05-21T12:00:00Z");
  const TZ = "Europe/Berlin";

  const daily: TodayExpandableSchedule = {
    id: "sched-daily",
    medicationId: "med-daily",
    windowStart: "07:00",
    windowEnd: "09:00",
    daysOfWeek: null,
  };

  it("emits a slot for a schedule with daysOfWeek=null (every day)", () => {
    // This is the bug the W-SERVER-FIX patch addresses: the operator's
    // Ramipril (Morgens) + Metformin (Abends) both ship `daysOfWeek:
    // null` in the DB ("every day" per the schema annotation) and the
    // today-intake endpoint returned `[]`. With the fix, the projector
    // emits one slot per schedule.
    const slots = expandTodayIntakes([daily], REFERENCE, TZ);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      scheduleId: "sched-daily",
      medicationId: "med-daily",
    });
  });

  it('treats daysOfWeek="" (empty string) as every day', () => {
    const slots = expandTodayIntakes(
      [{ ...daily, daysOfWeek: "" }],
      REFERENCE,
      TZ,
    );
    expect(slots).toHaveLength(1);
  });

  it("treats all-seven-days (0..6) as every day", () => {
    const slots = expandTodayIntakes(
      [{ ...daily, daysOfWeek: "0,1,2,3,4,5,6" }],
      REFERENCE,
      TZ,
    );
    expect(slots).toHaveLength(1);
  });

  it("respects an explicit weekday filter that excludes today", () => {
    // Thursday is weekday 4; "1" = Monday only → no slot today.
    const slots = expandTodayIntakes(
      [{ ...daily, daysOfWeek: "1" }],
      REFERENCE,
      TZ,
    );
    expect(slots).toHaveLength(0);
  });

  it("includes a slot when the explicit weekday filter contains today", () => {
    // Thursday = weekday 4; allow {2,4} → today matches.
    const slots = expandTodayIntakes(
      [{ ...daily, daysOfWeek: "2,4" }],
      REFERENCE,
      TZ,
    );
    expect(slots).toHaveLength(1);
  });

  it("emits slots for two daysOfWeek-null schedules (Ramipril + Metformin shape)", () => {
    // The operator's real fixture: morning + evening daily meds.
    const morning: TodayExpandableSchedule = {
      id: "sched-ramipril",
      medicationId: "med-ramipril",
      windowStart: "07:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    const evening: TodayExpandableSchedule = {
      id: "sched-metformin",
      medicationId: "med-metformin",
      windowStart: "19:00",
      windowEnd: "21:00",
      daysOfWeek: null,
    };
    const slots = expandTodayIntakes([morning, evening], REFERENCE, TZ);
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.medicationId).sort()).toEqual([
      "med-metformin",
      "med-ramipril",
    ]);
  });

  it("anchors scheduledFor at the schedule's windowStart in the user tz", () => {
    const slots = expandTodayIntakes([daily], REFERENCE, TZ);
    expect(slots).toHaveLength(1);
    const iso = slots[0].scheduledFor.toISOString();
    // 07:00 Europe/Berlin on 2026-05-21 (DST in effect → UTC+2) → 05:00Z.
    expect(iso).toBe("2026-05-21T05:00:00.000Z");
  });

  it("skips multi-week cadence (handled by the reminder worker)", () => {
    const biweekly: TodayExpandableSchedule = {
      ...daily,
      daysOfWeek: "i2;1,3,5",
    };
    expect(expandTodayIntakes([biweekly], REFERENCE, TZ)).toEqual([]);
  });
});
