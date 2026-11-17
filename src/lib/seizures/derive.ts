/**
 * What the seizure diary derives from its rows (#1368): cluster episodes, the
 * seizure-free streak, seizure days, per-type monthly counts, duration flags,
 * the timer's alert threshold and the LOINC frequency category.
 *
 * Pure and client-safe. Nothing here is stored: a change to the cluster rule
 * or to an event re-derives every figure, and the report, the diary page, the
 * FHIR export and the MCP tool all read the same functions.
 *
 * Every figure is a count of what was RECORDED. Diaries miss seizures, most of
 * all from sleep (Hoppe et al., Arch Neurol 2007), so nothing here is phrased
 * or used as an outcome, and nothing is a risk estimate.
 */
import { daysBetweenDateKeys, shiftDateKey, userDayKey } from "@/lib/tz/format";

import { ILAE_TYPE_INFO, isConvulsiveType, type SeizureIlaeType } from "./ilae";

const HOUR_MS = 60 * 60 * 1000;

/** The reporter's plan and one of the definitions in Haut et al. 2022. */
export const DEFAULT_CLUSTER_RULE: ClusterRule = { count: 2, windowHours: 24 };

/** NICE NG217 §7.2.1: "typically 3 or more self-terminating seizures in 24 hours". */
export const NICE_CLUSTER_RULE: ClusterRule = { count: 3, windowHours: 24 };

/** NICE NG217 §7.3: prolonged = more than 2 minutes longer than usual. */
export const NICE_PROLONGED_MARGIN_SEC = 2 * 60;

/**
 * CDC seizure first aid: call emergency services when a seizure lasts longer
 * than 5 minutes. The timer's fallback when a type has neither a t1 nor a
 * usual duration.
 */
export const GENERIC_ALERT_SEC = 5 * 60;

export interface ClusterRule {
  /** N: at least this many seizures … */
  count: number;
  /** … within this many hours. */
  windowHours: number;
}

/** The fields a derivation reads from one event. */
export interface DerivableSeizure {
  id: string;
  onsetAt: Date | string;
  /** How many seizures the row stands for (a tally of absences is > 1). */
  count: number;
  certainty: "CONFIRMED" | "SUSPECTED";
  /** The effective type: the event's override, else its profile's. */
  ilaeType: SeizureIlaeType | null;
  typeProfileId: string | null;
  durationSec: number | null;
  sleepState: "AWAKE" | "ASLEEP" | "ON_WAKING" | "UNKNOWN";
}

export interface ClusterEpisode {
  /** Onset of the first event in the episode (ISO). */
  startAt: string;
  /** Onset of the last event in the episode (ISO). */
  endAt: string;
  /** Seizures in the episode, each row weighted by its `count`. */
  seizureCount: number;
  eventIds: string[];
}

function ms(at: Date | string): number {
  return typeof at === "string" ? Date.parse(at) : at.getTime();
}

/**
 * Cluster episodes under `rule`.
 *
 * Events are sorted by onset, each weighted by its `count`. The window
 * starting at event i is [tᵢ, tᵢ + W); it qualifies when the seizures inside
 * total at least N. Qualifying windows that share an event merge into one
 * episode, counted once and spanning its first to its last onset. Windows are
 * measured in absolute time, so a day with a clock change and a cluster that
 * runs over midnight are judged by the hours that actually passed.
 *
 * Confirmed and suspected events both count (a carer unsure whether the
 * second event was a seizure is exactly when the rule matters).
 */
