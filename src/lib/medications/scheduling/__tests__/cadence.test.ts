/**
 * v1.4.25 W19e — pure cadence helper tests.
 *
 * The cadence module is the contract the chart, the chips and the
 * /api/medications/[id]/cadence route all read. These tests pin:
 *   - slot expansion for daily, specific-weekday, and bi-weekly
 *     intervalWeeks=2 schedules
 *   - overnight-window slot has the correct end time
 *   - pairing claims the closest event and never double-counts
 *   - past unmatched slots are `missed`, future unmatched slots
 *     are `upcoming`, skipped intakes surface `skipped`
 *   - missedDoses() and computeNextDose() agree with the timeline
 */

import { describe, expect, it } from "vitest";
import {
  buildCadenceTimeline,
  computeNextDose,
  expandScheduleSlots,
  missedDoses,
  pairDoses,
  type ScheduleLike,
} from "../cadence";

function d(iso: string): Date {
  return new Date(iso);
}

describe("expandScheduleSlots", () => {
  it("emits a slot per day for a daily schedule with no recurrence", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    // 2025-06-02 (Mon) through 2025-06-06 (Fri).
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-02T00:00:00"),
      d("2025-06-07T00:00:00"),
    );
    expect(slots).toHaveLength(5);
  });

  it("respects daysOfWeek (Mon + Wed + Fri)", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: "1,3,5",
    };
    // 2025-06-02 (Mon) through 2025-06-08 (Sun)
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-02T00:00:00"),
      d("2025-06-09T00:00:00"),
    );
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.day.getDay()).sort()).toEqual([1, 3, 5]);
  });

  it("respects intervalWeeks=2 (every-other-week)", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: "i2;1", // Monday every 2 weeks
    };
    // Four-week window starting Monday 2025-06-02.
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-02T00:00:00"),
      d("2025-06-30T00:00:00"),
      d("2025-06-02T00:00:00"),
    );
    // Mondays in [06-02..06-30): 06-02, 06-09, 06-16, 06-23.
    // Every-other-week from anchor 06-02 -> 06-02, 06-16.
    expect(slots).toHaveLength(2);
    expect(slots[0].day.toDateString()).toBe(d("2025-06-02").toDateString());
    expect(slots[1].day.toDateString()).toBe(d("2025-06-16").toDateString());
  });

  it("handles overnight windows by pushing windowEnd to next day", () => {
    const sched: ScheduleLike = {
      windowStart: "23:00",
      windowEnd: "01:00",
      daysOfWeek: null,
    };
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-02T00:00:00"),
      d("2025-06-03T00:00:00"),
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].windowStart.getHours()).toBe(23);
    // End should be after the day's midnight.
    expect(slots[0].windowEnd.getTime() - slots[0].windowStart.getTime()).toBe(
      2 * 60 * 60 * 1000,
    );
  });

  it("returns empty when `to <= from`", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    expect(
      expandScheduleSlots(
        sched,
        0,
        d("2025-06-02T00:00:00"),
        d("2025-06-02T00:00:00"),
      ),
    ).toEqual([]);
  });

  it("skips weekdays outside the recurrence set", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: "0,6", // Sunday + Saturday
    };
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-02T00:00:00"),
      d("2025-06-09T00:00:00"),
    );
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.day.getDay()).sort()).toEqual([0, 6]);
  });
});

