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
  deriveSeriesStatus,
  sessionNumbers,
  summarizeSessions,
} from "@/lib/treatment-series/derive";
import { dayToDate, loadSeriesSessions } from "@/lib/treatment-series/service";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";

import {
  MAX_CARE_EVENTS,
  buildCareCalendar,
  type CareDue,
  type CareFeedTitleMode,
  type CareSeriesEnd,
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
            seriesId: true,
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

  const { sessions, seriesEnds } = feed.includeVisits
    ? await loadSeriesFacts(subject.id, visitRows, until, now, tz)
    : { sessions: new Map(), seriesEnds: [] };

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
      session: sessions.get(v.id) ?? null,
    })),
    dues,
    seriesEnds,
    translator: getServerTranslator(feedLocale(subject.locale)),
  });
  return { calendar, contentHash: icsContentHash(calendar) };
}

/**
 * The treatment-series facts the feed draws: each booked session's
 * place in its series, and the last valid day of every series that still runs
 * with sessions left. Visits are the switch for both: a series is visits.
 */
async function loadSeriesFacts(
  userId: string,
  visits: ReadonlyArray<{ id: string; seriesId: string | null }>,
  until: Date,
  now: Date,
  tz: string,
): Promise<{
  sessions: Map<string, { number: number; planned: number | null }>;
  seriesEnds: CareSeriesEnd[];
}> {
  const today = userDayKey(now, tz);
  const series = await prisma.treatmentSeries.findMany({
    where: {
      userId,
      deletedAt: null,
      OR: [
        { id: { in: visits.flatMap((v) => (v.seriesId ? [v.seriesId] : [])) } },
        {
          endedOn: null,
          validUntil: { gte: dayToDate(today), lte: until },
        },
      ],
    },
    select: {
      id: true,
      plannedSessions: true,
      validUntil: true,
      endedOn: true,
      performer: { select: { name: true } },
    },
  });
  const facts = await loadSeriesSessions(
    prisma,
    userId,
    series.map((s) => s.id),
  );
  const byId = new Map(series.map((s) => [s.id, s]));
  const numbers = new Map(
    [...facts].map(([id, list]) => [id, sessionNumbers(list)] as const),
  );
  const sessions = new Map<
    string,
    { number: number; planned: number | null }
  >();
  for (const v of visits) {
    const number = v.seriesId ? numbers.get(v.seriesId)?.get(v.id) : undefined;
    if (!v.seriesId || number === undefined) continue;
    sessions.set(v.id, {
      number,
      planned: byId.get(v.seriesId)?.plannedSessions ?? null,
    });
  }
  const seriesEnds: CareSeriesEnd[] = [];
  for (const s of series) {
    if (!s.validUntil || s.endedOn) continue;
    const day = dateOnlyKey(s.validUntil);
    if (day < today) continue;
    const done = summarizeSessions(facts.get(s.id) ?? [], now).done;
    const status = deriveSeriesStatus(
      { plannedSessions: s.plannedSessions, validUntil: day, endedOn: null },
      done,
      today,
    );
    if (status === "COMPLETED") continue;
    seriesEnds.push({
      id: s.id,
      day,
      practitioner: s.performer?.name ?? null,
    });
  }
  return { sessions, seriesEnds };
}