export function deriveClusters(
  events: readonly DerivableSeizure[],
  rule: ClusterRule,
): ClusterEpisode[] {
  const sorted = events
    .map((e) => ({ e, t: ms(e.onsetAt) }))
    .filter((x) => Number.isFinite(x.t) && x.e.count > 0)
    .sort((a, b) => a.t - b.t || a.e.id.localeCompare(b.e.id));
  const windowMs = rule.windowHours * HOUR_MS;
  const episodes: Array<{ first: number; last: number }> = [];

  for (let i = 0; i < sorted.length; i++) {
    let total = 0;
    let last = i;
    for (let j = i; j < sorted.length; j++) {
      if (sorted[j].t >= sorted[i].t + windowMs) break;
      total += sorted[j].e.count;
      last = j;
    }
    if (total < rule.count) continue;
    const open = episodes.at(-1);
    if (open && i <= open.last) {
      open.last = Math.max(open.last, last);
    } else {
      episodes.push({ first: i, last });
    }
  }

  return episodes.map(({ first, last }) => {
    const members = sorted.slice(first, last + 1);
    return {
      startAt: new Date(members[0].t).toISOString(),
      endAt: new Date(members[members.length - 1].t).toISOString(),
      seizureCount: members.reduce((sum, m) => sum + m.e.count, 0),
      eventIds: members.map((m) => m.e.id),
    };
  });
}

/** Normalise a stored or submitted rule into its valid range. */
export function normaliseClusterRule(
  rule: Partial<ClusterRule> | null | undefined,
): ClusterRule {
  const count = Math.round(rule?.count ?? DEFAULT_CLUSTER_RULE.count);
  const windowHours = Math.round(
    rule?.windowHours ?? DEFAULT_CLUSTER_RULE.windowHours,
  );
  return {
    count: Math.min(20, Math.max(2, count)),
    windowHours: Math.min(168, Math.max(1, windowHours)),
  };
}

/** Sum of `count` over the events. */
export function totalSeizures(events: readonly DerivableSeizure[]): number {
  return events.reduce((sum, e) => sum + e.count, 0);
}

/** The calendar days (in `tz`) with at least one recorded seizure, sorted. */
export function seizureDayKeys(
  events: readonly DerivableSeizure[],
  tz: string,
): string[] {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.count > 0) keys.add(userDayKey(new Date(ms(e.onsetAt)), tz));
  }
  return [...keys].sort();
}

export interface SeizureFreeSummary {
  /** Calendar days since the last confirmed seizure; null when none recorded. */
  daysSinceLast: number | null;
  /** Onset of the last confirmed seizure (ISO), or null. */
  lastAt: string | null;
  /**
   * Longest run of calendar days with no confirmed seizure inside
   * [fromKey, toKey], edges included.
   */
  longestFreeDays: number;
}

/**
 * The seizure-free figures over a period. Only CONFIRMED events end a run:
 * a suspected event is listed, but nobody is sure it was a seizure.
 *
 * Deliberately not called an outcome. Being "seizure-free" in the clinical
 * sense needs twelve months or three times the longest earlier interval
 * (Kwan et al., Epilepsia 2010), which no diary count can assert.
 */
export function seizureFreeSummary(
  events: readonly DerivableSeizure[],
  tz: string,
  fromKey: string,
  toKey: string,
  todayKey: string,
): SeizureFreeSummary {
  const confirmed = events.filter((e) => e.certainty === "CONFIRMED");
  const lastMs = confirmed.reduce<number | null>((max, e) => {
    const t = ms(e.onsetAt);
    return Number.isFinite(t) && (max === null || t > max) ? t : max;
  }, null);
  const lastAt = lastMs === null ? null : new Date(lastMs).toISOString();
  const daysSinceLast =
    lastMs === null
      ? null
      : Math.max(
          0,
          daysBetweenDateKeys(userDayKey(new Date(lastMs), tz), todayKey),
        );

  const inPeriod = seizureDayKeys(confirmed, tz).filter(
    (k) => k >= fromKey && k <= toKey,
  );
  let longest = 0;
  let cursor = fromKey;
  for (const day of inPeriod) {
    longest = Math.max(longest, daysBetweenDateKeys(cursor, day));
    cursor = shiftDateKey(day, 1);
  }
  longest = Math.max(longest, daysBetweenDateKeys(cursor, toKey) + 1);

  return { daysSinceLast, lastAt, longestFreeDays: Math.max(0, longest) };
}