describe("pairDoses", () => {
  const sched: ScheduleLike = {
    windowStart: "08:00",
    windowEnd: "09:00",
    daysOfWeek: null,
  };
  const NOW = d("2025-06-10T12:00:00");

  it("marks past slots with no matching event as `missed`", () => {
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-08T00:00:00"),
      d("2025-06-09T00:00:00"),
    );
    const paired = pairDoses(slots, [], NOW);
    expect(paired).toHaveLength(1);
    expect(paired[0].status).toBe("missed");
  });

  it("marks future slots with no matching event as `upcoming`", () => {
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-11T00:00:00"),
      d("2025-06-12T00:00:00"),
    );
    const paired = pairDoses(slots, [], NOW);
    expect(paired).toHaveLength(1);
    expect(paired[0].status).toBe("upcoming");
  });

  it("pairs an intake event taken inside the +/- 12-hour radius", () => {
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-09T00:00:00"),
      d("2025-06-10T00:00:00"),
    );
    const events = [
      {
        scheduledFor: d("2025-06-09T08:30:00"),
        takenAt: d("2025-06-09T08:45:00"),
        skipped: false,
      },
    ];
    const paired = pairDoses(slots, events, NOW);
    expect(paired[0].status).toBe("taken");
    expect(paired[0].match?.takenAt).toEqual(events[0].takenAt);
  });

  it("marks a paired skipped event as `skipped`", () => {
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-09T00:00:00"),
      d("2025-06-10T00:00:00"),
    );
    const events = [
      {
        scheduledFor: d("2025-06-09T08:30:00"),
        takenAt: null,
        skipped: true,
      },
    ];
    const paired = pairDoses(slots, events, NOW);
    expect(paired[0].status).toBe("skipped");
  });

  it("does not match an event that is more than 12 hours from any slot", () => {
    const slots = expandScheduleSlots(
      sched,
      0,
      d("2025-06-09T00:00:00"),
      d("2025-06-10T00:00:00"),
    );
    const events = [
      {
        scheduledFor: d("2025-06-09T08:30:00"),
        takenAt: d("2025-06-09T22:00:00"), // > 12 h after window centre
        skipped: false,
      },
    ];
    const paired = pairDoses(slots, events, NOW);
    expect(paired[0].status).toBe("missed");
  });

  it("never double-claims a single event across two close slots", () => {
    const dailySched = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    const slots = expandScheduleSlots(
      dailySched,
      0,
      d("2025-06-08T00:00:00"),
      d("2025-06-10T00:00:00"),
    );
    expect(slots).toHaveLength(2);
    // One event close to the first slot
    const events = [
      {
        scheduledFor: d("2025-06-08T08:30:00"),
        takenAt: d("2025-06-08T08:35:00"),
        skipped: false,
      },
    ];
    const paired = pairDoses(slots, events, NOW);
    expect(paired[0].status).toBe("taken");
    // Second slot must be missed, not also taken.
    expect(paired[1].status).toBe("missed");
  });
});

describe("buildCadenceTimeline", () => {
  it("returns slots in chronological order across the window", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    const NOW = d("2025-06-10T12:00:00");
    const timeline = buildCadenceTimeline([sched], [], NOW, 5);
    expect(timeline.length).toBeGreaterThan(0);
    for (let i = 1; i < timeline.length; i++) {
      expect(
        timeline[i].windowStart.getTime() -
          timeline[i - 1].windowStart.getTime(),
      ).toBeGreaterThan(0);
    }
  });

  it("returns empty for a paused schedule list", () => {
    const NOW = d("2025-06-10T12:00:00");
    expect(buildCadenceTimeline([], [], NOW, 30)).toEqual([]);
  });
});

describe("computeNextDose", () => {
  it("returns the earliest future slot across all schedules", () => {
    const morning: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    const evening: ScheduleLike = {
      windowStart: "20:00",
      windowEnd: "21:00",
      daysOfWeek: null,
    };
    const NOW = d("2025-06-10T12:00:00");
    const next = computeNextDose([morning, evening], NOW, 7);
    expect(next).not.toBeNull();
    expect(next!.windowStart.getHours()).toBe(20);
    expect(next!.windowStart.toDateString()).toBe(NOW.toDateString());
  });

  it("returns null when no schedules expand within the lookahead", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: "i4;1", // every 4 weeks Monday — phase will mostly miss
    };
    // 1-day lookahead from a Tuesday → no slot.
    const NOW = d("2025-06-10T12:00:00");
    const next = computeNextDose([sched], NOW, 1);
    expect(next).toBeNull();
  });
});

describe("missedDoses", () => {
  it("agrees with the timeline's `missed`-status count", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    const NOW = d("2025-06-10T12:00:00");
    // 7-day window, 5 days had no event (missed), 2 days had an event.
    const events = [
      {
        scheduledFor: d("2025-06-08T08:30:00"),
        takenAt: d("2025-06-08T08:35:00"),
        skipped: false,
      },
      {
        scheduledFor: d("2025-06-09T08:30:00"),
        takenAt: d("2025-06-09T08:35:00"),
        skipped: false,
      },
    ];
    expect(missedDoses([sched], events, NOW, 7)).toBeGreaterThan(0);
    const tl = buildCadenceTimeline([sched], events, NOW, 7);
    expect(missedDoses([sched], events, NOW, 7)).toBe(
      tl.filter((p) => p.status === "missed").length,
    );
  });

  it("returns 0 when every past slot has a matching intake", () => {
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    const NOW = d("2025-06-10T12:00:00");
    const events: Array<{
      scheduledFor: Date;
      takenAt: Date | null;
      skipped: boolean;
    }> = [];
    // Window: NOW - 7d = 2025-06-03T12:00 → slots: 04, 05, 06, 07, 08, 09, 10
    for (let day = 4; day <= 10; day++) {
      const dd = String(day).padStart(2, "0");
      events.push({
        scheduledFor: d(`2025-06-${dd}T08:30:00`),
        takenAt: d(`2025-06-${dd}T08:35:00`),
        skipped: false,
      });
    }
    expect(missedDoses([sched], events, NOW, 7)).toBe(0);
  });
});
