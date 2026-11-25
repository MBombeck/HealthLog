/**
 * Hour buckets for the summed intraday types (v1.43, ios #77).
 *
 * The phone can hand over a day of steps, active energy, walking distance or
 * flights as twenty-four hourly sums (`stats:<HK>:<YYYY-MM-DD>T<HH>`, the
 * local hour in the account's zone) instead of the minute-level samples the
 * nightly drain folds. That matters for history: a thirty-day backfill of
 * hourly sums makes the same-time baseline usable on day one, where the
 * drain only ever sees samples that are still on the phone's recent window.
 *
 * Such a row is NEVER a measurement. The day's total stays the
 * `stats:<HK>:<YYYY-MM-DD>` row the phone keeps posting; an hourly row stored
 * as a measurement would be summed into that day a second time. Each hour
 * lands as one slot of `IntradayCumulativeProfile.hourlyIncrements` instead,
 * and once a day holds `HOUR_BUCKET_MIN_FOR_PROFILE` hours its running totals
 * (`hourlyCumulative`) are rebuilt from the posted hours and the profile's
 * `basis` reads `HOUR_BUCKETS`. Below that a day keeps the per-sample fold,
 * if it has one.
 *
 * An hour not posted holds `HOUR_NOT_POSTED` (-1) in its slot; every value a
 * posted hour can carry is zero or more, so the sentinel cannot collide with
 * a reading, and `bucketCount` is the number of slots at zero or above.
 */
