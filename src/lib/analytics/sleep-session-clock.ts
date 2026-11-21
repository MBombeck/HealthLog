/**
 * The clock side of a sleep session: which local day it is filed under, where
 * its midpoint falls on the sleeper's wall clock, and whether that makes it a
 * nap. Split out of `sleep-night.ts`, which re-exports the public names.
 *
 * A session is read in the zone of its last-ending row when that row carries
 * one (iOS #181: a night slept abroad), in the profile zone otherwise.
 */
import { readingDayKey, readingZone } from "@/lib/tz/reading-zone";
import { wallClockInTz } from "@/lib/tz/wall-clock";

import type { SleepStageRow } from "./sleep-night";

/**
 * Below this much asleep time a session can be a nap. Three hours is where
 * wearables draw the line between a nap and a main sleep (Oura types a
 * period `long_sleep` from three hours on).
 */
export const MAIN_SLEEP_MIN_MINUTES = 180;

/**
 * The night window, in local minutes-of-day: a session whose midpoint falls
 * from 20:00 to 10:00 is night sleep however short it is. Wide enough for a
 * late chronotype (asleep 04:00 to 12:00 has its midpoint at 08:00) and for
 * an early one, and clear of the afternoon where naps sit.
 */
export const NIGHT_WINDOW_START_MINUTES = 20 * 60;
export const NIGHT_WINDOW_END_MINUTES = 10 * 60;

/**
 * True for a session that is a nap rather than a main sleep: short (under
 * `MAIN_SLEEP_MIN_MINUTES` asleep) AND centred in the daytime. A short night
 * is still the night (insomnia, a newborn, split sleep); a long daytime sleep
 * (after a night shift) is still a main sleep. The one nap rule: the nap
 * convention, the sleep score's midpoint and every list read it. Pure.
 */
export function isDaytimeNap(
  asleepMinutes: number,
  midpointMinutes: number,
): boolean {
  if (asleepMinutes >= MAIN_SLEEP_MIN_MINUTES) return false;
  const atNight =
    midpointMinutes >= NIGHT_WINDOW_START_MINUTES ||
    midpointMinutes < NIGHT_WINDOW_END_MINUTES;
  return !atNight;
}

/**
 * The centre of a session's asleep span as local minutes-of-day: its wake
 * instant minus half its asleep minutes, read on the sleeper's wall clock.
 */
export function asleepMidpointMinutes(
  end: Date,
  asleepMinutes: number,
  tz: string,
): number {
  const mid = new Date(end.getTime() - (asleepMinutes / 2) * 60_000);
  if (tz === "UTC") return mid.getUTCHours() * 60 + mid.getUTCMinutes();
  const { hour, minute } = wallClockInTz(mid, tz);
  return hour * 60 + minute;
}

/**
 * The wake day a session is filed under: the local day its last row ends on,
 * over every writer in the session. One rule for every reader, the SQL page
 * cut of the sleep list included, which sees every writer and cannot know the
 * winning one. Filing by the winner alone named a different day whenever a
 * losing writer's in-bed span ran past midnight after the winner stopped, and
 * the list and the night view then disagreed about which day the night was.
 */
export function wakeDayOf(rows: readonly SleepStageRow[], tz: string): string {
  let last = rows[0];
  for (const r of rows)
    if (r.measuredAt.getTime() > last.measuredAt.getTime()) last = r;
  return readingDayKey(last.measuredAt, last.timeZone, tz);
}

/**
 * The zone a session is read in: the zone of its last-ending row when that
 * row carries one (a night slept abroad), the profile zone otherwise. The
 * same row `wakeDayOf` files the session by, so the day and the clock agree.
 */
export function sessionZoneOf(
  rows: readonly SleepStageRow[],
  tz: string,
): string {
  let last = rows[0];
  for (const r of rows)
    if (r.measuredAt.getTime() > last.measuredAt.getTime()) last = r;
  return readingZone(last?.timeZone, tz);
}
