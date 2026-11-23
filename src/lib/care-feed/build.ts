/**
 * Build one care calendar feed's body from the record's rows, live.
 *
 * Booked visits come from `Encounter` (status PLANNED); check-ups and
 * vaccination boosters from the reminder engine's own `nextDueAt`, the same
 * server-computed instant the check-ups page shows. A booked visit's one-shot
 * reminder (`origin: ENCOUNTER`) is not a check-up and is excluded, as on
 * every Vorsorge surface, so an appointment is drawn once, at its time.
 *
 * `today`, the zone and the language are the RECORD's stored settings, never
 * the request's: a calendar provider fetches from a data centre.
 */
import { prisma } from "@/lib/db";
import { feedLocale } from "@/lib/cycle/feed/build";
import { icsContentHash, type IcsCalendar } from "@/lib/cycle/ics";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { isModuleEnabled } from "@/lib/modules/gate";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import {
  MAX_CARE_EVENTS,
  buildCareCalendar,
  type CareDue,
  type CareFeedTitleMode,
} from "./events";

/** How far back the feed keeps a date, so a calendar does not drop it the
 *  moment it passes. */
export const CARE_FEED_PAST_DAYS = 30;
/** How far ahead it looks. A yearly check-up is always in view. */
export const CARE_FEED_AHEAD_DAYS = 400;

const DAY_MS = 86_400_000;

export interface CareFeedOptions {
  id: string;
  includeVisits: boolean;
  includeCheckups: boolean;
  includeVaccinations: boolean;
  titleMode: CareFeedTitleMode;
}

export interface CareFeedSubject {
  id: string;
  timezone: string | null;
  locale: string | null;
}

export interface BuiltCareFeed {
  calendar: IcsCalendar;
  /** SHA-256 of the body without its stamps. Doubles as the ETag. */
  contentHash: string;
}

export async function buildCareFeed(
  feed: CareFeedOptions,
  subject: CareFeedSubject,
  now: Date = new Date(),
): Promise<BuiltCareFeed> {
  const tz = subject.timezone ?? DEFAULT_TIMEZONE;
  const from = new Date(now.getTime() - CARE_FEED_PAST_DAYS * DAY_MS);
  const until = new Date(now.getTime() + CARE_FEED_AHEAD_DAYS * DAY_MS);
  // Boosters follow the vaccinations module: a person who switched it off
  // does not get its dates in a calendar either.
  const boostersOn =
    feed.includeVaccinations &&
    (await isModuleEnabled(subject.id, "vaccinations"));
  const wantReminders = feed.includeCheckups || boostersOn;

  const [visitRows, reminderRows] = await Promise.all([
    feed.includeVisits
      ? prisma.encounter.findMany({
          where: {
            userId: subject.id,
            deletedAt: null,
            status: "PLANNED",
            occurredAt: { gte: from, lte: until },
          },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take: MAX_CARE_EVENTS,
          select: {
            id: true,
            occurredAt: true,
            practitioner: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    wantReminders
      ? prisma.measurementReminder.findMany({
          where: {
            userId: subject.id,
            deletedAt: null,
            enabled: true,
            origin: { not: "ENCOUNTER" },
            nextDueAt: { gte: from, lte: until },
            ...(feed.includeCheckups && boostersOn
              ? {}
              : feed.includeCheckups
                ? { vaccinationAntigen: null }
                : { vaccinationAntigen: { not: null } }),
          },
          orderBy: [{ nextDueAt: "asc" }, { id: "asc" }],
          take: MAX_CARE_EVENTS,
          select: {
            id: true,
            label: true,
            nextDueAt: true,
            vaccinationAntigen: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const dues: CareDue[] = reminderRows.flatMap((r) =>
    r.nextDueAt
      ? [
          {
            id: r.id,
            day: moodDateKey(r.nextDueAt, tz),
            label: r.label,
            booster: r.vaccinationAntigen !== null,
          },
        ]
      : [],
  );
  const calendar = buildCareCalendar({
    feedId: feed.id,
    titleMode: feed.titleMode,
    visits: visitRows.map((v) => ({
      id: v.id,
      occurredAt: v.occurredAt,
      practitioner: v.practitioner?.name ?? null,
    })),
    dues,
    translator: getServerTranslator(feedLocale(subject.locale)),
  });
  return { calendar, contentHash: icsContentHash(calendar) };
}
