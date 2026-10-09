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
 * ## Two purposes since v1.42
 *
 * The coarse locations are sealed at rest from v1.42 (`locationEncrypted`,
 * see `src/lib/environment/location-cipher.ts`), so the two purposes differ
 * the way every other section with a sealed column does:
 *
 *   - a portable export opens the sealed location and writes the readable
 *     `lat` / `lon` / label, and no `locationEncrypted` at all, so the file
 *     reads anywhere;
 *   - a disaster-recovery file carries `locationEncrypted` verbatim (base64)
 *     beside whatever readable columns the row still holds, for a host with
 *     the same keys.
 *
 * The restore takes either: a sealed value is written as it came, a readable
 * one is sealed under this host's key, and the readable columns are written
 * empty in both cases. A row that holds neither restores without a location;
 * it is never invented.
 *
 * The air-quality columns (v1.42) are plain values and ride both purposes
 * alike. Every one is optional on the way in: a file written before them
 * says nothing about air quality, and the restored day then reads as never
 * fetched (`aqFetchedAt` absent), so the nightly gap fill asks for it.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { EnvironmentLocationSource } from "@/generated/prisma/client";
import type { AirQualityDay } from "@/lib/environment/air-quality-contract";
import {
  openLocation,
  readLocation,
  sealLocation,
} from "@/lib/environment/location-cipher";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

export interface EnvironmentBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** The air-quality columns of a stored day, as they ride the file. */
type AirQualityBackupColumns = Omit<AirQualityDay, "aqFetchedAt"> & {
  /** When the air-quality part was fetched; null = not yet. Verbatim. */
  aqFetchedAt: string | null;
};

/** The air-quality column names, in file order. */
const AIR_QUALITY_COLUMNS = [
  "apparentMax",
  "pm25Mean",
  "pm25Max",
  "pm10Mean",
  "no2Mean",
  "so2Mean",
  "coMean",
  "o3Max8h",
  "eaqiMax",
  "usaqiMax",
  "uvIndexMax",
  "dustMax",
  "aodMax",
  "pollenAlderMax",
  "pollenBirchMax",
  "pollenGrassMax",
  "pollenMugwortMax",
  "pollenOliveMax",
  "pollenRagweedMax",
  "aqDomain",
  "aqHours",
] as const satisfies ReadonlyArray<keyof AirQualityBackupColumns>;

