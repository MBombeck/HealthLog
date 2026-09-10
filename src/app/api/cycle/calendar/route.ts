/**
 * `GET /api/cycle/calendar?from&to` — predicted calendar read
 * (ios-contract §2.D).
 *
 * Calls the pure engine (`predictCycle` + per-day phase) to build
 * `{ profile, prediction, days }`. The engine call is cheap (pure stats) and
 * the route writes nothing — the `CyclePrediction` row the reminder cron
 * reads is owned by the `cycle-prediction-refresh` job.
 * Fertile-window fields are goal-gated (surfaced for TRYING_TO_CONCEIVE and
 * AVOID_PREGNANCY — the latter with the stronger "not a contraceptive method"
 * disclaimer; suppressed for GENERAL_HEALTH / PERIMENOPAUSE / OFF),
 * resolved server-side.
 *
 * Default range: current cycle − 90d … +180d forward.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { cycleCalendarQuerySchema } from "@/lib/validations/cycle";
import {
  buildCalendar,
  type CalendarDayLogRow,
} from "@/lib/cycle/engine-adapter";
import {
  toCyclePredictionDTO,
  goalAllowsFertileWindow,
  cycleDisclaimerKey,
} from "@/lib/cycle/dto";
import { resolveCycleVerdict } from "@/lib/cycle/verdict";
import { addDays, dayDiff } from "@/lib/cycle/day-math";
import { BBT_WINDOW } from "@/lib/cycle/types";
import { DEFAULT_TIMEZONE, moodDateKey } from "@/lib/mood/date-key";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

const DEFAULT_PAST_DAYS = 90;
const DEFAULT_FORWARD_DAYS = 180;
/** Hard cap on the rendered span (days) to bound the day-grid build. */
const MAX_SPAN_DAYS = 400;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;
  const profile = gate.profile;

  const url = new URL(request.url);
  const parsed = cycleCalendarQuerySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return apiValidationError(
      "Invalid calendar query",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "cycle.calendar.invalid",
      },
    );
  }

  const tz = user.timezone ?? DEFAULT_TIMEZONE;
  const today = moodDateKey(new Date(), tz);
  const from = parsed.data.from ?? addDays(today, -DEFAULT_PAST_DAYS);
  const to = parsed.data.to ?? addDays(today, DEFAULT_FORWARD_DAYS);

  // Reject an inverted or absurdly wide range up front.
  const fromMs = Date.parse(`${from}T12:00:00Z`);
  const toMs = Date.parse(`${to}T12:00:00Z`);
  if (toMs < fromMs || (toMs - fromMs) / 86_400_000 > MAX_SPAN_DAYS) {
    return apiError("Calendar range too wide or inverted", 422, {
      errorCode: "cycle.calendar.range",
    });
  }

  const [cycles, dayLogRows, nightlyTemps] = await Promise.all([
    prisma.menstrualCycle.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { startDate: "asc" },
    }),
    // Bound the day-log read to the rendered span plus the symptothermal
    // lookback — the earlier of `from` and (today − BBT_WINDOW). Cycle-length
    // stats run off MenstrualCycle rows, so day-logs can be windowed (QA: perf
    // — unbounded full-history read on a hot, per-navigation route).
    prisma.cycleDayLog.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        date: {
          gte:
            dayDiff(from, addDays(today, -BBT_WINDOW)) <= 0
              ? from
              : addDays(today, -BBT_WINDOW),
        },
      },
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
        _count: { select: { symptomLinks: true } },
      },
    }),
    // Apple Watch wrist/skin temperature feeds the temperature-trend
    // ovulation layer. Read the WRIST_TEMPERATURE measurements as nightly
    // values; the engine derives the trailing-mean deviation itself.
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
  ]);

  const dayLogs: CalendarDayLogRow[] = dayLogRows.map((l) => ({
    date: l.date,
    flow: l.flow,
    basalBodyTempC: l.basalBodyTempC,
    temperatureExcluded: l.temperatureExcluded,
    ovulationTest: l.ovulationTest,
    cervicalMucus: l.cervicalMucus,
    cervixPosition: l.cervixPosition,
    cervixFirmness: l.cervixFirmness,
    cervixOpening: l.cervixOpening,
    hasSymptoms: l._count.symptomLinks > 0,
  }));

  const nights = nightlyTemps.map((m) => ({
    date: moodDateKey(m.measuredAt, tz),
    valueC: m.value,
  }));

  const goalAllowsFertile = goalAllowsFertileWindow(profile.goal);

  const { prediction, stillLearning, days } = buildCalendar(
    profile,
    cycles,
    dayLogs,
    nights,
    from,
    to,
    today,
    goalAllowsFertile,
  );

  // v1.35.3 — this read persists nothing. It used to fire
  // `void persistPredictionCache(...)`: a write on a GET, and a discarded
  // promise on top, so a failed write left no trace at all. The forecast the
  // response carries is computed right here from the account's rows; the
  // `CyclePrediction` row the reminder cron scans is written by the
  // `cycle-prediction-refresh` job, which reaches every tracking account
  // rather than the ones that opened this page.
  const generatedAt = new Date().toISOString();

  const locale = await resolveServerLocale({
    request,
    userLocale: user.locale ?? undefined,
  });
  const t = getServerTranslator(locale);
  // AVOID_PREGNANCY surfaces the fertile window, so it must carry the stronger
  // "not a contraceptive method" caveat (QA H-1).
  const disclaimer = t.t(cycleDisclaimerKey(profile.goal));

  const predictionDto = prediction
    ? toCyclePredictionDTO(prediction, goalAllowsFertile, disclaimer)
    : null;

  // The resolved verdict. Built from the SAME grid the response carries and
  // from the ALREADY-GATED prediction DTO, never the raw engine result — a
  // fertile window suppressed for the profile's goal or by the cold-start gate
  // cannot reappear here. `today` is the user's timezone day, which is the
  // other half of why this cannot be a client-side derivation: a browser in a
  // different zone resolves a different "today" and reads a different cycle day.
  const verdict = resolveCycleVerdict({
    days,
    today,
    profile: {
      typicalCycleLength: profile.typicalCycleLength,
      typicalPeriodLength: profile.typicalPeriodLength,
      lutealPhaseLength: profile.lutealPhaseLength,
    },
    nextPeriodStart: predictionDto?.nextPeriodStart ?? null,
    fertileWindowStart: predictionDto?.fertileWindowStart ?? null,
    fertileWindowEnd: predictionDto?.fertileWindowEnd ?? null,
    // The latest start the person logged, read off the cycle rows rather than
    // the grid. The grid's phase band is withheld while the engine is still
    // learning, and the day count must not go with it — `cycles` is ordered by
    // startDate ascending, so the last one at or before today is the anchor.
    lastPeriodStart:
      cycles.filter((c) => c.startDate <= today).at(-1)?.startDate ?? null,
  });

  annotate({
    action: { name: "cycle.calendar.read" },
    meta: {
      days: days.length,
      cycles_observed: prediction?.cyclesObserved ?? 0,
      has_prediction: prediction !== null,
      verdict_state: verdict.state,
    },
  });

  return apiSuccess({
    profile: {
      goal: profile.goal,
      rawChartMode: profile.rawChartMode,
      predictionEnabled: profile.predictionEnabled,
      // Single source of truth for the observed-cycle count: the engine's
      // post-exclusion `cyclesObserved` (the same number the prediction and the
      // `stillLearning` gate key off). The raw `cycles.length` fallback only
      // applies when no prediction ran (raw-chart mode / prediction disabled),
      // so a consumer never sees two divergent "cycles observed" values.
      cyclesObserved: prediction?.cyclesObserved ?? cycles.length,
    },
    prediction: predictionDto,
    // The one resolved answer about today: cycle day, the ring's arcs, how
    // many days until the next period, and whether the period is late and by
    // how much. Every client renders this; none of them recomputes it.
    verdict,
    // Top-level cold-start flag (mirrors `prediction.stillLearning`): the
    // calendar grid has suppressed fertile/ovulation/phase output, so the
    // client renders a calm "learning your cycle" banner over the grid. Additive
    // + back-compatible — older iOS builds ignore the field.
    stillLearning,
    days,
    meta: { generatedAt },
  });
});
