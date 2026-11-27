/**
 * "Last night", one rule for every reader: the morning, the digest and its
 * push, the sleep score's `fresh`, and every surface that reads them.
 *
 * The night is the latest one on record with a main sleep and time asleep
 * ({@link lastNightOnRecord}), filed under its wake day by the night
 * reconstruction (`wakeDayOf`: the zone of its last row, not the profile's).
 * It is last night when that wake day is the reader's today
 * ({@link isLastNight}). A daytime nap is no night, and a night that woke
 * yesterday is not last night however few hours ago it ended.
 *
 * Pure, and importable anywhere: no database, no cache.
 */

/** A night as the rule reads it: its wake day and its time asleep. */
export interface NightOnRecord {
  /** Wake-day key, `YYYY-MM-DD`. */
  night: string;
  asleepMinutes: number;
}

/**
 * The latest night of `nights` with time asleep and a main sleep
 * (`hasMainSleep`: the reconstruction's main session; a day whose only
 * sleep is a nap has none). Null when there is none.
 */
export function lastNightOnRecord<T extends NightOnRecord>(
  nights: readonly T[],
  hasMainSleep: (night: T) => boolean,
): T | null {
  let latest: T | null = null;
  for (const n of nights) {
    if (n.asleepMinutes <= 0 || !hasMainSleep(n)) continue;
    if (latest === null || n.night > latest.night) latest = n;
  }
  return latest;
}

/** Whether `night` is last night for a reader whose local day is `todayKey`. */
export function isLastNight(
  night: NightOnRecord | null,
  todayKey: string,
): boolean {
  return night !== null && night.night === todayKey && night.asleepMinutes > 0;
}

/** Last night as every surface shows it. */
export interface LastNight {
  /** Last night's duration, or null when it is not in. */
  sleep: { minutes: number; usualMinutes: number | null } | null;
  /** Sleep is expected, last night is not in and the morning is not final. */
  sleepPending: boolean;
  /** The latest night on record when last night is not in; never today. */
  latestNightDay: string | null;
}

/**
 * Last night from the latest night on record (`night`). The sentence, the
 * duration line, the ring, "not in yet" and the pending state all read this,
 * so none of them can disagree with another.
 */
export function resolveLastNight(args: {
  todayKey: string;
  sleepOn: boolean;
  sleepExpected: boolean;
  morningRefreshedToday: boolean;
  night: NightOnRecord | null;
  usualMinutes: number | null;
}): LastNight {
  if (!args.sleepOn) {
    return { sleep: null, sleepPending: false, latestNightDay: null };
  }
  const { night, todayKey } = args;
  const isIn = isLastNight(night, todayKey);
  return {
    sleep:
      isIn && night
        ? { minutes: night.asleepMinutes, usualMinutes: args.usualMinutes }
        : null,
    sleepPending: args.sleepExpected && !args.morningRefreshedToday && !isIn,
    latestNightDay:
      !isIn && night !== null && night.night !== todayKey ? night.night : null,
  };
}
