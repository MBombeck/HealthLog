/**
 * v1.21.2 (A1) — "Coach read" strip data builder.
 *
 * Two server-authoritative lines for a single metric sub-page, computed
 * here so web and iOS read the SAME resolved DTO (no client re-derivation):
 *
 *   1. own-baseline — the user's personal typical range (median ± k·MAD)
 *      from `computeVitalsBaseline`, plus where today's latest reading sits
 *      relative to it (within / above / below). A type whose day mean moves
 *      with the hour (glucose) is placed by its day mean instead, and a day
 *      still in progress against the same hours of the earlier days (see
 *      `placeByDayMean`). Below the engine's 7-day
 *      history floor the band is `insufficient` and the strip says
 *      "still learning your range" — never a fabricated range.
 *   2. one lagged association — the single strongest discovered driver
 *      whose OUTCOME is this metric, surfaced from `readCoachCorrelations`
 *      (FDR-controlled, effect-size-floored, confidence-tiered). The line
 *      carries the engine's own never-causal interpretation verbatim. When
 *      nothing clears the existing floor the line is omitted entirely.
 *
 * Both inputs reuse the deterministic engines unchanged — no new statistics,
 * no lowered floor. Server-only by construction — only the metric-page
 * route imports it, and it reads Prisma. The DTO shapes + the pure selection
 * helpers live in the client-safe `coach-read-shape.ts` sibling so the strip
 * component and the unit test can share them without pulling Prisma.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import {
  loadBaselineProfile,
  computeVitalsBaseline,
} from "@/lib/insights/derived/baseline";
import { isDerivedOk } from "@/lib/insights/derived";
import {
  readLatestDayMean,
  readSameHoursStanding,
  SAME_HOURS_TYPES,
} from "@/lib/insights/derived/coincident-deviation";
import { userDayKey } from "@/lib/tz/format";
import { readCoachCorrelations } from "@/lib/ai/coach/tools/correlations-read";
import {
  humaniseType,
  placeAgainstBand,
  pickDriverForMetric,
  type CoachReadBaseline,
  type CoachReadDriver,
  type CoachReadStripData,
} from "@/lib/insights/derived/coach-read-shape";

export type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * Read the latest reading for `(userId, type)` — the value the strip places
 * against the band. Display-side scaling (e.g. WALKING_SPEED m/s → km/h) is
 * the caller's concern; the strip renders unscaled stored values, and the
 * band is unscaled too, so the placement is scale-invariant.
 */
async function readLatestValue(
  userId: string,
  type: MeasurementType,
): Promise<number | null> {
  const row = await prisma.measurement.findFirst({
    where: { userId, type, deletedAt: null },
    orderBy: { measuredAt: "desc" },
    select: { value: true },
  });
  return row?.value ?? null;
}

/** Trailing window the band engine reads; the day-mean placement matches it. */
const BAND_WINDOW_DAYS = 30;

/**
 * Placement for a type whose day mean depends on how much of the day has
 * passed (`SAME_HOURS_TYPES`, glucose). The band is built from whole-day
 * means, so the value placed against it has to be a day mean as well, never
 * one reading: a fasting reading against whole days reads as low every
 * morning. The latest day is placed by its mean. When that day is the
 * reader's today it is still in progress, and is held against the earlier
 * days cut at the local time of today's latest reading instead of against
 * whole days. With no like-for-like basis for today the result is
 * `"no-basis"` and the strip gives no verdict.
 */
async function placeByDayMean(
  userId: string,
  type: MeasurementType,
  band: { low: number; high: number; sampleDays: number },
  now: Date,
  tz: string,
): Promise<CoachReadBaseline | "no-basis" | null> {
  const latest = await readLatestDayMean(
    userId,
    type,
    BAND_WINDOW_DAYS,
    now,
    tz,
  );
  if (!latest) return null;
  if (latest.day !== userDayKey(now, tz)) {
    return {
      ...band,
      latest: latest.value,
      placement: placeAgainstBand(latest.value, band.low, band.high),
    };
  }
  const standing = await readSameHoursStanding(userId, type, {
    windowDays: BAND_WINDOW_DAYS,
    now,
    tz,
    lastAt: latest.lastAt,
  });
  if (!standing) return "no-basis";
  return {
    low: standing.low,
    high: standing.high,
    latest: standing.value,
    placement: placeAgainstBand(standing.value, standing.low, standing.high),
    sampleDays: standing.days,
    basis: "sameHours",
  };
}

/**
 * Build the "Coach read" strip payload for one metric. Pure orchestration
 * over the baseline + correlations engines; never throws on a partial read
 * (a correlations hiccup degrades line 2 to `null`, the band stands alone).
 */
export async function buildCoachReadStrip(
  userId: string,
  type: MeasurementType,
  /**
   * The reader's locale. Line 2 arrives as a finished sentence and is printed
   * verbatim by both clients, so it has to be written in the reader's language
   * HERE — the strip component only translates the wrapper around it. Required
   * on purpose: while this parameter did not exist, the route said nothing and
   * the sentence came back in English, which is how a German weight page ended
   * up with a German first line and an English second one.
   */
  locale: Locale,
  opts: { tz: string; now?: Date },
): Promise<CoachReadStripData> {
  const now = opts.now ?? new Date();
  const profile = await loadBaselineProfile(prisma, userId);

  const [baselineDerived, latest, correlations] = await Promise.all([
    computeVitalsBaseline(userId, profile, { type, now }),
    readLatestValue(userId, type),
    // Line 2 is best-effort: a correlation failure must never sink the band.
    readCoachCorrelations(userId, locale).catch(
      () => ({ present: false }) as const,
    ),
  ]);

  let baseline: CoachReadBaseline | null = null;
  let learning = false;

  const byDayMean = SAME_HOURS_TYPES.has(type);
  if (isDerivedOk(baselineDerived) && byDayMean) {
    const { low, high, sampleDays } = baselineDerived.value;
    const placed = await placeByDayMean(
      userId,
      type,
      { low, high, sampleDays },
      now,
      opts.tz,
    );
    // Nothing like-for-like to place today against yet: no verdict.
    if (placed === "no-basis" || placed === null) learning = true;
    else baseline = placed;
  } else if (isDerivedOk(baselineDerived) && latest !== null) {
    const { low, high, sampleDays } = baselineDerived.value;
    baseline = {
      low,
      high,
      latest,
      placement: placeAgainstBand(latest, low, high),
      sampleDays,
    };
  } else {
    // Band not established (history below the 7-day floor, or no readings) —
    // the strip says "still learning your range" rather than inventing one.
    learning = true;
  }

  const driver = ((): CoachReadDriver | null => {
    if (!("drivers" in correlations) || !correlations.drivers) return null;
    const picked = pickDriverForMetric(
      correlations.drivers,
      humaniseType(type),
    );
    if (!picked) return null;
    return {
      note: picked.note,
      behaviour: picked.behaviour,
      outcome: picked.outcome,
    };
  })();

  return { baseline, learning, driver };
}
