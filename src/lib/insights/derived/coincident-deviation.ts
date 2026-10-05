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
import { prisma } from "@/lib/db";
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
import { computeVitalsBaseline, type BaselineProfile } from "./baseline";
import { VITALS_BASELINE_TYPES } from "./registry";
import type { Derived, DerivedProvenanceSource } from "./types";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { isPlausibleMetricValue } from "@/lib/measurements/value-domain";
import {
  dayKeyAgeInDays,
  isCurrentForTodayClaim,
} from "@/lib/insights/measurement-freshness";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
/**
 * Row cap for the latest-day mean read — see `readiness.ts`. A dense intra-day
 * day can hold hundreds of rows; the latest-day mean only needs a bounded
 * sample of the most-recent rows (the dense-intraday retention reasoning). The
 * common single-reading-per-day case is unaffected.
 */
const MAX_LATEST_DAY_ROWS = 50;
/** ≥ this many out-of-band vitals on a day fires the flag. */
export const COINCIDENT_FIRE_THRESHOLD = 2;
/** Need ≥ this many banded vitals before the flag can even coincide. */
export const COINCIDENT_MIN_BANDS = 2;

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
   * v1.18.1 P4 — Rest Mode reframe. True when the flag fired AND an
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
  };
}

// ── compute ─────────────────────────────────────────────────────────────

export interface CoincidentDeviationOpts {
  windowDays?: number;
  now?: Date;
  coverage?: RollupCoverageMap;
  /**
   * D2-8 — IANA timezone the "today" grouping is keyed in. A 23:30-local
   * reading must land on the user's local "today", not UTC's; mirrors
   * `readiness.ts`. Defaults to `DEFAULT_TIMEZONE` when the caller has no tz.
   */
  tz?: string;
}

/**
 * The most recent DAY mean for a type within the window, plus its day key.
 * Bounded raw read; null when no reading in the window.
 *
 * D2-8 — day keys are minted in the user's timezone (`userDayKey`), not UTC
 * (`toISOString().slice(0,10)`), so a late-evening / early-morning reading for
 * a non-UTC user is grouped under the right calendar "today" — the same
 * tz-aware basis `readiness.ts` already uses. Without this, the fired
 * coincident flag could compare a vital from the wrong calendar day against
 * its band and narrate "≥2 vitals out of band TODAY" on the wrong day.
 */
async function readLatestDayMean(
  userId: string,
  type: MeasurementType,
  windowDays: number,
  now: Date,
  tz: string,
): Promise<{ value: number; day: string } | null> {
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const rows = await prisma.measurement.findMany({
    where: { userId, type, deletedAt: null, measuredAt: { gte: since } },
    orderBy: { measuredAt: "desc" },
    take: MAX_LATEST_DAY_ROWS,
    select: { value: true, measuredAt: true },
  });
  return latestDayMeanFromRows(rows, type, tz);
}

/**
 * The pure half of the read above: pick the most recent day present in the
 * rows and mean that day's readings.
 *
 * Readings outside the metric's declared plausibility domain are not means
 * material. This side of the comparison had no gate at all, so one impossible
 * stored value became "your pulse today" and was then held against a band the
 * same value had already inflated — the two numbers in the sentence were both
 * wrong, and wrong by different amounts, which is why the line read as
 * nonsense rather than as an exaggeration. A day left with no plausible
 * reading contributes nothing and the vital drops out of the comparison.
 */
export function latestDayMeanFromRows(
  rows: readonly { value: number; measuredAt: Date }[],
  type: MeasurementType,
  tz: string,
): { value: number; day: string } | null {
  const usable = rows.filter((r) => isPlausibleMetricValue(type, r.value));
  if (usable.length === 0) return null;
  // Derive the most-recent day defensively (do not assume the DB ordering)
  // so the "today" reading is always the genuine latest, then mean its rows.
  let day = "";
  for (const r of usable) {
    const d = userDayKey(r.measuredAt, tz);
    if (d > day) day = d;
  }
  const sameDay = usable.filter((r) => userDayKey(r.measuredAt, tz) === day);
  return {
    value: sameDay.reduce((s, r) => s + r.value, 0) / sameDay.length,
    day,
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
      if (baseline.status !== "ok") return { type, baseline, latest: null };
      const latest = await readLatestDayMean(userId, type, windowDays, now, tz);
      return { type, baseline, latest };
    }),
  );
  for (const { type, baseline, latest } of perType) {
    if (baseline.status !== "ok") continue;
    if (baseline.provenance.source === "DAY") anyDaySource = true;
    if (!latest) continue;
    if (latest.day > latestDay) latestDay = latest.day;
    if (baseline.coverage.historyDays > maxHistoryDays) {
      maxHistoryDays = baseline.coverage.historyDays;
    }
    vitals.push(
      classifyDeviation(
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
  // "signals of the day" and every line it renders is present tense. A vital
  // whose freshest reading is older than that cannot contribute to it: the
  // reading describes the day it was taken on, and saying otherwise tells the
  // reader something about a day on which nothing was measured. Stale vitals
  // stay in `vitals` with their age, so the anatomy view still lists them and
  // nothing silently disappears.
  const contributing = vitals.filter(
    (v) => v.outside && isCurrentForTodayClaim(v.daysAgo),
  );
  const fired = contributing.length >= COINCIDENT_FIRE_THRESHOLD;

  // v1.18.1 P4 — when the flag fired, reframe it as illness-explained if an
  // episode is active. Only resolved when the flag fired (no read on the
  // common quiet day). Annotation only — the vital deviations are unchanged.
  const illnessExplained = fired
    ? (await resolveRestMode(userId, now)).active
    : false;

  const { coverage: cov, confidence } = deriveCoverage({
    // The coverage axis is "how many vitals could have coincided".
    requiredInputs: vitals.length,
    presentInputs: vitals.length,
    // v1.10.0 QA: the REAL distinct-history-days backing the deepest
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
