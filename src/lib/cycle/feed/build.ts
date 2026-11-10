/**
 * Build one calendar feed's body from the record's rows, live (#1350).
 *
 * Nothing is read from the persisted `CyclePrediction`: it can be a day
 * stale, and the feed is computed on every fetch precisely so HealthLog stays
 * the only source of truth. The day-log window is the calendar's default
 * view, so the feed agrees with what the calendar page shows.
 *
 * `today`, the time zone and the language are the RECORD's stored settings,
 * never the request's. A calendar provider fetches from a data centre, in a
 * zone and with an Accept-Language that have nothing to do with the person.
 */
import { prisma } from "@/lib/db";
import {
  defaultCalendarDayLogStart,
  loadCycleEngineInputs,
  loadFlowDays,
} from "@/lib/cycle/load-inputs";
import {
  gatedPrediction,
  toCycleInputs,
  toProfileInput,
} from "@/lib/cycle/engine-adapter";
import { goalAllowsFertileWindow, toCyclePredictionDTO } from "@/lib/cycle/dto";
import { projectCycles, type ProjectionState } from "@/lib/cycle/projection";
import type { CycleProfileInput } from "@/lib/cycle/types";
import { defaultLocale, isLocale, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import { icsContentHash, type IcsCalendar } from "../ics";
import {
  buildFeedCalendar,
  type FeedForecastStyle,
  type FeedTitleMode,
} from "./events";
import { historyPeriods, historyWindowStart } from "./history";

/** The feed options the body depends on. */
export interface FeedOptions {
  id: string;
  horizonCycles: number;
  historyCycles: number;
  includeFertile: boolean;
  titleMode: FeedTitleMode;
  forecastStyle: FeedForecastStyle;
}

/** The record the feed serves, as far as building it needs. */
export interface FeedSubject {
  id: string;
  timezone: string | null;
  locale: string | null;
}

export interface BuiltFeed {
  calendar: IcsCalendar;
  /** SHA-256 of the body without its stamps. Doubles as the ETag. */
  contentHash: string;
  projectionState: ProjectionState;
}

/**
 * The language the feed's descriptive titles use: the record's stored one, or
 * the instance default. Deliberately not `resolveServerLocale`, which would
 * fall back to the request's cookies and Accept-Language — the provider's,
 * not the person's.
 */
export function feedLocale(stored: string | null): Locale {
  return isLocale(stored) ? stored : defaultLocale;
}

/** The engine's defaults, for a record whose profile row was never created. */
const DEFAULT_PROFILE: CycleProfileInput = {
  goal: "GENERAL_HEALTH",
  typicalCycleLength: null,
  typicalPeriodLength: null,
  lutealPhaseLength: null,
  predictionEnabled: true,
  rawChartMode: false,
};

export async function buildCycleFeed(
  feed: FeedOptions,
  subject: FeedSubject,
  now: Date = new Date(),
): Promise<BuiltFeed> {
  const tz = subject.timezone ?? DEFAULT_TIMEZONE;
  const today = moodDateKey(now, tz);

  const [profileRow, inputs] = await Promise.all([
    prisma.cycleProfile.findUnique({ where: { userId: subject.id } }),
    loadCycleEngineInputs({
      userId: subject.id,
      today,
      tz,
      dayLogsFrom: defaultCalendarDayLogStart(today),
    }),
  ]);
  const profile = profileRow ? toProfileInput(profileRow) : DEFAULT_PROFILE;

  const prediction = gatedPrediction(profile, inputs, today);
  const projection = projectCycles({
    prediction,
    cycles: toCycleInputs(inputs.cycles),
    dayLogs: inputs.dayLogs,
    goal: profile.goal,
    today,
    horizon: feed.horizonCycles,
  });

  // The fertile window: the next cycle's, for a conception goal that asked
  // for it, and read off the gated DTO rather than the raw result so the
  // cold-start suppression applies here exactly as it does on every other
  // surface. Never for AVOID_PREGNANCY: a calendar event cannot carry the
  // "not a contraceptive method" caveat, and a fertile window without it is
  // the one thing this feature must not hand out.
  let fertile: { start: string; end: string } | null = null;
  if (
    feed.includeFertile &&
    profile.goal === "TRYING_TO_CONCEIVE" &&
    prediction !== null &&
    projection.cycles.length > 0
  ) {
    const dto = toCyclePredictionDTO(
      prediction,
      goalAllowsFertileWindow(profile.goal),
      "",
    );
    if (dto.fertileWindowStart && dto.fertileWindowEnd) {
      fertile = { start: dto.fertileWindowStart, end: dto.fertileWindowEnd };
    }
  }

  let history: ReturnType<typeof historyPeriods> = [];
  const historyFrom = historyWindowStart(
    inputs.cycles,
    today,
    feed.historyCycles,
  );
  if (historyFrom !== null) {
    const flowDays = await loadFlowDays(subject.id, historyFrom);
    history = historyPeriods(
      inputs.cycles,
      flowDays,
      today,
      feed.historyCycles,
    );
  }

  const calendar = buildFeedCalendar({
    feedId: feed.id,
    titleMode: feed.titleMode,
    forecastStyle: feed.forecastStyle,
    projected: projection.cycles,
    history,
    fertile,
    translator: getServerTranslator(feedLocale(subject.locale)),
  });

  return {
    calendar,
    contentHash: icsContentHash(calendar),
    projectionState: projection.state,
  };
}
