/**
 * The calendar feed's events, from the projection, the record's history and
 * (for a conception goal that asked for it) the next fertile window (#1350).
 *
 * Pure. What an event may carry is decided here and nowhere else, and it is
 * dates and a title: never a symptom, a note, a flow level, a temperature, a
 * test result, the intent fields or anything else the day log holds. The
 * content-leak guard (`cycle-feed-content-guard.test.ts`) seeds every one of
 * those and asserts the rendered body contains none of them.
 *
 * DISCREET (the default) titles every event with a dot and names the calendar
 * "HealthLog", so a glance at a shared screen or a lock-screen notification
 * says nothing. DESCRIPTIVE names the period, in the record's own language.
 *
 * A forecast period is drawn in one of three styles. EXACT is the period as
 * calculated: the most likely first day for the predicted number of bleeding
 * days. MARGIN is the same event, plus the days the period may start earlier
 * or run on later as their own "possible" events, so the calculated days stay
 * readable as such. BAND is one event over every day the period may fall on,
 * from the earliest likely start to the last bleeding day of the latest.
 */
import { addDays, dayDiff } from "@/lib/cycle/day-math";
import type { ProjectedCycle } from "@/lib/cycle/projection";
import { pluralKey } from "@/lib/i18n/plural";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { ServerTranslator } from "@/lib/i18n/server-translator";

import { eventUid, type IcsCalendar, type IcsEvent } from "../ics";

export type FeedTitleMode = "DISCREET" | "DESCRIPTIVE";
export type FeedForecastStyle = "EXACT" | "MARGIN" | "BAND";

/** The discreet title: one dot, no word. */
export const DISCREET_SUMMARY = "●";
/** The discreet title of a MARGIN style's possible days: an open dot. */
export const DISCREET_MARGIN_SUMMARY = "○";
/** The discreet calendar name. */
export const DISCREET_CALENDAR_NAME = "HealthLog";

/** One logged period, as far as the feed draws it. */
export interface HistoryPeriod {
  cycleId: string;
  /** First bleeding day. */
  start: string;
  /** Last bleeding day, inclusive. */
  end: string;
}

export interface FeedEventInput {
  feedId: string;
  titleMode: FeedTitleMode;
  forecastStyle: FeedForecastStyle;
  projected: readonly ProjectedCycle[];
  history: readonly HistoryPeriod[];
  /** The next fertile window, already gated; null when not shown. */
  fertile: { start: string; end: string } | null;
  translator: ServerTranslator;
}

/** "12 Nov" in the record's language, for the descriptive description. */
function shortDate(day: string, translator: ServerTranslator): string {
  return new Intl.DateTimeFormat(resolveIntlLocale(translator.locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

/** "±3 days", pluralised in the record's language. */
function bandText(days: number, translator: ServerTranslator): string {
  return translator.t(
    pluralKey("cycle.feed.ics.band", days, translator.locale),
    { count: days },
  );
}

/** The forecast's description: the likely start and the band, or the band. */
function forecastDescription(p: ProjectedCycle, input: FeedEventInput): string {
  const { translator } = input;
  const band = bandText(dayDiff(p.bandEnd, p.start), translator);
  return input.titleMode === "DESCRIPTIVE"
    ? translator.t("cycle.feed.ics.likelyStart", {
        date: shortDate(p.start, translator),
        band,
      })
    : band;
}

/**
 * One forecast cycle's events. DTEND is exclusive throughout, so the period
 * itself ends the day after its last bleeding day.
 */
function forecastEvents(p: ProjectedCycle, input: FeedEventInput): IcsEvent[] {
  const { translator } = input;
  const descriptive = input.titleMode === "DESCRIPTIVE";
  const description = forecastDescription(p, input);
  const periodSummary = descriptive
    ? translator.t("cycle.feed.ics.periodEstimate")
    : DISCREET_SUMMARY;

  if (input.forecastStyle === "BAND") {
    return [
      {
        uid: eventUid(input.feedId, `pred:${p.k}`),
        // The whole window the period may fall in: earliest likely start
        // through the last bleeding day of the latest likely start.
        start: p.bandStart,
        endExclusive: addDays(p.bandEnd, p.periodLength),
        summary: periodSummary,
        description,
      },
    ];
  }

  const periodEnd = addDays(p.start, p.periodLength);
  const events: IcsEvent[] = [
    {
      uid: eventUid(input.feedId, `pred:${p.k}`),
      start: p.start,
      endExclusive: periodEnd,
      summary: periodSummary,
      description,
    },
  ];
  if (input.forecastStyle === "EXACT") return events;

  const marginSummary = descriptive
    ? translator.t("cycle.feed.ics.periodPossible")
    : DISCREET_MARGIN_SUMMARY;
  // The days before the likely start it may begin on, and the days after the
  // likely period it may still run on. A side with no band has no event.
  if (dayDiff(p.start, p.bandStart) > 0) {
    events.push({
      uid: eventUid(input.feedId, `pred:${p.k}:before`),
      start: p.bandStart,
      endExclusive: p.start,
      summary: marginSummary,
      description,
    });
  }
  const bandEndExclusive = addDays(p.bandEnd, p.periodLength);
  if (dayDiff(bandEndExclusive, periodEnd) > 0) {
    events.push({
      uid: eventUid(input.feedId, `pred:${p.k}:after`),
      start: periodEnd,
      endExclusive: bandEndExclusive,
      summary: marginSummary,
      description,
    });
  }
  return events;
}

function historyEvent(h: HistoryPeriod, input: FeedEventInput): IcsEvent {
  return {
    uid: eventUid(input.feedId, `obs:${h.cycleId}`),
    start: h.start,
    endExclusive: addDays(h.end, 1),
    summary:
      input.titleMode === "DESCRIPTIVE"
        ? input.translator.t("cycle.feed.ics.periodLogged")
        : DISCREET_SUMMARY,
  };
}

function fertileEvent(
  window: { start: string; end: string },
  input: FeedEventInput,
): IcsEvent {
  return {
    uid: eventUid(input.feedId, "fertile:1"),
    start: window.start,
    endExclusive: addDays(window.end, 1),
    summary:
      input.titleMode === "DESCRIPTIVE"
        ? input.translator.t("cycle.feed.ics.fertileEstimate")
        : DISCREET_SUMMARY,
  };
}

/** The whole calendar the feed serves, events in date order. */
export function buildFeedCalendar(input: FeedEventInput): IcsCalendar {
  const events: IcsEvent[] = [
    ...input.history.map((h) => historyEvent(h, input)),
    ...input.projected.flatMap((p) => forecastEvents(p, input)),
    ...(input.fertile ? [fertileEvent(input.fertile, input)] : []),
  ].sort((a, b) => dayDiff(a.start, b.start) || a.uid.localeCompare(b.uid));
  return {
    name:
      input.titleMode === "DESCRIPTIVE"
        ? input.translator.t("cycle.feed.ics.calendarName")
        : DISCREET_CALENDAR_NAME,
    events,
  };
}
