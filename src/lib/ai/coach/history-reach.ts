/**
 * How far back the Coach may look: the user's `coachPrefs.defaultWindow`
 * read as a LIMIT, not as a starting point.
 *
 * Before it became a limit, the saved window only seeded the snapshot and the default of
 * each tool call; every tool accepted its own `window` up to `allTime`, the
 * availability probe reported out-of-window history with counts and means,
 * and several snapshot blocks read fixed windows (labs 12 months, glucose
 * panel 30 days, correlations 180 days) whatever the setting said. The
 * setting is now enforced everywhere the Coach reads: the snapshot, every
 * tool, the probe, the inventory and the fixed windows. Each reader takes a
 * `CoachHistoryReach` and either clamps its window to it (`clampWindow`,
 * `capDays`) or leaves its block out when the block's own fixed window does
 * not fit inside it (`fitsReach`). A block is never computed over a silently
 * shortened window that would make it disagree with the page that shows it.
 *
 * What is NOT history and stays visible under any limit: the profile (age,
 * sex, height), the current medication plan, an illness episode that is still
 * ongoing, upcoming appointments, and what the person told the Coach (facts,
 * plans, reminders). The settings text says so.
 *
 * `allTime` is no limit at all and leaves every reader exactly as it was.
 * MCP clients never pass a reach: an MCP token reads with its own window
 * arguments, and the Coach setting is a Coach setting.
 */
import type { CoachScopeWindow } from "./types";
import type {
  CoachDefaultWindow,
  CoachPrefs,
} from "@/lib/validations/coach-prefs";

/** The lookback options, narrowest first. */
export const COACH_HISTORY_WINDOWS: ReadonlyArray<CoachDefaultWindow> = [
  "last7days",
  "last30days",
  "last90days",
  "lastYear",
  "allTime",
];

/** Days each option reaches back; `null` is no limit. */
export const HISTORY_REACH_DAYS: Readonly<
  Record<CoachDefaultWindow, number | null>
> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  lastYear: 365,
  allTime: null,
};

export interface CoachHistoryReach {
  /** The option the person chose. */
  window: CoachDefaultWindow;
  /** Days the Coach may look back, or `null` for no limit. */
  days: number | null;
}

/** No limit: the behaviour before the limit existed, and the default. */
export const UNBOUNDED_REACH: CoachHistoryReach = Object.freeze({
  window: "allTime",
  days: null,
});

export function reachFromPrefs(
  prefs: Pick<CoachPrefs, "defaultWindow"> | null | undefined,
): CoachHistoryReach {
  const window = prefs?.defaultWindow ?? "allTime";
  return { window, days: HISTORY_REACH_DAYS[window] };
}

export function isBounded(reach: CoachHistoryReach): boolean {
  return reach.days !== null;
}

const WINDOW_RANK: Readonly<Record<CoachScopeWindow, number>> = {
  last7days: 0,
  last30days: 1,
  last90days: 2,
  lastYear: 3,
  allTime: 4,
};

/** The narrower of `window` and the reach. */
export function clampWindow(
  window: CoachScopeWindow,
  reach: CoachHistoryReach,
): CoachScopeWindow {
  return WINDOW_RANK[window] <= WINDOW_RANK[reach.window]
    ? window
    : reach.window;
}

/** True when `window` reaches further back than the limit allows. */
export function exceedsReach(
  window: CoachScopeWindow,
  reach: CoachHistoryReach,
): boolean {
  return WINDOW_RANK[window] > WINDOW_RANK[reach.window];
}

/** A fixed window of `days`, shortened to the limit. */
export function capDays(days: number, reach: CoachHistoryReach): number {
  return reach.days === null ? days : Math.min(days, reach.days);
}

/**
 * True when a block whose own window is `horizonDays` long fits inside the
 * limit. A block that does not fit is left out, never computed over fewer
 * days than the page that shows it uses.
 */
export function fitsReach(
  horizonDays: number,
  reach: CoachHistoryReach,
): boolean {
  return reach.days === null || horizonDays <= reach.days;
}

/** The earliest instant the Coach may read, or `null` for no limit. */
export function reachFloor(
  reach: CoachHistoryReach,
  now: Date = new Date(),
): Date | null {
  return reach.days === null
    ? null
    : new Date(now.getTime() - reach.days * 86_400_000);
}

/** True when `at` lies inside the limit. */
export function withinReach(
  at: Date,
  reach: CoachHistoryReach,
  now: Date = new Date(),
): boolean {
  const floor = reachFloor(reach, now);
  return floor === null || at.getTime() >= floor.getTime();
}

/** The later of `cutoff` and the limit's floor. */
export function laterOfFloor(
  cutoff: Date,
  reach: CoachHistoryReach,
  now: Date = new Date(),
): Date {
  const floor = reachFloor(reach, now);
  return floor !== null && floor.getTime() > cutoff.getTime() ? floor : cutoff;
}

/** A short stable token for cache keys; empty for no limit. */
export function reachCacheToken(reach: CoachHistoryReach | undefined): string {
  return reach && reach.days !== null ? `|reach${reach.days}` : "";
}

// ── The numbers the settings text states ────────────────────────────────
//
// The readers below import these, so the sentence the person reads and the
// window the Coach reads come from one place
// (`coach-history-reach.test.ts` pins it).

/** Days of daily detail the snapshot reads at most (`windowToDays`). */
export const COACH_DAILY_DETAIL_DAYS = 365;

/** How far back an all-time table reaches, as monthly values. */
export const COACH_ALL_TIME_TABLE_DAYS = 3_650;

/** Months of lab results the Coach reads (`labs-snapshot.ts`). */
export const COACH_LABS_LOOKBACK_MONTHS = 12;

/** The i18n key and parameters describing one lookback option. */
export function lookbackText(window: CoachDefaultWindow): {
  optionParams: Record<string, number>;
  detailKey: "detailDays" | "detailMonths" | "detailAll";
  detailParams: Record<string, number>;
} {
  const days = HISTORY_REACH_DAYS[window];
  if (days === null) {
    return {
      optionParams: {},
      detailKey: "detailAll",
      detailParams: {
        dailyMonths: Math.round(COACH_DAILY_DETAIL_DAYS / 30.4),
        years: Math.round(COACH_ALL_TIME_TABLE_DAYS / 365),
        labMonths: COACH_LABS_LOOKBACK_MONTHS,
      },
    };
  }
  if (days >= 365) {
    const months = Math.round(days / 30.4);
    return {
      optionParams: { months },
      detailKey: "detailMonths",
      detailParams: { months },
    };
  }
  return {
    optionParams: { days },
    detailKey: "detailDays",
    detailParams: { days },
  };
}
