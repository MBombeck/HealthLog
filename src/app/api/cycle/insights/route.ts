/**
 * `GET /api/cycle/insights` — cycle-phase × vital correlation insights
 * (integration-audit §1 + §3 "INSIGHTS").
 *
 * The gender-gated home for the CYCLE_PHASE correlation. The general
 * `/api/insights/correlations` route is NOT gender-gated, so phase — and the
 * temperature channels a phase relation rides on — must never surface there;
 * this route is the deliberate, gated place they do.
 *
 * Surfaces the FDR-guarded LUTEAL-vs-FOLLICULAR phase contrast per outcome
 * metric (the same Welch + Benjamini-Hochberg machinery the mood-factor
 * crosstab runs) plus the ONE headline insight (resting-heart-rate-by-phase,
 * falling back to HRV) for the v1.15.0 card. Honest: n / effect size / q are
 * shown, every row is FDR-gated, nothing is fabricated on thin data, nothing
 * is causal.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { predictCycle, type NightlyTempInput } from "@/lib/cycle";
import { LUTEAL_DEFAULT } from "@/lib/cycle/types";
import {
  buildPhaseDayMap,
  toCycleInputs,
  toDayLogInputs,
  toProfileInput,
} from "@/lib/cycle/engine-adapter";
import {
  computePhaseMetricCrosstab,
  discoverPhaseCorrelations,
  selectHeadlinePhaseRow,
  PHASE_CROSSTAB_METRIC_TYPES,
  MOOD_CHANNEL_KEY,
} from "@/lib/cycle/phase-crosstab";
import type { CrossMetricMeasurement } from "@/lib/insights/mood-aggregates";
import {
  computeSymptomPhasePatterns,
  type SymptomDay,
} from "@/lib/cycle/symptom-phase";
import { addDays } from "@/lib/cycle/day-math";
import { DEFAULT_TIMEZONE, moodDateKey } from "@/lib/mood/date-key";

/** Trailing window the phase-contrast walks (days). */
const WINDOW_DAYS = 365;

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user, grantId } = await requireRecordAuth("read", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;
  const profile = gate.profile;

  // This route runs the FDR phase-contrast over a 365-day window — the most
  // compute-heavy read in the cycle vertical. Cap repeated hits so a single
  // authenticated session can't spin it for a self-inflicted compute DoS.
  const rl = await checkRateLimit(`cycle:insights:${user.id}`, 30, 60_000);
  if (!rl.allowed) {
    return apiError("Too many requests, try again later", 429);
  }

  const tz = user.timezone ?? DEFAULT_TIMEZONE;
  const today = moodDateKey(new Date(), tz);
  const from = addDays(today, -WINDOW_DAYS);

  // The crosstab is a cycle surface that reads two other sections. The phase
  // labels are cycle data; the outcome columns are not. `lutealAvg`,
  // `follicularAvg` and `delta` ship resting heart rate, HRV, sleep duration,
  // steps, weight, temperature, glucose and the mood score in display units,
  // and a grant scoped to the cycle alone was never consent for any of them.
  // So the two foreign channels are fenced at the query, not at the response:
  // a section the caller is outside of is never read, so nothing downstream
  // can leak it back — the rows simply do not exist, exactly as they do not
  // for a record with no measurements.
  const visible = await actingDomainVisibility(prisma, grantId);
  const seesMeasurements = visible("measurements");
  const seesMind = visible("mind");

  const [
    cycles,
    dayLogRows,
    nightlyTempRows,
    measurementRows,
    prefsRow,
    moodRows,
  ] = await Promise.all([
    prisma.menstrualCycle.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { startDate: "asc" },
    }),
    // Bound the day-log read to the rendered window (`from` = today − 365d),
    // which is already earlier than the symptothermal lookback. Cycle-length
    // stats run off MenstrualCycle rows so the day-logs can be windowed (QA:
    // perf — unbounded full-history read).
    prisma.cycleDayLog.findMany({
      where: { userId: user.id, deletedAt: null, date: { gte: from } },
      orderBy: { date: "asc" },
      select: {
        date: true,
        flow: true,
        basalBodyTempC: true,
        temperatureExcluded: true,
        ovulationTest: true,
        cervicalMucus: true,
        cervixPosition: true,
        cervixFirmness: true,
        cervixOpening: true,
        symptomLinks: { select: { symptom: { select: { key: true } } } },
      },
    }),
    // Passive wrist temperature feeds the temperature-trend ovulation layer
    // (used only to sharpen the prediction's next-start the phase-day map
    // extends to). Not a crosstab input.
    prisma.measurement.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        type: "WRIST_TEMPERATURE",
        measuredAt: {
          gte: new Date(Date.parse(`${addDays(today, -90)}T00:00:00Z`)),
        },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
    // The outcome metrics the phase contrast compares — soft-delete-scoped,
    // canonical-source deduped per day inside `metricDayMap`. Skipped whole
    // for a caller outside `measurements`.
    seesMeasurements
      ? prisma.measurement.findMany({
          where: {
            userId: user.id,
            deletedAt: null,
            type: { in: PHASE_CROSSTAB_METRIC_TYPES },
            measuredAt: {
              gte: new Date(Date.parse(`${from}T00:00:00Z`)),
            },
          },
          orderBy: { measuredAt: "asc" },
          select: {
            type: true,
            value: true,
            measuredAt: true,
            source: true,
            deviceType: true,
          },
        })
      : [],
    prisma.user.findUnique({
      where: { id: user.id },
      select: { sourcePriorityJson: true },
    }),
    // MOOD outcome (QA HIGH): mood lives in MoodEntry (1–5 score), not a
    // Measurement row, so read it here and inject it into the crosstab as a
    // synthetic MOOD_CHANNEL_KEY measurement (same FDR / day-floor guards).
    // Skipped whole for a caller outside `mind`.
    seesMind
      ? prisma.moodEntry.findMany({
          where: {
            userId: user.id,
            deletedAt: null,
            moodLoggedAt: { gte: new Date(Date.parse(`${from}T00:00:00Z`)) },
          },
          orderBy: { moodLoggedAt: "asc" },
          select: { score: true, moodLoggedAt: true },
        })
      : [],
  ]);

  // The latest open cycle runs to the predicted next-period start so the
  // trailing window is phase-labelled even before the next period is logged.
  const nights: NightlyTempInput[] = nightlyTempRows.map((m) => ({
    date: moodDateKey(m.measuredAt, tz),
    valueC: m.value,
  }));
  const prediction =
    profile.predictionEnabled && !profile.rawChartMode
      ? predictCycle(
          toCycleInputs(cycles),
          toDayLogInputs(dayLogRows),
          toProfileInput(profile),
          today,
          nights,
        )
      : null;

  const phaseByDay = buildPhaseDayMap(
    cycles,
    prediction?.nextPeriodStart ?? null,
    profile.lutealPhaseLength ?? LUTEAL_DEFAULT,
    from,
    today,
    today,
  );

  const measurements: CrossMetricMeasurement[] = measurementRows.map((m) => ({
    type: m.type,
    value: m.value,
    measuredAt: m.measuredAt,
    source: m.source,
    deviceType: m.deviceType,
  }));
  // Inject mood as a synthetic MOOD_CHANNEL_KEY series (no source ladder — the
  // metricDayMap pass-through keeps every row, averaging multiple same-day
  // entries like every other channel).
  for (const m of moodRows) {
    measurements.push({
      type: MOOD_CHANNEL_KEY,
      value: m.score,
      measuredAt: m.moodLoggedAt,
      source: null,
      deviceType: null,
    });
  }

  const userPriorityJson = prefsRow?.sourcePriorityJson ?? null;

  // Mechanism A — the categorical luteal-vs-follicular contrast (the headline
  // surface). Mechanism B — the continuous CYCLE_PHASE ordinal folded into the
  // lagged-Pearson FDR matrix. Both are FDR-gated; both live only here.
  const rows = computePhaseMetricCrosstab({
    phaseByDay,
    measurements,
    userPriorityJson,
  });
  const headline = selectHeadlinePhaseRow(rows);
  // The lagged rows are served with their narrated `interpretation` intact, so
  // the reader's language is resolved here the same way the correlations route
  // resolves it. This surface had the same silent-English gap the metric-page
  // strip had.
  const locale = await resolveServerLocale({ userLocale: user.locale ?? null });
  const lagged = discoverPhaseCorrelations({
    phaseByDay,
    measurements,
    userPriorityJson,
    locale,
  });

  // Cycle-NATIVE insight: where each logged symptom clusters across the phases.
  const symptomDays: SymptomDay[] = dayLogRows.map((d) => ({
    date: d.date,
    keys: d.symptomLinks.map((l) => l.symptom.key),
  }));
  const symptomPatterns = computeSymptomPhasePatterns(symptomDays, phaseByDay);

  annotate({
    action: { name: "cycle.insights.read" },
    meta: {
      labelled_days: phaseByDay.size,
      cycles_observed: cycles.length,
      rows: rows.length,
      has_headline: headline !== null,
      lagged_discovered: lagged.discovered.length,
      lagged_pairs_tested: lagged.pairsTested,
      symptom_patterns: symptomPatterns.length,
      measurements_visible: seesMeasurements,
      mind_visible: seesMind,
    },
  });

  return apiSuccess({
    rows,
    headline,
    lagged: {
      discovered: lagged.discovered,
      pairsTested: lagged.pairsTested,
      fdrQ: lagged.fdrQ,
      minPairs: lagged.minPairs,
    },
    symptomPatterns,
    contrast: { high: "LUTEAL", low: "FOLLICULAR" },
    windowDays: WINDOW_DAYS,
    cyclesObserved: cycles.length,
  });
});
