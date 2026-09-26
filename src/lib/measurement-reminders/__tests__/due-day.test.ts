/**
 * The due line on a checkup is a CALENDAR-day statement. "Tomorrow" means the
 * next date on the wall calendar, not roughly twenty-four hours from now, and
 * most of the cases below are ones where those two answers differ.
 *
 * The calendar in question is the one the person's PROFILE is set to — the
 * same clock the date printed beside the phrase is rendered in. The last group
 * of tests pins that, because it was the second half of this defect: the
 * phrase used to follow the device while the date beside it followed the
 * profile, so a laptop set to another zone could show a date and a phrase that
 * contradicted each other.
 *
 * Every instant here carries an explicit offset, so the suite says the same
 * thing whatever zone the machine running it is set to — the CI box is on UTC
 * and a laptop is not.
 */
import { describe, it, expect } from "vitest";

import { isOverdueDue, relativeDueKey } from "../due-day";

/**
 * The profile zone under test. July is deliberate: no IANA zone shifts its
 * clocks mid-July, so a fixed offset stands for the whole month and building
 * 00:01 or 23:59 can never land on a skipped or repeated hour.
 */
const ZONE = "Europe/Berlin";
const ZONE_OFFSET = "+02:00";

const TODAY = { key: "measurementReminders.nextDue.today", days: 0 };
const TOMORROW = { key: "measurementReminders.nextDue.tomorrow", days: 1 };
const NONE = { key: "measurementReminders.nextDue.none", days: 0 };

// Fri 17th, Sat 18th, Sun 19th of July 2026.
const FRIDAY = 17;
const SATURDAY = 18;
const SUNDAY = 19;

const pad = (n: number) => String(n).padStart(2, "0");

/** A wall-clock time in {@link ZONE}, as the ISO string the API hands over. */
function zoned(day: number, hour: number, minute = 0): string {
  return `2026-07-${pad(day)}T${pad(hour)}:${pad(minute)}:00${ZONE_OFFSET}`;
}

/** The same wall clock as the epoch millis a component reads off `Date.now()`. */
function at(day: number, hour: number, minute = 0): number {
  return Date.parse(zoned(day, hour, minute));
}

describe("relativeDueKey", () => {
  it("still reads 'today' in the evening for a checkup that was due this morning", () => {
    expect(relativeDueKey(zoned(FRIDAY, 9), at(FRIDAY, 20), ZONE)).toEqual(
      TODAY,
    );
  });

  it("holds 'today' from first thing to last thing, either side of the due hour", () => {
    // Both ends of the same date sit more than twelve hours from the due time,
    // which is where a rolling-hours delta tips into the neighbouring day: it
    // would call the 07:00 checkup overdue by bedtime, and the 21:00 one
    // tomorrow at breakfast.
    expect(relativeDueKey(zoned(FRIDAY, 7), at(FRIDAY, 22), ZONE)).toEqual(
      TODAY,
    );
    expect(relativeDueKey(zoned(FRIDAY, 21), at(FRIDAY, 6), ZONE)).toEqual(
      TODAY,
    );
  });

  it("calls a Sunday 01:00 checkup two days out when read late on Friday", () => {
    // Twenty-six hours apart, so a rolling-hours delta rounds to one day and
    // says "tomorrow". Two dates separate them on the calendar.
    expect(relativeDueKey(zoned(SUNDAY, 1), at(FRIDAY, 23), ZONE)).toEqual({
      key: "measurementReminders.nextDue.inDays",
      days: 2,
    });
  });

  it("calls a Saturday 23:59 checkup tomorrow when read just after Friday midnight", () => {
    // Just under forty-eight hours apart, so a rolling-hours delta rounds to
    // two days. It is the very next date on the calendar.
    expect(
      relativeDueKey(zoned(SATURDAY, 23, 59), at(FRIDAY, 0, 1), ZONE),
    ).toEqual(TOMORROW);
  });

  it("calls a checkup from yesterday overdue since yesterday, however recent", () => {
    // Forty-five minutes in the past. It was still yesterday's checkup. Its
    // own phrase, because "overdue by 1 days" is what the counted form reads
    // as on the one day an open check-up is most likely to be looked at.
    expect(
      relativeDueKey(zoned(FRIDAY, 23, 30), at(SATURDAY, 0, 15), ZONE),
    ).toEqual({ key: "measurementReminders.overdueSinceYesterday", days: 1 });
  });

  it("counts the days for a checkup overdue longer than that", () => {
    expect(relativeDueKey(zoned(FRIDAY, 9), at(FRIDAY + 2, 10), ZONE)).toEqual({
      key: "measurementReminders.overdueByDays",
      days: 2,
    });
  });

  it("reads both overdue phrases as overdue, and nothing else", () => {
    const now = at(SATURDAY, 12);
    expect(isOverdueDue(relativeDueKey(zoned(FRIDAY, 9), now, ZONE))).toBe(
      true,
    );
    expect(isOverdueDue(relativeDueKey(zoned(FRIDAY - 3, 9), now, ZONE))).toBe(
      true,
    );
    expect(isOverdueDue(relativeDueKey(zoned(SATURDAY, 9), now, ZONE))).toBe(
      false,
    );
  });

  it("counts whole calendar days for a checkup further out", () => {
    expect(relativeDueKey(zoned(FRIDAY + 7, 6), at(FRIDAY, 22), ZONE)).toEqual({
      key: "measurementReminders.nextDue.inDays",
      days: 7,
    });
  });

  it("keeps a whole clock-change day as one day", () => {
    // The two days of the year that are not twenty-four hours long. On the
    // October day Berlin gains an hour, 01:00 and 23:00 sit twenty-three hours
    // apart; on the March day it loses one, 00:30 and 23:30 sit twenty-two
    // apart. Both are one calendar date, and on both an hour count rounds up
    // and calls the evening "tomorrow".
    expect(
      relativeDueKey(
        "2026-10-25T22:00:00Z", // 23:00 Berlin, after the clocks go back
        Date.parse("2026-10-25T00:00:00Z"), // 02:00 Berlin, before they do
        ZONE,
      ),
    ).toEqual(TODAY);
    expect(
      relativeDueKey(
        "2026-03-29T21:30:00Z", // 23:30 Berlin, after the clocks go forward
        Date.parse("2026-03-28T23:30:00Z"), // 00:30 Berlin, before they do
        ZONE,
      ),
    ).toEqual(TODAY);
  });

  it("says nothing is scheduled rather than crashing on a date it cannot read", () => {
    expect(relativeDueKey("not-a-date", at(FRIDAY, 12), ZONE)).toEqual(NONE);
  });

  it("says nothing is scheduled when there is no due date at all", () => {
    expect(relativeDueKey(null, at(FRIDAY, 12), ZONE)).toEqual(NONE);
  });
});