import type {
  MeasurementType,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { wallClockInTz } from "@/lib/tz/wall-clock";

import {
  CUMULATIVE_PROFILE_RETENTION_DAYS,
  PROFILE_HOURS,
} from "./intraday-cumulative-profile";
import { ownValue } from "@/lib/own-key";

/** The HealthKit identifiers the hour form is defined for, and their types. */
export const HOUR_BUCKET_TYPES: Readonly<Record<string, MeasurementType>> = {
  HKQuantityTypeIdentifierStepCount: "ACTIVITY_STEPS",
  HKQuantityTypeIdentifierActiveEnergyBurned: "ACTIVE_ENERGY_BURNED",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "WALKING_RUNNING_DISTANCE",
  HKQuantityTypeIdentifierFlightsClimbed: "FLIGHTS_CLIMBED",
};

/** Hours a day needs before its profile is built from buckets. */
export const HOUR_BUCKET_MIN_FOR_PROFILE = 4;

/** The oldest hour accepted: the profile's own retention bound. */
export const HOUR_BUCKET_MAX_AGE_DAYS = CUMULATIVE_PROFILE_RETENTION_DAYS;

/** The slot value of an hour the phone has not posted. */
export const HOUR_NOT_POSTED = -1;

export const HOUR_BUCKET_SKIP_REASONS = {
  misaligned: "hour_bucket_misaligned",
  unsupportedType: "hour_bucket_unsupported_type",
  tooOld: "hour_bucket_too_old",
} as const;

export type HourBucketSkipReason =
  (typeof HOUR_BUCKET_SKIP_REASONS)[keyof typeof HOUR_BUCKET_SKIP_REASONS];

/**
 * The heart-rate identifier keeps its own bucket contract (ten-minute ISO
 * buckets, `malformed_hr_bucket_id`), so the hour form is not claimed for it.
 */
const HEART_RATE_HK = "HKQuantityTypeIdentifierHeartRate";

const HOUR_FORM = /^stats:([A-Za-z0-9]+):(\d{4}-\d{2}-\d{2})T(\d{2})$/;

export interface HourBucketId {
  hkIdentifier: string;
  dateKey: string;
  hour: number;
}

/**
 * Parse `stats:<HK>:<YYYY-MM-DD>T<HH>`. Null for anything else, the day form
 * and the heart-rate buckets included, so every other external id keeps the
 * path it had.
 */
export function parseHourBucketId(externalId: string): HourBucketId | null {
  const match = HOUR_FORM.exec(externalId);
  if (!match) return null;
  const [, hkIdentifier, dateKey, hh] = match;
  if (hkIdentifier === HEART_RATE_HK) return null;
  const hour = Number(hh);
  if (!Number.isInteger(hour) || hour < 0 || hour >= PROFILE_HOURS) return null;
  const [y, m, d] = dateKey.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return { hkIdentifier, dateKey, hour };
}

/**
 * Whether `startDate` is the first instant of that local hour in the
 * account's zone. Read through the zone rather than computed from it, so a
 * repeated autumn hour accepts either of its two starts and a spring hour
 * that does not exist accepts none.
 */
export function isStartOfLocalHour(
  startDate: Date,
  id: HourBucketId,
  timezone: string,
): boolean {
  if (startDate.getUTCMilliseconds() !== 0) return false;
  const wall = wallClockInTz(startDate, timezone);
  const key = `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
  return (
    key === id.dateKey &&
    wall.hour === id.hour &&
    wall.minute === 0 &&
    wall.second === 0
  );
}

export type HourBucketVerdict =
  | { ok: true; type: MeasurementType; id: HourBucketId }
  | { ok: false; reason: HourBucketSkipReason };

/** Decide whether one parsed hour row may be stored, and as which type. */
export function classifyHourBucket(
  id: HourBucketId,
  startDate: Date,
  timezone: string,
  now: Date,
): HourBucketVerdict {
  const type = ownValue(HOUR_BUCKET_TYPES, id.hkIdentifier);
  if (!type)
    return { ok: false, reason: HOUR_BUCKET_SKIP_REASONS.unsupportedType };
  const oldest = shiftDateKey(
    userDayKey(now, timezone),
    -HOUR_BUCKET_MAX_AGE_DAYS,
  );
  if (id.dateKey < oldest) {
    return { ok: false, reason: HOUR_BUCKET_SKIP_REASONS.tooOld };
  }
  if (!isStartOfLocalHour(startDate, id, timezone)) {
    return { ok: false, reason: HOUR_BUCKET_SKIP_REASONS.misaligned };
  }
  return { ok: true, type, id };
}

/** Running totals from posted hours; an hour not posted adds nothing. */
export function cumulativeFromIncrements(
  increments: readonly number[],
): number[] {
  const out = new Array<number>(PROFILE_HOURS);
  let running = 0;
  for (let h = 0; h < PROFILE_HOURS; h += 1) {
    const v = increments[h];
    if (v !== undefined && v >= 0) running += v;
    out[h] = running;
  }
  return out;
}

export function postedHours(increments: readonly number[]): number {
  return increments.filter((v) => v >= 0).length;
}

/** One accepted hour, as the batch hands it over. */
export interface HourBucketWrite {
  /** The entry's index in the batch, for its per-entry status. */
  index: number;
  type: MeasurementType;
  hkIdentifier: string;
  dateKey: string;
  hour: number;
  /** The hour's sum in the canonical unit of `type`. */
  value: number;
}

/** One hour as the batch reads it, with the instant it starts at. */
export interface HourBucketEntry extends HourBucketWrite {
  /** `startDate` of the entry, in epoch milliseconds. */
  startMs: number;
}

/**
 * A batch's hours reduced to one write per slot.
 *
 * A slot is one local hour of one day. On the autumn day the clock falls
 * back, one local hour happens twice, and the phone hands over both under
 * the same key (`…T02`), each with its own `startDate`: they are two hours of
 * activity and are summed into the slot rather than the second replacing the
 * first. Entries that repeat the same start are the same hour posted twice,
 * and the last one counts, as for every other slot.
 *
 * `contributors` are the entries whose values the write carries (they take
 * its status); `superseded` are the earlier repeats of one start.
 *
 * The slot holds one number, so the sum is only as complete as the batch
 * that carries it: both occurrences have to arrive together. The phone posts
 * a day's hours in one batch, and a later batch that carries only one of
 * them replaces the slot with that one, as a re-post of any slot does.
 */
export function combineHourWrites(entries: readonly HourBucketEntry[]): {
  writes: Array<{ write: HourBucketWrite; contributors: number[] }>;
  superseded: number[];
} {
  const slots = new Map<string, Map<number, HourBucketEntry>>();
  const superseded: number[] = [];
  for (const entry of entries) {
    const key = `${entry.type}::${entry.dateKey}::${entry.hour}`;
    const byStart = slots.get(key) ?? new Map<number, HourBucketEntry>();
    const earlier = byStart.get(entry.startMs);
    if (earlier) superseded.push(earlier.index);
    byStart.set(entry.startMs, entry);
    slots.set(key, byStart);
  }
  const writes = [...slots.values()].map((byStart) => {
    const occurrences = [...byStart.values()];
    const last = occurrences.reduce((a, b) => (b.index > a.index ? b : a));
    const { startMs: _start, ...base } = last;
    return {
      write: {
        ...base,
        value: occurrences.reduce((sum, entry) => sum + entry.value, 0),
      },
      contributors: occurrences.map((entry) => entry.index),
    };
  });
  return { writes, superseded };
}

/** What one hour write did to its slot. */
export type HourBucketWriteStatus = "inserted" | "updated" | "unchanged";

/**
 * Store a batch's hours, one transaction per (type, day). Returns the
 * per-entry status: `inserted` for the first value of a slot, `updated` when
 * it replaced one, `unchanged` when the slot already held exactly this value
 * (a re-post that changed nothing; the wire still reports it `updated`, but
 * it is not an arrival of the type, #1259). A later entry for the same slot
 * in one batch wins, and the earlier ones read `updated` too, since the slot
 * already held a value when they were applied in order.
 *
 * Serialised against the nightly drain's merge for the same day by the
 * drain's own advisory lock (keyed on the day's `stats:` id), so a bucket
 * write and a per-sample fold never interleave.
 */
export async function writeHourBuckets(
  db: PrismaClient,
  userId: string,
  timezone: string,
  writes: readonly HourBucketWrite[],
): Promise<Map<number, HourBucketWriteStatus>> {
  const statuses = new Map<number, HourBucketWriteStatus>();
  const groups = new Map<string, HourBucketWrite[]>();
  for (const w of writes) {
    const key = `${w.type}::${w.dateKey}`;
    const list = groups.get(key);
    if (list) list.push(w);
    else groups.set(key, [w]);
  }

  for (const group of groups.values()) {
    const { type, dateKey, hkIdentifier } = group[0];
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended('drain-cumulative:' || ${userId} || ':' || ${`stats:${hkIdentifier}:${dateKey}`}, 0))
      `;
      const key = { userId, type, dateKey };
      const existing = await tx.intradayCumulativeProfile.findUnique({
        where: { userId_type_dateKey: key },
        select: {
          hourlyIncrements: true,
          hourlyCumulative: true,
          dayTotal: true,
          sampleCount: true,
          timezone: true,
          basis: true,
        },
      });
      // Hours cut on another clock mean other hours: start the day over.
      const sameZone = existing !== null && existing.timezone === timezone;
      const increments =
        sameZone && existing.hourlyIncrements.length === PROFILE_HOURS
          ? [...existing.hourlyIncrements]
          : new Array<number>(PROFILE_HOURS).fill(HOUR_NOT_POSTED);
      for (const w of group) {
        statuses.set(
          w.index,
          increments[w.hour] < 0
            ? "inserted"
            : increments[w.hour] === w.value
              ? "unchanged"
              : "updated",
        );
        increments[w.hour] = w.value;
      }
      const bucketCount = postedHours(increments);
      const fromBuckets = bucketCount >= HOUR_BUCKET_MIN_FOR_PROFILE;
      const cumulative = cumulativeFromIncrements(increments);
      // Below the threshold the day keeps whatever the per-sample fold left
      // (nothing, for a day the drain never saw): the reader skips a profile
      // without 24 running totals.
      const keepFold = sameZone && !fromBuckets;
      const data = {
        hourlyIncrements: increments,
        bucketCount,
        basis: fromBuckets ? "HOUR_BUCKETS" : "PER_SAMPLE",
        timezone,
        hourlyCumulative: fromBuckets
          ? cumulative
          : keepFold
            ? existing.hourlyCumulative
            : [],
        dayTotal: fromBuckets
          ? cumulative[PROFILE_HOURS - 1]
          : keepFold
            ? existing.dayTotal
            : 0,
        sampleCount: fromBuckets
          ? bucketCount
          : keepFold
            ? existing.sampleCount
            : 0,
      } satisfies Prisma.IntradayCumulativeProfileUncheckedUpdateInput;
      await tx.intradayCumulativeProfile.upsert({
        where: { userId_type_dateKey: key },
        create: { ...key, ...data },
        update: data,
      });
    });
  }
  return statuses;
}
