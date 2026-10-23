/**
 * `POST /api/measurements` with a named `sleepStage`: one segment, stored as
 * the batch route stores a HealthKit sleep sample.
 *
 * The same three steps as the batch route, in the same order: a same-reading
 * row of the opposite source (MANUAL against APPLE_HEALTH) makes this one a
 * duplicate; otherwise `reconcileExternalMeasurement` settles both unique
 * identities at once, reporting an exact external-id match as a duplicate
 * and adopting a row that only shares the natural identity. So a bridge that
 * re-posts the same segment gets one row, whichever path it used first.
 *
 * `201` with the stored row when it was inserted, `200` when it was already
 * there (`duplicate`) or was corrected in place (`updated`). The row carries
 * a `status` saying which.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { EXTERNAL_SOURCE } from "@/lib/measurements/external-source";
import { annotate } from "@/lib/logging/context";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { auditLog } from "@/lib/auth/audit";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getUnitForType } from "@/lib/validations/measurement";
import { shapeMeasurementNotes } from "@/lib/crypto/note-cipher";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import {
  toSleepStageSegment,
  type sleepStageEntrySchema,
} from "@/lib/validations/sleep-stage-entry";
import {
  MeasurementReconciliationError,
  reconcileExternalMeasurement,
} from "@/lib/measurements/reconcile-external-measurement";
import {
  MEASURED_AT_TOLERANCE_MS,
  isMergeableSource,
  isSameReadingAcrossSource,
  oppositeMergeSource,
} from "@/lib/measurements/cross-source-merge";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";

export async function createNamedSleepStage(
  args: {
    userId: string;
    scoped: boolean;
    ipAddress: string | null;
  },
  entry: z.output<typeof sleepStageEntrySchema>,
): Promise<Response> {
  const { userId, scoped } = args;
  const segment = toSleepStageSegment(entry);
  // Under a scoped credential the source is resolved from the credential,
  // as on the other arms of this route: the route already refused any body
  // that named one.
  const source = (scoped ? EXTERNAL_SOURCE : entry.source) as MeasurementSource;
  const type: MeasurementType = "SLEEP_DURATION";

  // Cross-source same reading, exactly as the batch route decides it.
  if (isMergeableSource(source)) {
    const candidates = await prisma.measurement.findMany({
      where: {
        userId,
        deletedAt: null,
        type,
        source: oppositeMergeSource(source),
        measuredAt: {
          gte: new Date(segment.end.getTime() - MEASURED_AT_TOLERANCE_MS),
          lte: new Date(segment.end.getTime() + MEASURED_AT_TOLERANCE_MS),
        },
      },
      select: {
        id: true,
        type: true,
        source: true,
        value: true,
        measuredAt: true,
      },
    });
    const twin = candidates.find((candidate) =>
      isSameReadingAcrossSource(
        { type, source, value: segment.minutes, measuredAt: segment.end },
        candidate,
      ),
    );
    if (twin) {
      return namedSleepStageResponse(twin.id, "duplicate", {
        stage: segment.stage,
        source,
        crossSource: true,
      });
    }
  }

  const verdict = await prisma.$transaction((tx) =>
    reconcileExternalMeasurement(
      tx,
      {
        userId,
        type,
        value: segment.minutes,
        unit: getUnitForType(type),
        source,
        measuredAt: segment.end,
        externalId: segment.externalId,
        externalSourceVersion: null,
        sleepStage: segment.stage,
        deviceType: entry.deviceType ?? null,
      },
      { exactExternalMatch: "duplicate" },
    ),
  );

  if (verdict.status === "failed") {
    throw new MeasurementReconciliationError(verdict);
  }
  if (verdict.status === "rejected_range") {
    // The schema applies the same band, so this is the two gates disagreeing.
    return apiError("Value out of plausible range", 422, {
      errorCode: "measurement.create.invalid",
    });
  }

  const status =
    verdict.status === "inserted"
      ? "inserted"
      : verdict.status === "duplicate"
        ? "duplicate"
        : "updated";

  if (status !== "duplicate") {
    await auditLog("measurement.create", {
      userId,
      ipAddress: args.ipAddress,
      details: {
        type,
        measurementId: verdict.row.id,
        sleepStage: segment.stage,
        status,
      },
    });
    invalidateUserMeasurements(userId, { evict: true });
    fireAndForget(() => enqueueReminderSatisfy(userId), {
      action: "reminder.satisfy.enqueue",
    });
    if (status === "inserted") {
      void emitInsertedMeasurementArrivals(
        userId,
        [verdict.row],
        "manual",
      ).catch(() => {});
      void maybeEnqueueMorningRefresh(userId, [segment.end]).catch(() => {});
    }
    await afterMeasurementMutation(
      userId,
      [{ type, measuredAt: segment.end }, ...(verdict.dirtyIdentities ?? [])],
      { source: "manual" },
    );
  }

  return namedSleepStageResponse(verdict.row.id, status, {
    stage: segment.stage,
    source,
    crossSource: false,
  });
}

async function namedSleepStageResponse(
  id: string,
  status: "inserted" | "updated" | "duplicate",
  meta: { stage: string; source: string; crossSource: boolean },
): Promise<Response> {
  annotate({
    action: {
      name: "measurement.create.sleep-stage",
      entity_type: "measurement",
      entity_id: id,
    },
    meta: {
      status,
      stage: meta.stage,
      source: meta.source,
      cross_source_merge: meta.crossSource,
    },
  });
  const row = await prisma.measurement.findUniqueOrThrow({ where: { id } });
  return apiSuccess(
    { ...shapeMeasurementNotes(row), status },
    status === "inserted" ? 201 : 200,
  );
}
