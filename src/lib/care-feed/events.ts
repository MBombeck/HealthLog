/**
 * The care calendar feed's events: booked visits, check-ups coming due and
 * vaccination boosters coming due.
 *
 * Pure. What an event may carry is decided here and nowhere else: a date, a
 * time for an appointment, and a title. Never a visit's reason, outcome or
 * body site, a check-up's location, a note, or anything else the record
 * holds; `care-feed-content.test.ts` seeds those and asserts the body
 * carries none of them.
 *
 * DISCREET (the default) titles every event with a dot and names the calendar
 * "HealthLog", so a glance at a shared screen or a lock screen says nothing.
 * DESCRIPTIVE names the appointment's practitioner and the check-up's own
 * label, in the record's language.
 */
import { addDays } from "@/lib/cycle/day-math";
import { eventUid, type IcsCalendar, type IcsEvent } from "@/lib/cycle/ics";
import {
  DISCREET_CALENDAR_NAME,
  DISCREET_SUMMARY,
} from "@/lib/cycle/feed/events";
import type { ServerTranslator } from "@/lib/i18n/server-translator";

export type CareFeedTitleMode = "DISCREET" | "DESCRIPTIVE";

/** How long an appointment is drawn; a visit stores a start, never an end. */
export const VISIT_EVENT_MINUTES = 60;

/** The most events one body carries; the earliest ones in the window win. */
export const MAX_CARE_EVENTS = 300;

export interface CareVisit {
  id: string;
  occurredAt: Date;
  /** The practitioner's name, or null when the visit names none. */
  practitioner: string | null;
}

export interface CareDue {
  id: string;
  /** The day it comes due, `YYYY-MM-DD` in the record's zone. */
  day: string;
  /** The check-up's own label. */
  label: string;
  /** A vaccination booster rather than a check-up. */
  booster: boolean;
}

export interface CareEventInput {
  feedId: string;
  titleMode: CareFeedTitleMode;
  visits: readonly CareVisit[];
  dues: readonly CareDue[];
  translator: ServerTranslator;
}

function visitEvent(v: CareVisit, input: CareEventInput): IcsEvent {
  const descriptive = input.titleMode === "DESCRIPTIVE";
  return {
    uid: eventUid(input.feedId, `visit:${v.id}`),
    startAt: v.occurredAt,
    endAt: new Date(v.occurredAt.getTime() + VISIT_EVENT_MINUTES * 60_000),
    summary: !descriptive
      ? DISCREET_SUMMARY
      : v.practitioner
        ? input.translator.t("careFeed.ics.visitWith", {
            name: v.practitioner,
          })
        : input.translator.t("careFeed.ics.visit"),
  };
}

function dueEvent(d: CareDue, input: CareEventInput): IcsEvent {
  const descriptive = input.titleMode === "DESCRIPTIVE";
  return {
    uid: eventUid(input.feedId, `due:${d.id}`),
    start: d.day,
    endExclusive: addDays(d.day, 1),
    summary: !descriptive
      ? DISCREET_SUMMARY
      : input.translator.t(
          d.booster ? "careFeed.ics.boosterDue" : "careFeed.ics.checkupDue",
          { label: d.label },
        ),
  };
}

/** When an event happens, for ordering: a due day counts from its midnight. */
function sortKey(event: IcsEvent): number {
  return "startAt" in event
    ? event.startAt.getTime()
    : // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: an ordering key only, it never names a person's day, and a few hours either way cannot move a date past an appointment on another day
      Date.parse(`${event.start}T00:00:00Z`);
}

/** The whole calendar the feed serves, events in time order. */
export function buildCareCalendar(input: CareEventInput): IcsCalendar {
  const events = [
    ...input.visits.map((v) => visitEvent(v, input)),
    ...input.dues.map((d) => dueEvent(d, input)),
  ]
    .sort((a, b) => sortKey(a) - sortKey(b) || a.uid.localeCompare(b.uid))
    .slice(0, MAX_CARE_EVENTS);
  return {
    name:
      input.titleMode === "DESCRIPTIVE"
        ? input.translator.t("careFeed.ics.calendarName")
        : DISCREET_CALENDAR_NAME,
    events,
  };
}