describe("relativeDueKey answers in the zone it is given", () => {
  // One instant, read from two profiles on opposite sides of midnight. At
  // 23:30 UTC on the 17th the checkup at 02:00 UTC on the 18th is tomorrow's;
  // in Auckland it is already the 18th for both, so it is today's. Asserting
  // BOTH in one test is what makes this bite: an implementation that ignores
  // the argument and reads the machine's own clock returns the same answer
  // twice, whatever zone that machine happens to be in.
  const NOW = Date.parse("2026-07-17T23:30:00Z");
  const DUE = "2026-07-18T02:00:00Z";

  it("gives two profiles either side of midnight two different answers", () => {
    expect(relativeDueKey(DUE, NOW, "UTC")).toEqual(TOMORROW);
    expect(relativeDueKey(DUE, NOW, "Pacific/Auckland")).toEqual(TODAY);
  });

  it("falls back to the printed date's zone, never the machine's, on a zone it cannot read", () => {
    // 22:30 UTC is already the 18th in Berlin, so Berlin says today and UTC
    // says tomorrow. A zone the profile mirror could not make sense of has to
    // land where the date beside it lands, which is Berlin.
    const now = Date.parse("2026-07-17T22:30:00Z");
    const due = "2026-07-18T00:30:00Z";

    expect(relativeDueKey(due, now, "Not/AZone")).toEqual(
      relativeDueKey(due, now, "Europe/Berlin"),
    );
    expect(relativeDueKey(due, now, "Not/AZone")).toEqual(TODAY);
    expect(relativeDueKey(due, now, "UTC")).toEqual(TOMORROW);
  });

  /**
   * The machine's own clock, moved under the function's feet. Whatever the
   * device is set to, the answer must not move — that is the whole difference
   * between reading the profile and reading the laptop. Asserting it this way
   * rather than by running the suite in a different zone means the property
   * holds on the CI box and on a laptop alike, and it stays proven if someone
   * reinstates a device-clock fallback for either the given zone or the
   * unreadable one.
   */
  const HOST_ZONES = ["UTC", "Pacific/Auckland", "America/Los_Angeles"];

  function underEachHostZone(fn: () => unknown): unknown[] {
    const original = process.env.TZ;
    try {
      return HOST_ZONES.map((hostZone) => {
        process.env.TZ = hostZone;
        return fn();
      });
    } finally {
      process.env.TZ = original;
    }
  }

  it("ignores the zone the machine itself is set to", () => {
    // 22:30 UTC: the 17th in Los Angeles, the 18th in Auckland and in Berlin.
    const now = Date.parse("2026-07-17T22:30:00Z");
    const due = "2026-07-18T00:30:00Z";

    expect(underEachHostZone(() => relativeDueKey(due, now, ZONE))).toEqual([
      TODAY,
      TODAY,
      TODAY,
    ]);
  });

  it("ignores the machine's zone even when the given one is unreadable", () => {
    const now = Date.parse("2026-07-17T22:30:00Z");
    const due = "2026-07-18T00:30:00Z";

    expect(
      underEachHostZone(() => relativeDueKey(due, now, "Not/AZone")),
    ).toEqual([TODAY, TODAY, TODAY]);
  });
});
