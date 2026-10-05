import { describe, expect, it } from "vitest";

import { computeSignalsOfDay } from "../signals-of-day";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Thirty days of pulse around 64 bpm, one reading a day at 08:50 local, the
 * newest one at `newest`. Enough history for a signal; the only question is
 * whether the newest reading is today's.
 */
function pulseUpTo(newest: Date) {
  const out: Array<{ value: number; measuredAt: Date }> = [];
  for (let d = 20; d >= 1; d -= 1) {
    out.push({
      value: 62 + (d % 5),
      measuredAt: new Date(newest.getTime() - d * DAY),
    });
  }
  out.push({ value: 98, measuredAt: newest });
  return out;
}

function signals(newest: Date, now: Date, tz: string) {
  const pulse = pulseUpTo(newest);
  return computeSignalsOfDay(
    (type) => (type === "PULSE" ? pulse : []),
    now.getTime(),
    tz,
  );
}

describe("signals of the day are about today", () => {
  it("drops a pulse last measured yesterday morning, read at 21:00", () => {
    // 2026-10-04 08:50 and 2026-10-05 21:00 in Berlin (UTC+2).
    const newest = new Date("2026-10-04T06:50:00Z");
    const now = new Date("2026-10-05T19:00:00Z");
    expect(signals(newest, now, "Europe/Berlin")).toEqual([]);
  });

  it("keeps a pulse measured this morning", () => {
    const newest = new Date("2026-10-05T06:50:00Z");
    const now = new Date("2026-10-05T19:00:00Z");
    const [signal] = signals(newest, now, "Europe/Berlin");
    expect(signal?.metric).toBe("pulse");
    expect(signal?.latestDaysAgo).toBe(0);
    // Whole beats, as pulse is shown everywhere else.
    expect(Number.isInteger(signal?.deltaVs30)).toBe(true);
    expect(Number.isInteger(signal?.avg30)).toBe(true);
  });

  it("treats 23:50 as yesterday at 00:10, and 00:05 as today", () => {
    const now = new Date("2026-10-05T22:10:00Z"); // 00:10 on the 6th in Berlin
    expect(
      signals(new Date("2026-10-05T21:50:00Z"), now, "Europe/Berlin"),
    ).toEqual([]);
    expect(
      signals(new Date("2026-10-05T22:05:00Z"), now, "Europe/Berlin")[0]
        ?.metric,
    ).toBe("pulse");
  });

  it("reads today in the reader's zone, not in UTC", () => {
    // 05:00 UTC is 22:00 the previous evening in Los Angeles; 18:00 UTC the
    // same calendar day in UTC, but the next one in Los Angeles.
    const newest = new Date("2026-10-05T05:00:00Z");
    const now = new Date("2026-10-05T18:00:00Z");
    expect(signals(newest, now, "UTC")[0]?.metric).toBe("pulse");
    expect(signals(newest, now, "America/Los_Angeles")).toEqual([]);
  });

  it("is quiet when there is nothing today, even on a sizeable deviation", () => {
    const newest = new Date(Date.UTC(2026, 9, 3, 8));
    const now = new Date(newest.getTime() + 2 * DAY);
    expect(signals(newest, now, "UTC")).toEqual([]);
  });
});
