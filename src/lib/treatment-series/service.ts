/**
 * The reads and checks the treatment-series routes and the visit routes share.
 *
 * A series' progress is its sessions, so every read here goes through
 * {@link loadSeriesSessions}: one grouped query for however many series a
 * response carries, never one per series.
 */
import type { Prisma } from "@/generated/prisma/client";

import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";

import { sessionNumbers, type SeriesSessionFact } from "./derive";
import {
  decryptSeriesText,
  toTreatmentSeriesDTO,
  type EncounterSeriesRefDTO,
  type TreatmentSeriesDTO,
  type TreatmentSeriesWithRelations,
} from "./dto";

type Db = Prisma.TransactionClient;

export const TREATMENT_SERIES_INCLUDE = {
  prescriber: true,
  performer: true,
  episode: {
    select: { id: true, label: true, onsetAt: true, deletedAt: true },
  },
} as const satisfies Prisma.TreatmentSeriesInclude;

/** The live sessions of each series, grouped by series id. */
export async function loadSeriesSessions(
  db: Db,
  userId: string,
  seriesIds: readonly string[],
): Promise<Map<string, SeriesSessionFact[]>> {
  const out = new Map<string, SeriesSessionFact[]>();
  if (seriesIds.length === 0) return out;
  const rows = await db.encounter.findMany({
    where: { userId, deletedAt: null, seriesId: { in: [...seriesIds] } },
    select: { id: true, occurredAt: true, status: true, seriesId: true },
  });
  for (const row of rows) {
    if (!row.seriesId) continue;
    const list = out.get(row.seriesId) ?? [];
    list.push({ id: row.id, occurredAt: row.occurredAt, status: row.status });
    out.set(row.seriesId, list);
  }
  return out;
}

/** Series rows → DTOs, with their sessions read in one query. */
export async function toTreatmentSeriesDTOs(
  db: Db,
  userId: string,
  rows: readonly TreatmentSeriesWithRelations[],
  context: { timezone: string; illnessVisible: boolean; now?: Date },
): Promise<TreatmentSeriesDTO[]> {
  const now = context.now ?? new Date();
  const sessions = await loadSeriesSessions(
    db,
    userId,
    rows.map((row) => row.id),
  );
  const today = userDayKey(now, context.timezone);
  return rows.map((row) =>
    toTreatmentSeriesDTO(row, sessions.get(row.id) ?? [], {
      now,
      today,
      illnessVisible: context.illnessVisible,
    }),
  );
}

/**
 * Open series first (newest start first), then the finished ones, the same
 * way the visits list puts what is coming above what happened.
 */
export function orderSeries(list: TreatmentSeriesDTO[]): TreatmentSeriesDTO[] {
  const open = (s: TreatmentSeriesDTO) =>
    s.status === "PLANNED" || s.status === "ACTIVE" ? 0 : 1;
  return [...list].sort(
    (a, b) =>
      open(a) - open(b) ||
      (a.startsOn < b.startsOn ? 1 : a.startsOn > b.startsOn ? -1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * The series reference each visit carries, for a page of visits.
 *
 * Reads every live session of the series involved (not only the page), since
 * a session's number counts the sessions before it wherever they sit.
 */
export async function loadEncounterSeriesRefs(
  db: Db,
  userId: string,
  encounters: ReadonlyArray<{ id: string; seriesId: string | null }>,
): Promise<Map<string, EncounterSeriesRefDTO>> {
  const out = new Map<string, EncounterSeriesRefDTO>();
  const seriesIds = [
    ...new Set(encounters.flatMap((e) => (e.seriesId ? [e.seriesId] : []))),
  ];
  if (seriesIds.length === 0) return out;
  const [series, sessions] = await Promise.all([
    db.treatmentSeries.findMany({
      where: { id: { in: seriesIds }, userId },
      select: {
        id: true,
        titleEncrypted: true,
        plannedSessions: true,
        deletedAt: true,
      },
    }),
    loadSeriesSessions(db, userId, seriesIds),
  ]);
  const byId = new Map(series.map((s) => [s.id, s]));
  const numbers = new Map<string, Map<string, number>>();
  for (const [seriesId, facts] of sessions) {
    numbers.set(seriesId, sessionNumbers(facts));
  }
  for (const encounter of encounters) {
    if (!encounter.seriesId) continue;
    const row = byId.get(encounter.seriesId);
    // A deleted series is not shown on its sessions; restoring it brings the
    // reference back, since the column was never cleared.
    if (!row || row.deletedAt !== null) continue;
    out.set(encounter.id, {
      id: row.id,
      title: decryptSeriesText(row.titleEncrypted, "title"),
      sessionNumber: numbers.get(row.id)?.get(encounter.id) ?? null,
      plannedSessions: row.plannedSessions,
    });
  }
  return out;
}

/** A live series the caller owns, or undefined. */
export async function resolveOwnedSeries(
  db: Db,
  userId: string,
  seriesId: string,
): Promise<{ id: string } | undefined> {
  const row = await db.treatmentSeries.findUnique({
    where: { id: seriesId },
    select: { id: true, userId: true, deletedAt: true },
  });
  if (!row || row.userId !== userId || row.deletedAt !== null) return undefined;
  return { id: row.id };
}

/**
 * The `series` relation write a visit edit names: undefined to leave it,
 * a disconnect for null, a connect for a live series the caller owns, and a
 * refusal for anything else.
 */
export async function seriesRelationUpdate(
  db: Db,
  userId: string,
  seriesId: string | null | undefined,
): Promise<Prisma.EncounterUpdateInput["series"] | "unknown-series"> {
  if (seriesId === undefined) return undefined;
  if (seriesId === null) return { disconnect: true };
  const series = await resolveOwnedSeries(db, userId, seriesId);
  return series ? { connect: { id: series.id } } : "unknown-series";
}

/** A live condition episode the caller owns, or undefined. */
export async function resolveOwnedEpisode(
  db: Db,
  userId: string,
  episodeId: string,
): Promise<{ id: string } | undefined> {
  const row = await db.illnessEpisode.findUnique({
    where: { id: episodeId },
    select: { id: true, userId: true, deletedAt: true },
  });
  if (!row || row.userId !== userId || row.deletedAt !== null) return undefined;
  return { id: row.id };
}

/** A `YYYY-MM-DD` key as the `@db.Date` value Prisma writes. */
export function dayToDate(key: string): Date {
  return dayKeyAsUtcMidnight(key);
}
