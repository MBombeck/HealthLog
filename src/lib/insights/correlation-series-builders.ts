/**
 * v1.21.0 (FDREXTEND) — daily-series builders for the two cross-metric channels
 * the FDR correlation matrix could not previously see: medication compliance
 * and symptom severity.
 *
 * These are the SPARSEST, noisiest inputs in the system, so the builders are
 * deliberately conservative:
 *
 *  - **Compliance** is the per-day adherence rate (0–100) from the compliance
 *    engine's unified dose-history ledger. Only days the cadence ACTUALLY
 *    expected a dose produce a point (off-cadence / off-week days emit nothing),
 *    so a sparse schedule never fabricates a 0%-or-100% point on a day it did
 *    not dose. The ledger's `at` instant is re-keyed to the user's display tz
 *    here (the engine's `dailyComplianceRatesFromLedger` keys in fixed Berlin),
 *    so the day-key basis aligns with every other discovery series.
 *
 *  - **Symptom severity** is the illness day-log functional-impact / symptom
 *    burden (0–3). The logged days are SPARSE and, on their own, often
 *    constant (a short flare logged at impact 2 for three days is a flat line
 *    with no variance — Pearson cannot use it). To make the actionable
 *    "adherence dip → symptom flare" link discoverable we zero-fill HEALTHY
 *    days, but ONLY across the span of the user's real episodes (onset →
 *    resolved/window-end) intersected with the window. A user who never logs an
 *    illness episode yields an EMPTY series, so the channel DEGRADES TO ABSENT
 *    rather than to a spurious all-zero constant. Within an episode span, days
 *    the user didn't log are treated as 0 (healthy) — the same constant-0
 *    healthy baseline the recovery-gap symptom track already uses.
 *
 * Both series then flow UNCHANGED through `discoverCorrelations` — the n ≥ 20
 * paired-day floor, the BH-FDR control, the effect-size floor, and the
 * James-Stein shrinkage all apply exactly as they do to every vital channel.
 * Nothing here computes a statistic; these are pure series shapers.
 *
 * Pure over already-fetched rows — the DB reads live in the caller (the route),
 * mirroring how the engine itself is pure over `NamedSeries[]`.
 */
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import { shiftDateKey } from "@/lib/tz/format";
import { foldNutrientDays } from "@/lib/nutrients/day-total";
import {
  NUTRIENT_CATALOG,
  isNutrientCode,
  type NutrientGroup,
} from "@/lib/nutrients/catalog";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import {
  ALCOHOL_CHANNEL_KEY,
  CAFFEINE_CHANNEL_KEY,
  HYDRATION_CHANNEL_KEY,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  NUTRIENT_CHANNEL_PREFIX,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  TRAINING_LOAD_CHANNEL_KEY,
  WORKOUT_MINUTES_CHANNEL_KEY,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";

/**
 * Build the daily MEDICATION_COMPLIANCE behaviour series from the user's pooled
 * dose-history ledger rows (every medication's `slot` rows over the window).
 *
 * One point per calendar day (user tz) that had at least one scheduled,
 * resolved slot (`taken_on_time` / `taken_late` / `missed`). The rate is the
 * day's pooled `taken / (taken + missed)`, 0–100 — the SAME numerator /
 * denominator the window tally uses. `skipped` (deliberate), `upcoming` (window
 * not open), and `ad_hoc` (off-schedule top-up) rows never enter the day's
 * counts, exactly as the engine excludes them, so a day whose only rows are
 * skips emits no point (no fabricated 0%).
 *
 * Returns a behaviour `NamedSeries`. When no day clears the slot test the
 * `points` array is empty — the discovery loop then drops the channel (it
 * cannot clear the n ≥ 20 floor), so the channel degrades to absent.
 */
export function buildComplianceDailySeries(
  ledgerRows: DoseHistoryRow[],
  tz: string,
): NamedSeries {
  const byDay = new Map<string, { taken: number; missed: number }>();
  for (const row of ledgerRows) {
    // Only scheduled slots have a defensible denominator (ad-hoc top-ups are
    // excluded from the rate exactly as the ledger tally excludes them).
    if (row.kind !== "slot") continue;
    const isTaken =
      row.status === "taken_on_time" || row.status === "taken_late";
    const isMissed = row.status === "missed";
    if (!isTaken && !isMissed) continue;

    const day = dayKeyForUserTz(row.at, tz);
    const bucket = byDay.get(day) ?? { taken: 0, missed: 0 };
    if (isTaken) bucket.taken += 1;
    else bucket.missed += 1;
    byDay.set(day, bucket);
  }

  const points: DailySeriesPoint[] = [];
  for (const [day, { taken, missed }] of byDay) {
    const denom = taken + missed;
    if (denom === 0) continue;
    points.push({ day, value: Math.min(100, (taken / denom) * 100) });
  }
  points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return {
    key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
    role: "behaviour",
    points,
  };
}

/** A logged symptom-burden day (already keyed in the user's local tz). */
export interface SymptomDayLogRow {
  /** Stored `date` string — already a user-tz `YYYY-MM-DD` day key. */
  day: string;
  /** The day's burden (0–3): functionalImpact, else max linked severity. */
  impact: number;
}

/** An episode's active span (instants), used to bound the healthy-day fill. */
export interface SymptomEpisodeSpan {
  onsetAt: Date;
  /** NULL = ongoing → bounded by the window end at build time. */
  resolvedAt: Date | null;
}

/** Inclusive `YYYY-MM-DD` day key for an instant in the user's tz. */
function dayKey(at: Date, tz: string): string {
  return dayKeyForUserTz(at, tz);
}

/**
 * Build the daily SYMPTOM_SEVERITY series (rides both roles; this returns it in
 * the requested `role`). Healthy days are zero-filled — but ONLY across the
 * span of the episodes passed in, intersected with `[windowStart, windowEnd]`.
 * Logged days always count, inside a span or not, so an episode that carries
 * no span (a chronic condition) still contributes its real readings. No span
 * and no log yields an EMPTY series (the channel degrades to absent, never a
 * spurious all-zero constant).
 *
 * Algorithm:
 *  1. Compute the set of in-window calendar days covered by ANY episode span
 *     (onset → resolved, an ongoing episode clamped to `windowEnd`). This is
 *     the only span where a "healthy = 0" claim is defensible: the user was in
 *     a logging-relevant period.
 *  2. Initialise every such day to 0 (healthy baseline).
 *  3. Overlay the logged impacts (a day logged at impact k → k; multiple logs
 *     on a day → the MAX, the most-symptomatic reading).
 *
 * The result is a dense-within-episode-spans series with genuine 0↔>0 variance
 * when the user had symptomatic days, and NOTHING at all when there is neither
 * a span nor a logged day. Pure.
 */
export function buildSymptomSeverityDailySeries(args: {
  dayLogs: SymptomDayLogRow[];
  episodes: SymptomEpisodeSpan[];
  tz: string;
  windowStart: Date;
  windowEnd: Date;
  role: "behaviour" | "outcome";
}): NamedSeries {
  const { dayLogs, episodes, tz, windowStart, windowEnd, role } = args;

  const startKey = dayKey(windowStart, tz);
  const endKey = dayKey(windowEnd, tz);

  // Step 1+2 — zero-fill the healthy baseline across episode spans (clamped to
  // the window). An episode with no in-window days contributes nothing.
  const byDay = new Map<string, number>();
  for (const ep of episodes) {
    const epStart = ep.onsetAt.getTime();
    const epEnd = (ep.resolvedAt ?? windowEnd).getTime();
    // Clamp the iteration to the window so we never fabricate days outside it.
    const from = Math.max(epStart, windowStart.getTime());
    const to = Math.min(epEnd, windowEnd.getTime());
    if (from > to) continue;
    // Walk the local calendar days from the one `from` falls on to the one
    // `to` falls on, by day key. A walk in 24-hour steps of milliseconds
    // skipped a 23-hour day when it started in the last local hour before
    // one, and ran a day past the end whenever the onset's clock time was
    // earlier than the resolution's.
    const lastKey = dayKey(new Date(to), tz);
    for (
      let key = dayKey(new Date(from), tz);
      key <= lastKey;
      key = shiftDateKey(key, 1)
    ) {
      if (key < startKey || key > endKey) continue;
      if (!byDay.has(key)) byDay.set(key, 0);
    }
  }

  // Step 3 — overlay logged impacts (MAX per day). A logged day outside every
  // episode span is still honoured (it is, by definition, a symptomatic day the
  // user recorded), so it joins the series even if the span walk missed it.
  for (const log of dayLogs) {
    if (log.day < startKey || log.day > endKey) continue;
    if (!Number.isFinite(log.impact)) continue;
    const prev = byDay.get(log.day);
    byDay.set(log.day, prev == null ? log.impact : Math.max(prev, log.impact));
  }

  // No span and no logged day: the channel is absent.
  if (byDay.size === 0) {
    return { key: SYMPTOM_SEVERITY_CHANNEL_KEY, role, points: [] };
  }

  const points: DailySeriesPoint[] = [...byDay.entries()]
    .map(([day, value]) => ({ day, value }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  return { key: SYMPTOM_SEVERITY_CHANNEL_KEY, role, points };
}

/** One occurrence of a person-defined symptom, as the builder reads it. */
export interface SymptomEventRow {
  at: Date;
  intensity: number;
}

/**
 * Build one `SYMPTOM:<definitionId>` outcome series from that symptom's
 * occurrences (v1.40).
 *
 * The daily value is the day's HIGHEST intensity (0-10) in the person's zone:
 * two attacks in a day are as bad as the worse one. Days with no occurrence
 * are 0, but only between the first and the last logged day: inside that span
 * the person was tracking the symptom and its absence is a real zero, outside
 * it nothing says whether they were tracking at all. One logged day yields a
 * one-point series, which the n >= 20 floor then drops. Pure.
 */
export function buildSymptomEventDailySeries(args: {
  key: string;
  label: string | undefined;
  events: SymptomEventRow[];
  tz: string;
}): NamedSeries {
  const { key, label, events, tz } = args;
  const byDay = new Map<string, number>();
  for (const event of events) {
    if (!Number.isFinite(event.intensity)) continue;
    const day = dayKey(event.at, tz);
    const prev = byDay.get(day);
    byDay.set(
      day,
      prev == null ? event.intensity : Math.max(prev, event.intensity),
    );
  }
  const keys = [...byDay.keys()].sort();
  const points: DailySeriesPoint[] = [];
  if (keys.length > 0) {
    const last = keys[keys.length - 1];
    for (let day = keys[0]; day <= last; day = shiftDateKey(day, 1)) {
      points.push({ day, value: byDay.get(day) ?? 0 });
    }
  }
  return {
    key,
    ...(label !== undefined ? { label } : {}),
    role: "outcome",
    points,
  };
}

// ─── v1.44 — the extended channel families ─────────────────────────────────

/** One stored nutrient day total (one row per day, nutrient and source). */
export interface NutrientDayRow {
  day: string;
  nutrient: string;
  amount: number;
  source: string;
}

/** Ceiling on vitamin, mineral and omega-3 `NUTRIENT:<code>` channels in one scan. */
export const MAX_MICRONUTRIENT_CHANNELS = 4;

/** Ceiling on energy and macronutrient `NUTRIENT:<code>` channels in one scan. */
export const MAX_MACRONUTRIENT_CHANNELS = 2;

/**
 * The rows of a nutrient read that stopped at `cap`, newest day first, with
 * the oldest day left out when the cap was reached: the read can end in the
 * middle of that day, and its total would then be judged on whichever of its
 * sources happened to be read.
 */
export function wholeNutrientDays<T extends { day: string }>(
  rows: readonly T[],
  cap: number,
): readonly T[] {
  if (rows.length < cap) return rows;
  const cut = rows[rows.length - 1].day;
  return rows.filter((row) => row.day !== cut);
}

/**
 * The intake channels from the nutrient log: water as HYDRATION, caffeine as
 * CAFFEINE, at most {@link MAX_MICRONUTRIENT_CHANNELS} micronutrients and at
 * most {@link MAX_MACRONUTRIENT_CHANNELS} energy or macronutrient codes as
 * `NUTRIENT:<code>`. The two budgets are separate so a food tracker's six
 * daily macros cannot crowd the vitamins out of the scan. Logged alcohol is
 * left out: the ALCOHOL channel already comes from the mood tag, and a second
 * alcohol channel would mostly correlate with the first.
 *
 * A day's amount is `foldNutrientDay` over its sources (the largest day-total
 * source counts, a manual water entry adds on top), the same fold every read
 * uses. A day without a row is no point: the log does not say whether nothing
 * was taken or nothing was recorded. The codes admitted are those with at
 * least `minDays` logged days and any day-to-day variance, the most-logged
 * first (code as the tie-break): a daily supplement at a fixed dose is a
 * constant, and a constant cannot correlate with anything. Pure.
 */
export function buildNutrientDailySeries(
  rows: readonly NutrientDayRow[],
  opts: { minDays: number },
): NamedSeries[] {
  const finite = rows.filter((row) => Number.isFinite(row.amount));
  const folds = foldNutrientDays(finite, (row) => `${row.nutrient}|${row.day}`);
  const byNutrient = new Map<string, Map<string, number>>();
  for (const [key, fold] of folds) {
    const [nutrient, day] = key.split("|");
    const days = byNutrient.get(nutrient) ?? new Map<string, number>();
    days.set(day, fold.total);
    byNutrient.set(nutrient, days);
  }
  const pointsOf = (code: string): DailySeriesPoint[] =>
    [...(byNutrient.get(code) ?? new Map<string, number>()).entries()]
      .map(([day, value]) => ({ day, value }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));

  const out: NamedSeries[] = [
    {
      key: HYDRATION_CHANNEL_KEY,
      role: "behaviour",
      points: pointsOf("water"),
    },
    {
      key: CAFFEINE_CHANNEL_KEY,
      role: "behaviour",
      points: pointsOf("caffeine"),
    },
  ];
  const admitted = (
    groups: ReadonlySet<NutrientGroup>,
    budget: number,
  ): Array<{ code: string; points: DailySeriesPoint[] }> =>
    [...byNutrient.keys()]
      .filter(
        (code) =>
          isNutrientCode(code) && groups.has(NUTRIENT_CATALOG[code].group),
      )
      .map((code) => ({ code, points: pointsOf(code) }))
      .filter(
        ({ points }) =>
          points.length >= opts.minDays &&
          points.some((p) => p.value !== points[0].value),
      )
      .sort(
        (a, b) =>
          b.points.length - a.points.length || (a.code < b.code ? -1 : 1),
      )
      .slice(0, budget);
  const candidates = [
    ...admitted(MICRONUTRIENT_GROUPS, MAX_MICRONUTRIENT_CHANNELS),
    ...admitted(MACRONUTRIENT_GROUPS, MAX_MACRONUTRIENT_CHANNELS),
  ];
  for (const { code, points } of candidates) {
    out.push({
      key: `${NUTRIENT_CHANNEL_PREFIX}${code}`,
      role: "behaviour",
      points,
    });
  }
  return out;
}

const MICRONUTRIENT_GROUPS: ReadonlySet<NutrientGroup> = new Set([
  "vitamin",
  "mineral",
  "omega3",
]);
const MACRONUTRIENT_GROUPS: ReadonlySet<NutrientGroup> = new Set([
  "energy_macro",
]);

/** One mood entry as the alcohol channel reads it. */
export interface AlcoholTagEntry {
  at: Date;
  tagged: boolean;
}

/** Fewest tagged days before the alcohol channel is offered at all. */
export const MIN_ALCOHOL_DAYS = 5;

/**
 * The ALCOHOL behaviour series: per day with at least one mood entry, 1 when
 * any entry that day carries the `alcohol` tag and 0 otherwise. A day without
 * an entry is no point. Below {@link MIN_ALCOHOL_DAYS} tagged days (or with no
 * untagged day to compare against) the series is empty: a handful of ones is
 * what a spurious point-biserial r is made of. Pure.
 */
export function buildAlcoholDailySeries(
  entries: readonly AlcoholTagEntry[],
  tz: string,
): NamedSeries {
  const byDay = new Map<string, number>();
  for (const entry of entries) {
    const day = dayKey(entry.at, tz);
    byDay.set(day, Math.max(byDay.get(day) ?? 0, entry.tagged ? 1 : 0));
  }
  const points = [...byDay.entries()]
    .map(([day, value]) => ({ day, value }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  const tagged = points.filter((p) => p.value === 1).length;
  const usable = tagged >= MIN_ALCOHOL_DAYS && tagged < points.length;
  return {
    key: ALCOHOL_CHANNEL_KEY,
    role: "behaviour",
    points: usable ? points : [],
  };
}

/** One canonical workout session as the training channels read it. */
export interface WorkoutSessionRow {
  startedAt: Date;
  durationSec: number;
}

/**
 * Fill the days between the first and the last key with 0. Inside that span
 * the person was recording training, so a day without a session is a rest
 * day; outside it nothing says whether they were recording at all. Pure.
 */
function zeroFillSpan(byDay: ReadonlyMap<string, number>): DailySeriesPoint[] {
  const keys = [...byDay.keys()].sort();
  const points: DailySeriesPoint[] = [];
  if (keys.length === 0) return points;
  const last = keys[keys.length - 1];
  for (let day = keys[0]; day <= last; day = shiftDateKey(day, 1)) {
    points.push({ day, value: byDay.get(day) ?? 0 });
  }
  return points;
}

/**
 * WORKOUT_MINUTES: the day's summed session minutes (user zone, by start),
 * over sessions the caller has already collapsed across sources, zero-filled
 * between the first and the last session. Pure.
 */
export function buildWorkoutMinutesSeries(
  sessions: readonly WorkoutSessionRow[],
  tz: string,
): NamedSeries {
  const byDay = new Map<string, number>();
  for (const s of sessions) {
    if (!Number.isFinite(s.durationSec) || s.durationSec <= 0) continue;
    const day = dayKey(s.startedAt, tz);
    byDay.set(day, (byDay.get(day) ?? 0) + s.durationSec / 60);
  }
  return {
    key: WORKOUT_MINUTES_CHANNEL_KEY,
    role: "behaviour",
    points: zeroFillSpan(byDay),
  };
}

/**
 * TRAINING_LOAD: the stored day-total TRIMP, zero-filled between the first and
 * the last stored day. The nightly strain run writes a row only on a scored
 * day, so a missing day inside the span carried no training impulse. The day
 * keys are the strain engine's UTC days (the same tolerance the DAY rollups
 * carry). Pure.
 */
export function buildTrainingLoadSeries(
  rows: ReadonlyArray<{ day: string; dayTrimp: number }>,
): NamedSeries {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.dayTrimp) || row.dayTrimp < 0) continue;
    byDay.set(row.day, row.dayTrimp);
  }
  return {
    key: TRAINING_LOAD_CHANNEL_KEY,
    role: "behaviour",
    points: zeroFillSpan(byDay),
  };
}

/** One local hour's mean of one room-climate type. */
export interface ClimateHourRow {
  type: string;
  /** Local calendar day of the hour, YYYY-MM-DD. */
  day: string;
  /** Local hour, 0–23. */
  hour: number;
  mean: number;
}

/** The overnight window, local time: from this hour … */
export const OVERNIGHT_FROM_HOUR = 21;
/** … until (exclusive) this hour of the next morning. */
export const OVERNIGHT_TO_HOUR = 7;
/** Fewest hours inside the window before a night has a value. */
export const MIN_OVERNIGHT_HOURS = 4;

/**
 * One series per room-climate type: the night's mean of its hourly means, the
 * night running 21:00 to 07:00 local time and keyed on the morning's day, the
 * key the sleep series uses. Averaging hours rather than readings keeps a
 * sensor that reports every minute from outweighing one that reports every
 * quarter hour. A night with fewer than {@link MIN_OVERNIGHT_HOURS} hours has
 * no point. Each series pairs with the night's sleep only, at lag 0. Pure.
 */
export function buildOvernightClimateSeries(
  rows: readonly ClimateHourRow[],
  types: readonly string[],
  targets: readonly string[],
): NamedSeries[] {
  const nights = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const row of rows) {
    if (!Number.isFinite(row.mean)) continue;
    let night: string;
    if (row.hour >= OVERNIGHT_FROM_HOUR) night = shiftDateKey(row.day, 1);
    else if (row.hour < OVERNIGHT_TO_HOUR) night = row.day;
    else continue;
    const byNight =
      nights.get(row.type) ?? new Map<string, { sum: number; n: number }>();
    const acc = byNight.get(night) ?? { sum: 0, n: 0 };
    acc.sum += row.mean;
    acc.n += 1;
    byNight.set(night, acc);
    nights.set(row.type, byNight);
  }
  return types.map((type) => ({
    key: type,
    role: "behaviour" as const,
    lagDays: 0,
    phrasing: "overnight" as const,
    targets,
    points: [...(nights.get(type) ?? new Map()).entries()]
      .filter(([, acc]) => acc.n >= MIN_OVERNIGHT_HOURS)
      .map(([day, acc]) => ({ day, value: acc.sum / acc.n }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
  }));
}
