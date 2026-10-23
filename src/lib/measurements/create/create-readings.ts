/**
 * The hand-entry writes behind `POST /api/measurements`: one reading, or a
 * small array of them written together (the combined blood-pressure and
 * pulse form, a dual-value glucose entry), with the work a fresh reading
 * starts. The route owns authentication, the body, the source refusal and
 * the validation answers; these return what was written, or that the write
 * met a stored duplicate.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { EXTERNAL_SOURCE } from "@/lib/measurements/external-source";
import { annotate } from "@/lib/logging/context";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { auditLog } from "@/lib/auth/audit";
import {
  getUnitForType,
  type createBatchMeasurementSchema,
  type createMeasurementSchema,
} from "@/lib/validations/measurement";
import { isP2002 } from "@/lib/prisma-errors";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { runSafetyFloorCheck } from "@/lib/illness/safety-floor-check";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import type {
  GlucoseContext,
  Measurement,
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";

/** Who the reading is for and how the request authenticated. */
export interface ReadingWriter {
  /** The record the reading belongs to (the owner under a delegation). */
  user: { id: string; timezone: string | null };
  /** A narrow bridge credential: its rows are `EXTERNAL`. */
  scoped: boolean;
  ipAddress: string | null;
}

/** A unique index already holds this reading. */
export const DUPLICATE_READING = { duplicate: true } as const;

/**
 * The array arm: every reading in one transaction, so a duplicate anywhere
 * in it rolls the rest back.
 */
export async function createReadings(
  writer: ReadingWriter,
  input: z.output<typeof createBatchMeasurementSchema>,
): Promise<{ rows: Measurement[] } | typeof DUPLICATE_READING> {
  const { user, scoped } = writer;
  // The caller has to be told which condition the batch hit. Untouched, a
  // duplicate escaped as an unhandled error and the batch answered 500,
  // which is indistinguishable from a server fault and is what every client
  // retries against.
  let results;
  try {
    results = await prisma.$transaction(
      input.measurements.map((m) =>
        prisma.measurement.create({
          data: {
            userId: user.id,
            type: m.type as MeasurementType,
            value: m.value,
            unit: getUnitForType(m.type),
            // The array arm too, not just the single create: this is the
            // combined BP + Pulse path a bridge uses for a two-value reading;
            // missing it here would leave exactly those rows attributed
            // MANUAL and invisible to the badge and the source filter.
            // `scoped` already implies `m.source` is undefined — the route
            // refused otherwise — so this is the resolution, not an override.
            source: (scoped
              ? EXTERNAL_SOURCE
              : (m.source ?? "MANUAL")) as MeasurementSource,
            measuredAt: m.measuredAt,
            // The note is sealed at rest; the legacy plaintext column is
            // written null for new rows.
            notes: null,
            notesEncrypted: encryptNote(m.notes ?? null),
            glucoseContext:
              (m.glucoseContext as GlucoseContext | undefined) ?? null,
            // Mirror the single-entry path so the multi-entry batch persists
            // `deviceType` instead of silently dropping it.
            deviceType: m.deviceType ?? null,
          },
        }),
      ),
    );
  } catch (err) {
    if (isP2002(err)) return DUPLICATE_READING;
    throw err;
  }

  await auditLog("measurement.create.batch", {
    userId: user.id,
    ipAddress: writer.ipAddress,
    details: {
      count: results.length,
      types: input.measurements.map((m) => m.type),
    },
  });

  annotate({
    action: { name: "measurement.create.batch" },
    meta: {
      count: results.length,
      types: input.measurements.map((m) => m.type),
    },
  });

  await afterReadingsCreated(user, results, {
    symptomsPresent: input.measurements.some((m) => m.symptomsPresent === true),
  });
  return { rows: results };
}

