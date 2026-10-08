/**
 * The per-day environmental readings and the location periods that explain
 * them, with both backup ends in one file.
 *
 * Same arrangement as `reminders-backup.ts` and `coach-backup.ts`, for the same
 * reason: a reader asking "is this carried at both ends?" answers it here, and
 * a reader who greps only the restore ROUTE gets a false negative because the
 * route delegates.
 *
 * ## The two travel as a pair, and the pairing is not decoration
 *
 * The register listed them separately, as "per-day environmental readings joined
 * to the record", "where the person was on a given day, which is what makes
 * the environmental readings mean anything", and the second line is the one
 * that decides the design.
 *
 * A reading carries the coarse location it was fetched for (`lat`, `lon`,
 * `locationLabel`) and the precedence rule that chose it (`source`). A
 * `TRAVEL` reading exists because an explicit dated location period covered
 * that day. `resolveLocationForDay` in `src/lib/environment/service.ts` reads
 * those periods live, every time; nothing else can produce a `TRAVEL`
 * verdict.
 *
 * So a restore that carried the readings and not the periods would not merely
 * hand back readings with less context. The nightly refresh runs a seven-day
 * lookback and an operator backfill re-resolves whatever range it is given;
 * both UPSERT. With the periods gone, every trip day inside the range
 * re-resolves to the home location and the upsert overwrites the row: the
 * coordinates, the label, the source and every weather field. The account
 * would end up with a fortnight abroad recorded as a fortnight of weather at
 * home, written by the app itself, some days after a restore that reported
 * success. That is why these two land together or not at all.
 *
 * The other direction is a plain loss with no rewrite behind it: periods
 * without readings leave the correlation surfaces empty for the history, and
 * the archive feed only reaches back so far before the older days are simply
 * unfetchable.
 *
 * ## Day keys stay strings
 *
 * `date`, `startDate` and `endDate` are `YYYY-MM-DD`, and they cross the wire
 * as the strings they are stored as. The resolver compares them
 * lexicographically against other day keys, so nothing here needs a `Date`,
 * and parsing one into a `Date` and formatting it back is exactly how a day
 * key loses a day under a negative UTC offset. The row stamps
 * (`fetchedAt`, `createdAt`, `updatedAt`) are real instants and ride as
 * ISO-8601.
 *
 * `fetchedAt` is carried verbatim rather than stamped on the way in. It says
 * when the upstream feed was last read for that day, and the archive feed
 * settles over a few days after the fact, so a restore that wrote "now" would
 * claim a provisional reading from two years ago had just been confirmed.
 *
 * ## One wire shape, both purposes
 *
 * Neither model has a tombstone column and neither holds ciphertext, so a
 * portable export and a disaster-recovery payload carry byte-identical
 * sections. This builder therefore takes no `purpose`: a parameter that
 * changes nothing would advertise a distinction the file does not have.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { EnvironmentLocationSource } from "@/generated/prisma/client";
import { roundCoarse } from "@/lib/environment/open-meteo";

/** One day's environmental observation, at the location resolved for that day. */
export interface EnvironmentContextBackupEntry {
  /** `YYYY-MM-DD`, anchored to the resolved location's timezone. */
  date: string;
  /**
   * Plaintext coarse location. Nullable since v1.42 (migration 0382): the
   * sealed copy replaces it once the encryption backfill has run.
   */
  lat: number | null;
  lon: number | null;
  locationLabel: string | null;
  /**
   * Which precedence rule chose the location. Carried because it is the only
   * record that this day was NOT the home city, and because a re-resolve
   * cannot recover it once the period behind it is gone.
   */
  source: EnvironmentLocationSource;
  tempMin: number | null;
  tempMax: number | null;
  tempMean: number | null;
  apparentMean: number | null;
  sunshineSec: number | null;
  daylightSec: number | null;
  precipSum: number | null;
  pressureMean: number | null;
  pressureDelta: number | null;
  humidityMean: number | null;
  cloudMean: number | null;
  weatherCode: number | null;
  /** When the feed was last read for this day. Verbatim; see the file header. */
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** One declared stretch spent somewhere other than home. */
export interface EnvironmentTravelLocationBackupEntry {
  /** Inclusive `YYYY-MM-DD` bounds. Strings end to end; see the file header. */
  startDate: string;
  endDate: string;
  /** Plaintext coarse location; nullable since v1.42 (migration 0382). */
  lat: number | null;
  lon: number | null;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentBackupSection {
  environmentContexts: EnvironmentContextBackupEntry[];
  environmentTravelLocations: EnvironmentTravelLocationBackupEntry[];
}

export interface EnvironmentBackupCounts {
  environmentContexts: number;
  environmentTravelLocations: number;
}

/**
 * Named select constants, one per model, because a structural matcher binds a model
 * to the literal beside its delegate call, matching the other section files.
 *
 * No `id` on either: nothing in the file or in the database addresses one of
 * these rows, and a reading is identified by its day.
 */
const ENVIRONMENT_CONTEXT_BACKUP_SELECT = {
  date: true,
  lat: true,
  lon: true,
  locationLabel: true,
  source: true,
  tempMin: true,
  tempMax: true,
  tempMean: true,
  apparentMean: true,
  sunshineSec: true,
  daylightSec: true,
  precipSum: true,
  pressureMean: true,
  pressureDelta: true,
  humidityMean: true,
  cloudMean: true,
  weatherCode: true,
  fetchedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.EnvironmentContextSelect;

const ENVIRONMENT_TRAVEL_LOCATION_BACKUP_SELECT = {
  startDate: true,
  endDate: true,
  lat: true,
  lon: true,
  label: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.EnvironmentTravelLocationSelect;

/**
 * Build the environment slice of a user's full backup.
 *
 * Takes the delegates it uses rather than a whole client, matching the other
 * section builders.
 */
export async function buildEnvironmentBackupSection(
  prisma: Pick<
    PrismaClient,
    "environmentContext" | "environmentTravelLocation"
  >,
  userId: string,
): Promise<EnvironmentBackupSection> {
  const [contextRows, travelRows] = await Promise.all([
    prisma.environmentContext.findMany({
      where: { userId },
      orderBy: { date: "asc" },
      select: ENVIRONMENT_CONTEXT_BACKUP_SELECT,
    }),
    prisma.environmentTravelLocation.findMany({
      where: { userId },
      orderBy: { startDate: "asc" },
      select: ENVIRONMENT_TRAVEL_LOCATION_BACKUP_SELECT,
    }),
  ]);

  return {
    environmentContexts: contextRows.map((row) => ({
      date: row.date,
      lat: row.lat,
      lon: row.lon,
      locationLabel: row.locationLabel,
      source: row.source,
      tempMin: row.tempMin,
      tempMax: row.tempMax,
      tempMean: row.tempMean,
      apparentMean: row.apparentMean,
      sunshineSec: row.sunshineSec,
      daylightSec: row.daylightSec,
      precipSum: row.precipSum,
      pressureMean: row.pressureMean,
      pressureDelta: row.pressureDelta,
      humidityMean: row.humidityMean,
      cloudMean: row.cloudMean,
      weatherCode: row.weatherCode,
      fetchedAt: row.fetchedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    environmentTravelLocations: travelRows.map((row) => ({
      startDate: row.startDate,
      endDate: row.endDate,
      lat: row.lat,
      lon: row.lon,
      label: row.label,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countEnvironmentBackupSection(
  section: EnvironmentBackupSection,
): EnvironmentBackupCounts {
  return {
    environmentContexts: section.environmentContexts.length,
    environmentTravelLocations: section.environmentTravelLocations.length,
  };
}

/** Counts the environment restore wiped, for the audit trail. */
export interface EnvironmentRestoreCleared {
  environmentContexts: number;
  environmentTravelLocations: number;
}

/**
 * What the restore reads, as the parsed file actually presents it. Wider than
 * what this release writes, because every weather column arrives as
 * `undefined` rather than `null` from a file written before it existed.
 *
 * `source` stays strictly required. It is the field that says this day was not
 * the home city, and defaulting it would quietly re-attribute a trip.
 */
type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredEnvironmentContext = Pick<
  EnvironmentContextBackupEntry,
  "date" | "lat" | "lon" | "locationLabel" | "source"
> &
  OptionalNullable<
    Pick<
      EnvironmentContextBackupEntry,
      | "tempMin"
      | "tempMax"
      | "tempMean"
      | "apparentMean"
      | "sunshineSec"
      | "daylightSec"
      | "precipSum"
      | "pressureMean"
      | "pressureDelta"
      | "humidityMean"
      | "cloudMean"
      | "weatherCode"
      | "fetchedAt"
      | "createdAt"
      | "updatedAt"
    >
  >;

export type RestoredEnvironmentTravelLocation = Pick<
  EnvironmentTravelLocationBackupEntry,
  "startDate" | "endDate" | "lat" | "lon" | "label"
> &
  OptionalNullable<
    Pick<EnvironmentTravelLocationBackupEntry, "createdAt" | "updatedAt">
  >;

export interface EnvironmentRestoreInput {
  environmentContexts: RestoredEnvironmentContext[];
  environmentTravelLocations: RestoredEnvironmentTravelLocation[];
}

/**
 * Re-create the account's environmental history and its location periods.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section.
 *
 * Neither model references anything but the account, so this section has no
 * ordering constraint against any other one and can run anywhere in the
 * restore. The ordering that does matter is INSIDE it, and it is the reason
 * the two live in one function: the periods and the readings must land in the
 * same transaction, because a set of readings whose periods are missing is a
 * history the next refresh will silently rewrite to the home location. The
 * periods go first so a reader of this function meets the explanation before
 * the thing it explains.
 */
export async function restoreEnvironmentData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: EnvironmentRestoreInput,
): Promise<EnvironmentRestoreCleared> {
  const [clearedTravel, clearedContexts] = await Promise.all([
    tx.environmentTravelLocation.deleteMany({ where: { userId: ownerId } }),
    tx.environmentContext.deleteMany({ where: { userId: ownerId } }),
  ]);

  if (payload.environmentTravelLocations.length > 0) {
    await tx.environmentTravelLocation.createMany({
      data: payload.environmentTravelLocations.map((entry) => ({
        userId: ownerId,
        // Day keys, written as they were read. See the file header for why
        // neither bound goes near a `Date`.
        startDate: entry.startDate,
        endDate: entry.endDate,
        // A file written before v1.39.4 carries 2-decimal coordinates; they
        // come back at today's privacy floor.
        lat: entry.lat == null ? null : roundCoarse(entry.lat),
        lon: entry.lon == null ? null : roundCoarse(entry.lon),
        label: entry.label,
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
        ...(entry.updatedAt ? { updatedAt: new Date(entry.updatedAt) } : {}),
      })),
    });
  }

  if (payload.environmentContexts.length > 0) {
    await tx.environmentContext.createMany({
      data: payload.environmentContexts.map((entry) => ({
        userId: ownerId,
        date: entry.date,
        lat: entry.lat == null ? null : roundCoarse(entry.lat),
        lon: entry.lon == null ? null : roundCoarse(entry.lon),
        locationLabel: entry.locationLabel,
        source: entry.source,
        tempMin: entry.tempMin ?? null,
        tempMax: entry.tempMax ?? null,
        tempMean: entry.tempMean ?? null,
        apparentMean: entry.apparentMean ?? null,
        sunshineSec: entry.sunshineSec ?? null,
        daylightSec: entry.daylightSec ?? null,
        precipSum: entry.precipSum ?? null,
        pressureMean: entry.pressureMean ?? null,
        pressureDelta: entry.pressureDelta ?? null,
        humidityMean: entry.humidityMean ?? null,
        cloudMean: entry.cloudMean ?? null,
        weatherCode: entry.weatherCode ?? null,
        // Verbatim, not stamped: this says when the feed was read, not when
        // the row was written back.
        ...(entry.fetchedAt ? { fetchedAt: new Date(entry.fetchedAt) } : {}),
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
        ...(entry.updatedAt ? { updatedAt: new Date(entry.updatedAt) } : {}),
      })),
    });
  }

  return {
    environmentContexts: clearedContexts.count,
    environmentTravelLocations: clearedTravel.count,
  };
}
