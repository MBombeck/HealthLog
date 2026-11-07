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
 */
import { addDays, dayDiff } from "@/lib/cycle/day-math";
import type { ProjectedCycle } from "@/lib/cycle/projection";
import { pluralKey } from "@/lib/i18n/plural";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { ServerTranslator } from "@/lib/i18n/server-translator";

import { eventUid, type IcsCalendar, type IcsEvent } from "../ics";

export type FeedTitleMode = "DISCREET" | "DESCRIPTIVE";

/** The discreet title: one dot, no word. */
export const DISCREET_SUMMARY = "●";
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

function forecastEvent(p: ProjectedCycle, input: FeedEventInput): IcsEvent {
  const { translator } = input;
  const band = dayDiff(p.bandEnd, p.start);
  const descriptive = input.titleMode === "DESCRIPTIVE";
  return {
    uid: eventUid(input.feedId, `pred:${p.k}`),
    // The whole window the period may fall in: earliest likely start through
    // the last bleeding day of the latest likely start. DTEND is exclusive.
    start: p.bandStart,
    endExclusive: addDays(p.bandEnd, p.periodLength),
    summary: descriptive
      ? translator.t("cycle.feed.ics.periodEstimate")
      : DISCREET_SUMMARY,
    description: descriptive
      ? translator.t("cycle.feed.ics.likelyStart", {
          date: shortDate(p.start, translator),
          band: bandText(band, translator),
        })
      : bandText(band, translator),
  };
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
    ...input.projected.map((p) => forecastEvent(p, input)),
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