/** One day's environmental observation, at the location resolved for that day. */
export interface EnvironmentContextBackupEntry extends AirQualityBackupColumns {
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
   * The sealed location, base64. Disaster-recovery files only; a portable
   * file carries the readable columns instead.
   */
  locationEncrypted?: string | null;
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
  /** The sealed location, base64; disaster-recovery files only. */
  locationEncrypted?: string | null;
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
  locationEncrypted: true,
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
  apparentMax: true,
  pm25Mean: true,
  pm25Max: true,
  pm10Mean: true,
  no2Mean: true,
  so2Mean: true,
  coMean: true,
  o3Max8h: true,
  eaqiMax: true,
  usaqiMax: true,
  uvIndexMax: true,
  dustMax: true,
  aodMax: true,
  pollenAlderMax: true,
  pollenBirchMax: true,
  pollenGrassMax: true,
  pollenMugwortMax: true,
  pollenOliveMax: true,
  pollenRagweedMax: true,
  aqDomain: true,
  aqHours: true,
  aqFetchedAt: true,
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
  locationEncrypted: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.EnvironmentTravelLocationSelect;

/** A sealed column as it rides a disaster-recovery file. */
function toBase64(bytes: Uint8Array | null): string | null {
  return bytes && bytes.byteLength > 0
    ? Buffer.from(bytes).toString("base64")
    : null;
}

/**
 * The location columns of one entry: opened and readable for a portable
 * file, as stored plus the sealed value for a disaster-recovery file.
 */
function locationFields(
  row: {
    lat: number | null;
    lon: number | null;
    label: string | null;
    locationEncrypted: Uint8Array | null;
  },
  disasterRecovery: boolean,
): {
  lat: number | null;
  lon: number | null;
  label: string | null;
  locationEncrypted?: string | null;
} {
  if (disasterRecovery) {
    return {
      lat: row.lat,
      lon: row.lon,
      label: row.label,
      locationEncrypted: toBase64(row.locationEncrypted),
    };
  }
  const location = readLocation({
    sealed: row.locationEncrypted,
    lat: row.lat,
    lon: row.lon,
    label: row.label,
  });
  return location ?? { lat: null, lon: null, label: null };
}

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
  options: EnvironmentBackupOptions = {},
): Promise<EnvironmentBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
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
    environmentContexts: contextRows.map((row) => {
      const { label, ...location } = locationFields(
        {
          lat: row.lat,
          lon: row.lon,
          label: row.locationLabel,
          locationEncrypted: row.locationEncrypted,
        },
        disasterRecovery,
      );
      return {
        date: row.date,
        ...location,
        locationLabel: label,
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
        apparentMax: row.apparentMax,
        pm25Mean: row.pm25Mean,
        pm25Max: row.pm25Max,
        pm10Mean: row.pm10Mean,
        no2Mean: row.no2Mean,
        so2Mean: row.so2Mean,
        coMean: row.coMean,
        o3Max8h: row.o3Max8h,
        eaqiMax: row.eaqiMax,
        usaqiMax: row.usaqiMax,
        uvIndexMax: row.uvIndexMax,
        dustMax: row.dustMax,
        aodMax: row.aodMax,
        pollenAlderMax: row.pollenAlderMax,
        pollenBirchMax: row.pollenBirchMax,
        pollenGrassMax: row.pollenGrassMax,
        pollenMugwortMax: row.pollenMugwortMax,
        pollenOliveMax: row.pollenOliveMax,
        pollenRagweedMax: row.pollenRagweedMax,
        aqDomain: row.aqDomain,
        aqHours: row.aqHours,
        aqFetchedAt: row.aqFetchedAt?.toISOString() ?? null,
        fetchedAt: row.fetchedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    environmentTravelLocations: travelRows.map((row) => ({
      startDate: row.startDate,
      endDate: row.endDate,
      ...locationFields(row, disasterRecovery),
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
      | "locationEncrypted"
      | (typeof AIR_QUALITY_COLUMNS)[number]
      | "aqFetchedAt"
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
    Pick<
      EnvironmentTravelLocationBackupEntry,
      "locationEncrypted" | "createdAt" | "updatedAt"
    >
  >;

/**
 * The sealed location a restored row is written with: the file's sealed
 * value as it came, or the file's readable location sealed under this host's
 * key (rounded to the privacy floor first, so a file written before v1.39.4
 * with two decimals comes back coarse). Null when the file carries neither.
 *
 * A sealed value is opened once to check it. One this host cannot open is
 * still written as it came, and its path is added to `unopened` so the
 * restore report names it. Writing it without a location would be worse: a
 * period without a location reads as no period at all, and the next refresh
 * would rewrite those days with the weather at home. Kept sealed, the
 * refresh skips them (`fetchAndStoreEnvironment` fails closed), and the
 * location comes back once the missing key is added.
 */
function restoredLocation(
  entry: {
    locationEncrypted?: string | null;
    lat: number | null;
    lon: number | null;
    label: string | null;
  },
  path: string,
  unopened: string[],
): Uint8Array<ArrayBuffer> | null {
  if (typeof entry.locationEncrypted === "string") {
    const buffer = Buffer.from(entry.locationEncrypted, "base64");
    if (buffer.byteLength > 0) {
      const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength));
      bytes.set(buffer);
      try {
        openLocation(bytes);
      } catch {
        unopened.push(path);
      }
      return bytes;
    }
  }
  if (entry.lat == null || entry.lon == null || entry.label == null) {
    return null;
  }
  return sealLocation({ lat: entry.lat, lon: entry.lon, label: entry.label });
}

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
  skips?: RestoreSkipLog,
): Promise<EnvironmentRestoreCleared> {
  // Sealed locations this host's keys do not open, by file path.
  const unopened: string[] = [];
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
        // Sealed, never readable: see `restoredLocation`.
        locationEncrypted: restoredLocation(
          entry,
          `environmentTravelLocations.${entry.startDate}..${entry.endDate}`,
          unopened,
        ),
        lat: null,
        lon: null,
        label: null,
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
        locationEncrypted: restoredLocation(
          {
            locationEncrypted: entry.locationEncrypted,
            lat: entry.lat,
            lon: entry.lon,
            label: entry.locationLabel,
          },
          `environmentContexts.${entry.date}`,
          unopened,
        ),
        lat: null,
        lon: null,
        locationLabel: null,
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
        ...Object.fromEntries(
          AIR_QUALITY_COLUMNS.map((column) => [column, entry[column] ?? null]),
        ),
        // Verbatim, like `fetchedAt`; absent means the air-quality part was
        // never fetched, and the nightly gap fill will ask for it.
        aqFetchedAt: entry.aqFetchedAt ? new Date(entry.aqFetchedAt) : null,
        // Verbatim, not stamped: this says when the feed was read, not when
        // the row was written back.
        ...(entry.fetchedAt ? { fetchedAt: new Date(entry.fetchedAt) } : {}),
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
        ...(entry.updatedAt ? { updatedAt: new Date(entry.updatedAt) } : {}),
      })),
    });
  }

  if (skips) {
    recordUnknownKeys(
      skips,
      "environmentLocationCiphertext",
      unopened,
      unopened,
    );
  }

  return {
    environmentContexts: clearedContexts.count,
    environmentTravelLocations: clearedTravel.count,
  };
}
