/**
 * Oura intraday heart rate (`/v2/usercollection/heartrate`) → `PULSE`.
 *
 * The ring writes a reading every few minutes through the day, more during a
 * workout or a session, so a history of years is hundreds of thousands of
 * rows. The walk is streamed (`forEachHeartRatePage`): each page is mapped and
 * written in bounded batches before the next page is read, and nothing of a
 * page outlives its write. What the window keeps is the set of touched days
 * (a handful per window), which the caller refolds once at the end.
 *
 * Writes are first-write-wins: a sample is final once it is in Oura's cloud,
 * and it is keyed on its own instant (`heartrate:<ISO>`), so a re-read of the
 * same range is an insert that `skipDuplicates` drops. A row the person
 * deleted keeps its tombstone; the re-read does not bring it back. Oura's
 * samples go raw, like Google Health's and Fitbit's minute stream: the dense
 * hourly fold covers only the export sources (`DENSE_INTRADAY_FOLD_SOURCES`).
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { dropImplausibleMeasurements } from "@/lib/measurements/plausibility-gate";
import { collapseToTypeDayKeys } from "@/lib/rollups/measurement-rollups";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { forEachHeartRatePage } from "./client";
import { mapHeartRateSample, type MappedMeasurement } from "./map";
import { type OuraHeartRateSample } from "./wire-types";

/** Rows per `createMany`: bounded whatever size of page Oura sends. */
export const OURA_HEART_RATE_WRITE_CHUNK = 500;

/**
 * The hourly window: how far back an hourly sync reads heart rate. Short on
 * purpose, the history belongs to the backfill. A ring that has not synced
 * for a while widens it up to the ceiling, anchored on the newest reading
 * already held (`resolveOuraHeartRateWindow`).
 */
export const OURA_HEART_RATE_LOOKBACK_HOURS = 6;
export const OURA_HEART_RATE_MAX_LOOKBACK_HOURS = 72;

const HOUR_MS = 60 * 60 * 1000;

/** Day keys touched by a write, collapsed as they arrive. */
export class TouchedDays {
  private readonly keys = new Map<
    string,
    { type: MeasurementType; measuredAt: Date }
  >();

  add(rows: Array<{ type: MeasurementType; measuredAt: Date }>): void {
    for (const k of collapseToTypeDayKeys(rows)) {
      this.keys.set(`${k.type}|${k.measuredAt.getTime()}`, k);
    }
  }

  get size(): number {
    return this.keys.size;
  }

  list(): Array<{ type: MeasurementType; measuredAt: Date }> {
    return [...this.keys.values()];
  }
}

/**
 * Write one page of samples. Returns how many rows were inserted; the days
 * the page reached go into `touched`.
 */
export async function writeOuraHeartRatePage(
  userId: string,
  samples: readonly OuraHeartRateSample[],
  touched: TouchedDays,
  opts: { emitArrivals?: boolean } = {},
): Promise<number> {
  const mapped: MappedMeasurement[] = [];
  for (const s of samples) {
    const m = mapHeartRateSample(s);
    if (m) mapped.push(m);
  }
  const kept = dropImplausibleMeasurements("oura", mapped, (m) => ({
    type: m.type,
    value: m.value,
  }));
  let inserted = 0;
  for (let i = 0; i < kept.length; i += OURA_HEART_RATE_WRITE_CHUNK) {
    const chunk = kept.slice(i, i + OURA_HEART_RATE_WRITE_CHUNK);
    const rows = await prisma.measurement.createManyAndReturn({
      data: chunk.map((m) => ({
        userId,
        type: m.type as MeasurementType,
        source: "OURA" as const,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt,
        externalId: m.externalId!,
      })),
      skipDuplicates: true,
      select: { id: true, type: true, measuredAt: true },
    });
    inserted += rows.length;
    touched.add(rows);
    if (opts.emitArrivals !== false && rows.length > 0) {
      void emitInsertedMeasurementArrivals(userId, rows, "oura").catch(
        () => {},
      );
    }
  }
  return inserted;
}

/** Refold the touched days once a window is written. Best-effort. */
export async function refoldOuraTouchedDays(
  userId: string,
  touched: TouchedDays,
): Promise<void> {
  if (touched.size === 0) return;
  // The shared tail: the rollups, the measurement read caches back to the
  // first touched day (a backfill window reaches years back), and the cached
  // assessments of the types.
  await afterMeasurementMutation(userId, touched.list(), {
    source: "sync",
    label: "oura heart rate",
  });
}

/**
 * Read and write one time range of heart rate, page by page. Returns how many
 * rows were inserted and whether the walk stopped short (page ceiling or a
 * cursor Oura handed out twice). A refused page throws the classified
 * `OuraApiError` (a 429 with its `retryAfterMs`); the pages written before it
 * stay written.
 */
export async function syncOuraHeartRateRange(
  userId: string,
  accessToken: string,
  range: { start: Date; end: Date },
  opts: { emitArrivals?: boolean; touched?: TouchedDays } = {},
): Promise<{ imported: number; truncated: boolean }> {
  const touched = opts.touched ?? new TouchedDays();
  let imported = 0;
  const walk = await forEachHeartRatePage(
    accessToken,
    { start: range.start, end: range.end },
    async (samples) => {
      imported += await writeOuraHeartRatePage(userId, samples, touched, {
        emitArrivals: opts.emitArrivals,
      });
    },
  );
  if (!opts.touched) await refoldOuraTouchedDays(userId, touched);
  return { imported, truncated: walk.truncated };
}

/**
 * The hourly heart-rate window: the last `OURA_HEART_RATE_LOOKBACK_HOURS`, or
 * back to an hour before the newest reading held when that is older, never
 * further than `OURA_HEART_RATE_MAX_LOOKBACK_HOURS`. The ring uploads what it
 * stored all at once when the app next opens, so a gap closes in one window.
 */
export async function resolveOuraHeartRateWindow(
  userId: string,
  now: Date = new Date(),
): Promise<{ start: Date; end: Date }> {
  const newest = await prisma.measurement.findFirst({
    where: {
      userId,
      source: "OURA",
      type: "PULSE",
      deletedAt: null,
      externalId: { startsWith: "heartrate:" },
    },
    orderBy: { measuredAt: "desc" },
    select: { measuredAt: true },
  });
  const floor = now.getTime() - OURA_HEART_RATE_MAX_LOOKBACK_HOURS * HOUR_MS;
  const steady = now.getTime() - OURA_HEART_RATE_LOOKBACK_HOURS * HOUR_MS;
  const fromNewest = newest
    ? newest.measuredAt.getTime() - HOUR_MS
    : Number.POSITIVE_INFINITY;
  return {
    start: new Date(Math.max(floor, Math.min(steady, fromNewest))),
    end: now,
  };
}
