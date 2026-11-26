/**
 * v1.10.0 — Coincident-deviation flag (catalogue metric #2, COMPOSITE).
 *
 * "2 of your vitals are outside their usual range this morning — possible
 * factors: illness, alcohol, altitude, a hard workout." For each vital
 * with an established personal band (#1 `VITALS_BASELINE`), check whether
 * the latest reading falls outside the band; **≥ 2 outside on the same day
 * → fire** a flag listing the contributing vitals. No black-box score — it
 * is a transparent COUNT of deviations, mirroring Apple Vitals' ≥2-metric
 * next-morning notification.
 *
 * Coverage gate: ≥ 2 vitals each with an established band. Below that the
 * flag is `insufficient` (it cannot coincide). The minimum-inputs floor is
 * the composite contract — it never emits a single composite number, and
 * never labels a cause ("illness"); it lists the contributing vitals and
 * frames them as "possible factors" only.
 *
 * Standard: the same MAD / personal-baseline basis as #1 (Hampel 1974;
 * Leys et al. 2013). Multi-signal coincidence is descriptive, NOT a
 * diagnosis. Frame: Apple Vitals / WHOOP Health Monitor / Fitbit Health
 * Metrics / Oura Symptom Radar — all descriptive, none continuous.
 *
 * Server-only — fans the baseline engine across the supported vitals with
 * one shared coverage probe (the pool-contention mitigation). The pure
 * classifier is exported for tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import {
  buildBaselineBand,
  computeVitalsBaseline,
  type BaselineProfile,
} from "./baseline";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import { isSourceRankedType } from "@/lib/analytics/source-rank-sql";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { VITALS_BASELINE_TYPES } from "./registry";
import type { Derived, DerivedProvenanceSource } from "./types";
import { hasActiveIllnessEpisode } from "@/lib/illness/rest-mode";
import { plausibleMetricRange } from "@/lib/measurements/value-domain";
import {
  dayKeyAgeInDays,
  isFromToday,
} from "@/lib/insights/measurement-freshness";
import { MS_PER_DAY } from "@/lib/time-constants";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

const DEFAULT_WINDOW_DAYS = 30;
/** ≥ this many out-of-band vitals on a day fires the flag. */
export const COINCIDENT_FIRE_THRESHOLD = 2;
/** Need ≥ this many banded vitals before the flag can even coincide. */
export const COINCIDENT_MIN_BANDS = 2;

/**
 * Vitals whose day mean depends on how much of the day has passed.
 *
 * Glucose climbs after every meal, so a day's mean at ten in the morning is a
 * fasting mean, and a band built from whole days sits well above it: a
 * perfectly ordinary morning read as "below your range". For these types a
 * day still in progress is compared with the same hours of the earlier days
 * (each day cut at the local time of today's latest reading), never with
 * whole days.
 */
export const SAME_HOURS_TYPES: ReadonlySet<MeasurementType> = new Set([
  "BLOOD_GLUCOSE",
]);

/** Earlier days with readings in the same hours before today is compared. */
export const SAME_HOURS_MIN_DAYS = 7;

/**
 * Today's standing for a same-hours type, from per-day aggregates already cut
 * at the current local clock time. Pure. Null when today has no reading in
 * those hours or fewer than {@link SAME_HOURS_MIN_DAYS} earlier days do: then
 * there is nothing like-for-like to compare today with, and no verdict.
 */
export function sameHoursStanding(
  days: readonly { day: string; n: number; sum: number; dayMean?: number }[],
  todayKey: string,
  type: MeasurementType,
): {
  value: number;
  low: number;
  high: number;
  center: number;
  /** Earlier days the band was built from. */
  days: number;
} | null {
  // A type on the hourly-mean reader carries `dayMean` (the mean of its
  // hours' means); every other type's day is the mean of its readings.
  const value = (d: { n: number; sum: number; dayMean?: number }) =>
    d.dayMean ?? d.sum / d.n;
  const today = days.find((d) => d.day === todayKey && d.n > 0);
  if (!today) return null;
  const earlier = days.filter((d) => d.day < todayKey && d.n > 0).map(value);
  if (earlier.length < SAME_HOURS_MIN_DAYS) return null;
  const band = buildBaselineBand(earlier, type);
  if (!band) return null;
  return {
    value: value(today),
    low: band.low,
    high: band.high,
    center: band.center,
    days: earlier.length,
  };
}