/** The single-reading arm. */
export async function createReading(
  writer: ReadingWriter,
  input: z.output<typeof createMeasurementSchema>,
): Promise<{ row: Measurement } | typeof DUPLICATE_READING> {
  const { user, scoped } = writer;
  const {
    type,
    value,
    measuredAt,
    notes,
    source,
    glucoseContext,
    deviceType,
    symptomsPresent,
  } = input;

  let measurement;
  try {
    measurement = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: type as MeasurementType,
        value,
        unit: getUnitForType(type),
        // Server-resolved under a scoped credential. `source` is necessarily
        // the schema default here (the route refused any body that named
        // one), so nothing a caller asserted is being discarded.
        source: (scoped
          ? EXTERNAL_SOURCE
          : (source ?? "MANUAL")) as MeasurementSource,
        measuredAt,
        // The note is sealed at rest; the legacy plaintext column is nulled.
        notes: null,
        notesEncrypted: encryptNote(notes ?? null),
        glucoseContext: (glucoseContext as GlucoseContext | undefined) ?? null,
        // The deviceType column already accepts client metadata from the
        // batch route; the single-entry POST persists the tag too instead of
        // silently dropping it.
        deviceType: deviceType ?? null,
      },
    });
  } catch (err) {
    // `isP2002` rather than `instanceof Prisma.PrismaClientKnownRequestError`.
    // The helper's own docblock says why it exists: the structural check
    // survives client-bundling quirks, and the `instanceof` form does not —
    // when it misses, a duplicate escapes as an unhandled error and the caller
    // gets a 500 for a condition the route has always meant to answer with a
    // 409. A retry loop that meets a 500 keeps retrying.
    if (isP2002(err)) return DUPLICATE_READING;
    throw err;
  }

  await auditLog("measurement.create", {
    userId: user.id,
    ipAddress: writer.ipAddress,
    details: { type, measurementId: measurement.id },
  });

  annotate({
    action: {
      name: "measurement.create",
      entity_type: "measurement",
      entity_id: measurement.id,
    },
  });

  await afterReadingsCreated(user, [measurement], { symptomsPresent });
  return { row: measurement };
}

/**
 * The work fresh hand-entered readings start, in the order both arms have
 * always run it: the cache, the reminder satisfaction, the arrival and
 * morning-refresh seams, the safety-floor check, and the shared rollup and
 * status tail.
 */
async function afterReadingsCreated(
  user: ReadingWriter["user"],
  rows: Measurement[],
  options: { symptomsPresent: boolean | undefined },
): Promise<void> {
  // Flush every cache that reflects this user's measurement set so the next
  // read paints the new rows. An interactive create hard-evicts, so the SWR
  // readers don't serve the pre-write body back to the user.
  invalidateUserMeasurements(user.id, { evict: true });

  // Eventful Vorsorge satisfaction. Resolve the user's reminders against the
  // just-landed readings now. Fire-and-forget.
  fireAndForget(() => enqueueReminderSatisfy(user.id), {
    action: "reminder.satisfy.enqueue",
  });

  // Feed the shared arrival seams only the rows the create returned. Both
  // callbacks are best-effort: arrival or morning-refresh infrastructure can
  // never turn a committed write into an error response.
  void emitInsertedMeasurementArrivals(user.id, rows, "manual").catch(() => {});
  const sleepMeasuredAts = rows
    .filter((row) => row.type === "SLEEP_DURATION")
    .map((row) => row.measuredAt);
  if (sleepMeasuredAts.length > 0) {
    void maybeEnqueueMorningRefresh(user.id, sleepMeasuredAts).catch(() => {});
  }

  // The absolute clinical safety-floor check on the just-written readings
  // (confirm-gated, module-gated, never diagnoses). The combined BP form
  // lands both arms in one request, so the BP floor sees a whole reading; a
  // single-entry POST carries one arm, so the BP floor only fires through the
  // combined form, while a lone glucose reading is evaluated here. The
  // transient `symptomsPresent` flag lifts a confirmed breach to the
  // symptom-coupled emergency copy. Fire-and-forget — a notification failure
  // never fails the write.
  fireAndForget(
    () =>
      runSafetyFloorCheck({
        userId: user.id,
        written: rows.map((r) => ({
          type: r.type,
          value: r.value,
          measuredAt: r.measuredAt,
          glucoseContext: r.glucoseContext,
        })),
        symptomsPresent: options.symptomsPresent,
        timezone: user.timezone ?? undefined,
      }),
    { action: "measurement.safety_floor.check" },
  );

  // The shared post-mutation tail: rollup recompute (collapsed per (type,
  // day)) + status-insight re-warm, both best-effort. One helper so a future
  // write surface cannot remember one leg and forget the other. Runs inline
  // so the next read of the comprehensive / analytics surface is correct
  // without waiting on pg-boss.
  await afterMeasurementMutation(
    user.id,
    rows.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
    { source: "manual" },
  );
}