/** `YYYY-MM` of an instant in `tz`. */
export function monthKey(at: Date | string, tz: string): string {
  return userDayKey(new Date(ms(at)), tz).slice(0, 7);
}

export interface MonthlyTypeRow {
  /** The type profile id, or null for events without one. */
  typeProfileId: string | null;
  /** Seizures per `YYYY-MM`. */
  counts: Record<string, number>;
  /** Seizure days per `YYYY-MM`. */
  days: Record<string, number>;
  total: number;
}

/** Every `YYYY-MM` from the month of `fromKey` to the month of `toKey`. */
export function monthsBetween(fromKey: string, toKey: string): string[] {
  const months: string[] = [];
  let [y, m] = fromKey.slice(0, 7).split("-").map(Number);
  const [ey, em] = toKey.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

/**
 * The type × month table: seizures and seizure days per type and month, and
 * a total row (`typeProfileId: "__total"`). This is the shape clinic letters
 * quote.
 */
export function monthlyByType(
  events: readonly DerivableSeizure[],
  tz: string,
): { rows: MonthlyTypeRow[]; total: MonthlyTypeRow } {
  const byType = new Map<string | null, DerivableSeizure[]>();
  for (const e of events) {
    const list = byType.get(e.typeProfileId) ?? [];
    list.push(e);
    byType.set(e.typeProfileId, list);
  }
  const build = (
    typeProfileId: string | null,
    list: readonly DerivableSeizure[],
  ): MonthlyTypeRow => {
    const counts: Record<string, number> = {};
    const dayKeys: Record<string, Set<string>> = {};
    for (const e of list) {
      const day = userDayKey(new Date(ms(e.onsetAt)), tz);
      const month = day.slice(0, 7);
      counts[month] = (counts[month] ?? 0) + e.count;
      (dayKeys[month] ??= new Set()).add(day);
    }
    const days: Record<string, number> = {};
    for (const [month, set] of Object.entries(dayKeys)) days[month] = set.size;
    return {
      typeProfileId,
      counts,
      days,
      total: totalSeizures(list),
    };
  };
  const rows = [...byType.entries()].map(([id, list]) => build(id, list));
  return { rows, total: build("__total", events) };
}

export interface DurationFlags {
  /** At or past Trinka's t1 for the type (null when the type has none). */
  overT1: boolean | null;
  /** At least 2 minutes longer than the type's usual duration (NICE). */
  prolonged: boolean | null;
}

/** Duration flags for one event. Null where the input to decide is missing. */
export function durationFlags(
  durationSec: number | null,
  ilaeType: SeizureIlaeType | null,
  usualDurationSec: number | null,
): DurationFlags {
  if (durationSec === null) return { overT1: null, prolonged: null };
  const t1 = ilaeType ? ILAE_TYPE_INFO[ilaeType].t1Sec : null;
  return {
    overT1: t1 === null ? null : durationSec >= t1,
    prolonged:
      usualDurationSec === null
        ? null
        : durationSec >= usualDurationSec + NICE_PROLONGED_MARGIN_SEC,
  };
}

export type AlertThresholdSource = "t1" | "usualPlusTwo" | "generic";

export interface AlertThreshold {
  seconds: number;
  source: AlertThresholdSource;
}

/**
 * When the quick-log timer shows the plan and the emergency action.
 *
 * - Convulsive (bilateral tonic-clonic) types: the earlier of t1 (5 min) and
 *   the person's usual duration plus 2 minutes (NICE NG217 §7.3), because
 *   NICE defines a prolonged convulsive seizure relative to the person.
 * - Other types with a t1 (focal with impaired consciousness, absences): t1.
 * - Everything else, and no type at all: 5 minutes (CDC first aid).
 *
 * The timer only SHOWS the plan earlier or later; it never says it is safe to
 * wait, and the always-visible safety text stays the same.
 */
export function alertThreshold(
  ilaeType: SeizureIlaeType | null,
  usualDurationSec: number | null,
): AlertThreshold {
  const t1 = ilaeType ? ILAE_TYPE_INFO[ilaeType].t1Sec : null;
  if (isConvulsiveType(ilaeType)) {
    const ceiling = t1 ?? GENERIC_ALERT_SEC;
    if (
      usualDurationSec !== null &&
      usualDurationSec + NICE_PROLONGED_MARGIN_SEC < ceiling
    ) {
      return {
        seconds: usualDurationSec + NICE_PROLONGED_MARGIN_SEC,
        source: "usualPlusTwo",
      };
    }
    return { seconds: ceiling, source: t1 === null ? "generic" : "t1" };
  }
  if (t1 !== null) return { seconds: t1, source: "t1" };
  return { seconds: GENERIC_ALERT_SEC, source: "generic" };
}

/**
 * The LOINC LL6117-7 seizure-frequency answers (99312-1), in the list's order,
 * with the operational definitions LOINC states for each.
 */
export const SEIZURE_FREQUENCY_ANSWERS = {
  innumerable: {
    code: "LA32852-8",
    display: "Innumerable (i.e., >= 10 per day most days)",
  },
  multiplePerDay: {
    code: "LA32853-6",
    display: "Multiple per day (i.e., 4 days per week with >= 2 seizures)",
  },
  daily: {
    code: "LA32854-4",
    display: "Daily (i.e., 4 or more days per week)",
  },
  weekly: {
    code: "LA32855-1",
    display: "Weekly but not daily (i.e., 1-3 per week)",
  },
  monthly: {
    code: "LA32856-9",
    display: "Monthly but not weekly (i.e., 1-3 per month)",
  },
  yearly: {
    code: "LA32857-7",
    display:
      "At least once per year, but not every month (i.e., 10 or fewer in past 12 months)",
  },
  lessThanYearly: { code: "LA32858-5", display: "Less than once per year" },
} as const;

export type SeizureFrequencyCategory = keyof typeof SEIZURE_FREQUENCY_ANSWERS;

/**
 * Bucket the trailing twelve months by LOINC's own definitions, read as
 * shares of the year: "most days" is more than half of them, "4 days per
 * week" is 4/7 of them. `perDay` holds the confirmed seizures of each
 * calendar day that had any.
 */
export function frequencyCategory(
  perDay: readonly number[],
): SeizureFrequencyCategory {
  const days = 365;
  const total = perDay.reduce((sum, n) => sum + n, 0);
  if (perDay.filter((n) => n >= 10).length > days / 2) return "innumerable";
  if (perDay.filter((n) => n >= 2).length >= (days * 4) / 7) {
    return "multiplePerDay";
  }
  if (perDay.length >= (days * 4) / 7) return "daily";
  if (total >= 52) return "weekly";
  if (total >= 12) return "monthly";
  if (total >= 1) return "yearly";
  return "lessThanYearly";
}

/** LOINC LL6118-5 answers for 99313-9, time since the last seizure. */
export function timeSinceLastAnswer(daysSinceLast: number | null): {
  code: string;
  display: string;
} {
  if (daysSinceLast === null) return { code: "LA14072-5", display: "Unsure" };
  if (daysSinceLast === 0) return { code: "LA32860-1", display: "Today" };
  if (daysSinceLast <= 6) return { code: "LA32861-9", display: "1-6 days ago" };
  const weeks = Math.floor(daysSinceLast / 7);
  if (weeks <= 4) return { code: "LA32862-7", display: "1-4 weeks ago" };
  if (weeks <= 12) return { code: "LA32863-5", display: "5-12 weeks ago" };
  if (weeks <= 26) return { code: "LA32864-3", display: "13-26 weeks ago" };
  if (weeks <= 52) {
    return { code: "LA32865-0", display: "6-12 months ago (27-52 weeks ago)" };
  }
  if (weeks <= 104) {
    return {
      code: "LA32866-8",
      display: "13-24 months ago (53-104 weeks ago)",
    };
  }
  return {
    code: "LA32867-6",
    display: "More than 2 years ago (more than 105 weeks ago)",
  };
}

/** Median of a non-empty list, else null. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}