/** The local clock time of an instant in `tz`, `HH:MM:SS`. */
function localClockOf(at: Date, tz: string): string {
  const c = wallClockInTz(at, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}`;
}

/**
 * Per-day aggregates of the window, each day cut at the local clock time of
 * today's latest reading. Not at `now`: at two in the afternoon a day whose
 * only reading is the 07:00 fasting value would otherwise be held against
 * earlier days that include their lunch.
 */
async function readSameHoursDays(
  userId: string,
  type: MeasurementType,
  windowDays: number,
  now: Date,
  tz: string,
  cutAt: Date,
) {
  return readDayAggregates({
    userId,
    type,
    since: new Date(now.getTime() - windowDays * MS_PER_DAY),
    until: now,
    timeZone: tz,
    valueRange: plausibleMetricRange(type),
    upToLocalTime: localClockOf(cutAt, tz),
    sourcePriority: isSourceRankedType(type)
      ? await loadUserSourcePriority(userId)
      : undefined,
  });
}

/**
 * Today's same-hours standing for a type whose latest reading is from the
 * reader's local today: today's readings so far against the earlier days cut
 * at the local time of `lastAt` (today's latest reading). Null when there is
 * no like-for-like basis yet (see {@link sameHoursStanding}).
 */
export async function readSameHoursStanding(
  userId: string,
  type: MeasurementType,
  opts: { windowDays: number; now: Date; tz: string; lastAt: Date },
) {
  return sameHoursStanding(
    await readSameHoursDays(
      userId,
      type,
      opts.windowDays,
      opts.now,
      opts.tz,
      opts.lastAt,
    ),
    userDayKey(opts.now, opts.tz),
    type,
  );
}

/** One vital's standing against its personal band today. */
export interface VitalDeviation {
  type: MeasurementType;
  /** Today's value. */
  value: number;
  /** Band center (median). */
  center: number;
  low: number;
  high: number;
  /** True when today's value falls outside [low, high]. */
  outside: boolean;
  /** "above" / "below" the band, or "in" when inside. */
  direction: "above" | "below" | "in";
  /**
   * Whole days between the reading this standing was computed from and the
   * caller's own local today. `0` is today, `1` yesterday.
   *
   * The value used to be presented with no age at all, so a vital last taken
   * five days ago was narrated as "outside its range today" on a day that
   * carried no reading. Consumers making a present-tense claim check this;
   * `contributing` below already does.
   */
  daysAgo: number;
  /**
   * `"sameHours"` when today's value was held against the same hours of the
   * earlier days rather than their whole-day band (a day still in progress
   * for a type whose day mean moves with the hour, see `SAME_HOURS_TYPES`).
   * `low` / `high` are then the usual range for this time of day, and a
   * surface naming them says so. Absent for the whole-day comparison.
   */
  basis?: "sameHours";
}

export interface CoincidentDeviationValue {
  /** True when ≥ COINCIDENT_FIRE_THRESHOLD vitals are outside their band. */
  fired: boolean;
  /** All banded vitals checked today (the anatomy view lists them). */
  vitals: VitalDeviation[];
  /** Just the out-of-band vitals (the contributing factors). */
  contributing: VitalDeviation[];
  /** The day the flag was evaluated (YYYY-MM-DD). */
  day: string;
  /**
   * v1.18.1 — Rest Mode reframe. True when the flag fired AND an
   * illness/condition episode is active: the deviations have a known
   * explanation (the user is unwell), so the surface frames them as
   * illness-explained — "your vitals are off because you're ill" — instead of
   * presenting them as an unexplained anomaly. The vital numbers themselves
   * are unchanged; only the framing differs. Resolved server-side; iOS
   * mirrors it.
   */
  illnessExplained: boolean;
}

// ── pure classifier (exported for tests) ───────────────────────────────

/** Classify one vital's latest value against its band. Pure. */
export function classifyDeviation(
  type: MeasurementType,
  value: number,
  low: number,
  high: number,
  center: number,
  daysAgo: number = 0,
  basis?: "sameHours",
): VitalDeviation {
  const above = value > high;
  const below = value < low;
  return {
    type,
    value,
    center,
    low,
    high,
    outside: above || below,
    direction: above ? "above" : below ? "below" : "in",
    daysAgo,
    ...(basis ? { basis } : {}),
  };
}

// ── compute ─────────────────────────────────────────────────────────────

export interface CoincidentDeviationOpts {
  windowDays?: number;
  now?: Date;
  coverage?: RollupCoverageMap;
  /**
   * IANA timezone the "today" grouping is keyed in. A 23:30-local
   * reading must land on the user's local "today", not UTC's; mirrors
   * `readiness.ts`. Defaults to `DEFAULT_TIMEZONE` when the caller has no tz.
   */
  tz?: string;
}

/**
 * The most recent DAY mean for a type within the window, plus its day key;
 * null when no plausible reading is in the window.
 *
 * Day keys are minted in the user's timezone, not UTC, so a late-evening /
 * early-morning reading for a non-UTC user is grouped under the right
 * calendar "today" — the same tz-aware basis `readiness.ts` uses. Without
 * this, the fired coincident flag could compare a vital from the wrong
 * calendar day against its band and narrate "≥2 vitals out of band TODAY" on
 * the wrong day.
 *
 * Readings outside the metric's declared plausibility domain are not means
 * material. This side of the comparison had no gate at all, so one impossible
 * stored value became "your pulse today" and was then held against a band the
 * same value had already inflated. A day left with no plausible reading
 * contributes nothing and the vital drops out of the comparison.
 *
 * The mean runs over every reading of the day in Postgres. It used to mean
 * the newest 50 rows, which on a stream sampled every few minutes is the last
 * hours of the day and not the day.
 *
 * The readiness score reads the same day with `plausibleOnly: false`.
 *
 * The day keeps to its ladder-winning source, as the metric page does. A
 * watch worn only in the day and a ring worn through the night both report
 * a resting heart rate for the same date; averaging the two made today's
 * value a figure neither device measured, and one that moved whenever the
 * lower-priority device revised its estimate. `sourcePriority` is the
 * user's blob when the caller has it; omitted, it is read here.
 */
export async function readLatestDayMean(
  userId: string,
  type: MeasurementType,
  windowDays: number,
  now: Date,
  tz: string,
  opts: { plausibleOnly?: boolean; sourcePriority?: unknown } = {},
): Promise<{ value: number; day: string; lastAt: Date } | null> {
  const days = await readDayAggregates({
    userId,
    type,
    since: new Date(now.getTime() - windowDays * MS_PER_DAY),
    timeZone: tz,
    valueRange:
      opts.plausibleOnly === false ? undefined : plausibleMetricRange(type),
    latestDayOnly: true,
    sourcePriority:
      opts.sourcePriority !== undefined || !isSourceRankedType(type)
        ? opts.sourcePriority
        : await loadUserSourcePriority(userId),
  });
  const latest = days.at(-1);
  if (!latest) return null;
  return {
    value: latest.dayMean ?? latest.sum / latest.n,
    day: latest.day,
    lastAt: latest.lastAt,
  };
}

/**
 * Compute the coincident-deviation flag across the supported vitals. Below
 * `COINCIDENT_MIN_BANDS` banded vitals it returns `insufficient`.
 */
export async function computeCoincidentDeviation(
  userId: string,
  profile: BaselineProfile,
  opts: CoincidentDeviationOpts = {},
): Promise<Derived<CoincidentDeviationValue>> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TIMEZONE;
  const computedAt = nowProvenanceTimestamp(now);
  const coverage = opts.coverage ?? (await probeRollupCoverage(userId));

  const vitals: VitalDeviation[] = [];
  let latestDay = "";
  let anyDaySource = false;
  let maxHistoryDays = 0;
  // The reader's own calendar day — the anchor every vital's age is measured
  // against, so "today" means the day the reader is having.
  const todayKey = userDayKey(now, tz);

  // Fan the baseline engine across the supported vitals. Each baseline read
  // shares the one coverage probe (no per-vital re-probe). The types are
  // independent, so their reads run together; the results are folded in the
  // registry's order, so the output does not depend on which finished first.
  const perType = await Promise.all(
    VITALS_BASELINE_TYPES.map(async (type) => {
      const baseline = await computeVitalsBaseline(userId, profile, {
        type,
        windowDays,
        now,
        coverage,
      });
      if (baseline.status !== "ok") {
        return { type, baseline, latest: null, sameHours: null };
      }
      const latest = await readLatestDayMean(userId, type, windowDays, now, tz);
      // A day still in progress is compared with the same hours of earlier
      // days, not with their whole-day band (see `SAME_HOURS_TYPES`).
      const sameHours =
        latest && latest.day === todayKey && SAME_HOURS_TYPES.has(type)
          ? await readSameHoursStanding(userId, type, {
              windowDays,
              now,
              tz,
              lastAt: latest.lastAt,
            })
          : undefined;
      return { type, baseline, latest, sameHours };
    }),
  );
  for (const { type, baseline, latest, sameHours } of perType) {
    if (baseline.status !== "ok") continue;
    if (baseline.provenance.source === "DAY") anyDaySource = true;
    if (!latest) continue;
    // A same-hours type with no like-for-like basis for today yet says
    // nothing about today rather than hold a partial day against whole ones.
    if (sameHours === null) continue;
    if (latest.day > latestDay) latestDay = latest.day;
    if (baseline.coverage.historyDays > maxHistoryDays) {
      maxHistoryDays = baseline.coverage.historyDays;
    }
    vitals.push(
      sameHours
        ? classifyDeviation(
            type,
            sameHours.value,
            sameHours.low,
            sameHours.high,
            sameHours.center,
            0,
            "sameHours",
          )
        : classifyDeviation(
            type,
            latest.value,
            baseline.value.low,
            baseline.value.high,
            baseline.value.center,
            dayKeyAgeInDays(latest.day, todayKey) ?? Number.POSITIVE_INFINITY,
          ),
    );
  }

  const inputs = vitals.map((v) => String(v.type));
  const source: DerivedProvenanceSource =
    vitals.length === 0 ? "none" : anyDaySource ? "DAY" : "live";

  if (vitals.length < COINCIDENT_MIN_BANDS) {
    const { coverage: cov } = deriveCoverage({
      requiredInputs: COINCIDENT_MIN_BANDS,
      presentInputs: vitals.length,
      historyDays: 0,
      missing: [],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<CoincidentDeviationValue>({
      coverage: cov,
      provenance: {
        inputs: inputs.length > 0 ? inputs : VITALS_BASELINE_TYPES.map(String),
        source,
        windowDays,
        computedAt,
      },
      reason: "too_few_banded_vitals",
    });
  }

  // Everything this flag says is about TODAY — the card is literally called
  // "signals of the day" and its lines say "today". A vital whose freshest
  // reading is from an earlier calendar day cannot contribute to it: the
  // reading describes the day it was taken on, and saying otherwise tells the
  // reader something about a day on which nothing was measured. Stale vitals
  // stay in `vitals` with their age, so the anatomy view still lists them and
  // nothing silently disappears.
  const contributing = vitals.filter(
    (v) => v.outside && isFromToday(v.daysAgo),
  );
  const fired = contributing.length >= COINCIDENT_FIRE_THRESHOLD;

  // v1.18.1 — when the flag fired, reframe it as illness-explained if an
  // episode is active. Only resolved when the flag fired (no read on the
  // common quiet day). Annotation only — the vital deviations are unchanged.
  // Any active episode counts, a chronic condition included: it explains a
  // coincident dip as much as an acute one, even though it does not put the
  // account into Rest Mode (#1216).
  const illnessExplained = fired
    ? await hasActiveIllnessEpisode(userId, now)
    : false;

  const { coverage: cov, confidence } = deriveCoverage({
    // The coverage axis is "how many vitals could have coincided".
    requiredInputs: vitals.length,
    presentInputs: vitals.length,
    // v1.10.0: the REAL distinct-history-days backing the deepest
    // contributing vital, not the constant `windowDays` (which pinned
    // `historyFraction` to 1 so a 7-day and a 30-day blend reported the same
    // confidence). The composite is at least as well-backed as its
    // best-supported vital.
    historyDays: maxHistoryDays,
    missing: [],
    fullHistoryDays: windowDays,
  });

  return buildOk<CoincidentDeviationValue>({
    value: {
      fired,
      vitals,
      contributing,
      day: latestDay,
      illnessExplained,
    },
    coverage: cov,
    confidence,
    provenance: { inputs, source, windowDays, computedAt },
  });
}
