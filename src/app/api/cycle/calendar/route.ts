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
  toCycleInputs,
  toDayLogInputs,
} from "@/lib/cycle/engine-adapter";
import {
  CALENDAR_DEFAULT_PAST_DAYS,
  dayLogWindowStart,
  loadCalendarInputs,
} from "@/lib/cycle/load-inputs";
import { PROJECTION_MAX_HORIZON, projectCycles } from "@/lib/cycle/projection";
import {
  toCyclePredictionDTO,
  goalAllowsFertileWindow,
  cycleDisclaimerKey,
} from "@/lib/cycle/dto";
import { resolveCycleVerdict } from "@/lib/cycle/verdict";
import { addDays } from "@/lib/cycle/day-math";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

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
  const from = parsed.data.from ?? addDays(today, -CALENDAR_DEFAULT_PAST_DAYS);
  const to = parsed.data.to ?? addDays(today, DEFAULT_FORWARD_DAYS);

  // Reject an inverted or absurdly wide range up front.
  const fromMs = Date.parse(`${from}T12:00:00Z`);
  const toMs = Date.parse(`${to}T12:00:00Z`);
  if (toMs < fromMs || (toMs - fromMs) / 86_400_000 > MAX_SPAN_DAYS) {
    return apiError("Calendar range too wide or inverted", 422, {
      errorCode: "cycle.calendar.range",
    });
  }

  // One loader for the forecast's inputs, shared with the Coach block and the
  // calendar feed (`load-inputs.ts`). The day-log read is bounded to the
  // rendered span plus the symptothermal lookback. Cycle lengths come from the
  // MenstrualCycle rows; the window only reaches the period-length fallback,
  // which is why the readers that promise to agree with this page read the
  // default view's window (`defaultCalendarDayLogStart`).
  const { cycles, dayLogs, nights } = await loadCalendarInputs({
    userId: user.id,
    today,
    tz,
    dayLogsFrom: dayLogWindowStart(from, today),
  });

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

  // The cycles beyond the next one, from the same engine run. Read by the
  // predictions panel; the calendar feed serves the same projection, so a
  // client never extrapolates further dates itself. Fertile fields stay in
  // `prediction.*`, where the goal and cold-start gates already apply.
  const projection = projectCycles({
    prediction,
    cycles: toCycleInputs(cycles),
    dayLogs: toDayLogInputs(dayLogs),
    goal: profile.goal,
    today,
    horizon: PROJECTION_MAX_HORIZON,
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
    // Additive (#1350): the next cycles with their widening bands, and why
    // the list holds what it holds (OK / LEARNING / LATE / OFF).
    projection: projection.cycles,
    projectionState: projection.state,
    days,
    meta: { generatedAt },
  });
});
