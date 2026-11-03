import { RRule } from "rrule";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The DTSTART to hand the rrule library for a window that opens at `after`.
 *
 * `between()` iterates from DTSTART, not from the window, so a schedule
 * anchored at a medication created two years ago walked some 700 days on
 * every call, and the compliance read calls it many times over: about 4 ms
 * per rate, growing with the age of the medication. A DAILY or WEEKLY rule
 * repeats with a fixed period of `INTERVAL` days or weeks, so moving the
 * start forward by whole periods to just before the window leaves every
 * occurrence inside it where it was: the weekday, the week parity of an
 * every-other-week rule and the BYHOUR expansion all ride on the period.
 * A rule with COUNT keeps its anchor (the count runs from the first
 * occurrence), as does one with BYSETPOS (see below), and so does any other
 * frequency, whose period is not a fixed
 * number of days. The day before `after` is the latest safe start, because
 * a start the rule does not match is not an occurrence, and anything
 * between it and `after` is outside the window anyway.
 */
export function alignedRruleStart(
  rruleStr: string,
  anchor: Date,
  after: Date,
): Date {
  let options: ReturnType<typeof RRule.parseString>;
  try {
    options = RRule.parseString(rruleStr);
  } catch {
    return anchor;
  }
  if (options.count != null) return anchor;
  // BYSETPOS picks among a period's candidates, and the library drops the
  // candidates before DTSTART in the first period before it picks, so a
  // start moved into the middle of a week would choose a different day.
  if (options.bysetpos != null) return anchor;
  const interval = options.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) return anchor;
  const periodDays =
    options.freq === RRule.DAILY
      ? interval
      : options.freq === RRule.WEEKLY
        ? 7 * interval
        : null;
  if (periodDays === null) return anchor;
  const periodMs = periodDays * DAY_MS;
  const periods = Math.floor(
    (after.getTime() - DAY_MS - anchor.getTime()) / periodMs,
  );
  if (periods <= 0) return anchor;
  return new Date(anchor.getTime() + periods * periodMs);
}
