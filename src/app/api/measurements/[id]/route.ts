import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import {
  updateMeasurementSchema,
  USER_CORRECTABLE_MEASUREMENT_SOURCES,
  validateMeasurementRange,
} from "@/lib/validations/measurement";
import { encryptNote, shapeMeasurementNotes } from "@/lib/crypto/note-cipher";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { Prisma } from "@/generated/prisma/client";
import { NextRequest } from "next/server";
import { z } from "zod";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "measurements");

    const { id } = await params;

    // v1.7.0 — filter `deletedAt: null` so a soft-deleted (tombstoned)
    // row 404s on a direct GET, matching the list / analytics / rollup
    // read invariant. `findFirst` (not `findUnique`) because `deletedAt`
    // is not part of a unique index.
    const measurement = await prisma.measurement.findFirst({
      where: { id, deletedAt: null },
    });

    if (!measurement || measurement.userId !== user.id) {
      return apiError("Measurement not found", 404);
    }

    annotate({
      action: {
        name: "measurement.get",
        entity_type: "measurement",
        entity_id: id,
      },
    });

    return apiSuccess(shapeMeasurementNotes(measurement));
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Correcting somebody else's reading is management of
    // their record, not a contribution to it, and the previous value is gone
    // the moment this lands: the audit row below carries it.
    const { user } = await requireRecordAuth("manage", "measurements");

    const { id } = await params;

    // v1.7.0 — refuse to resurrect-edit a tombstoned row. The
    // `deletedAt: null` filter makes a soft-deleted measurement 404 on
    // PUT rather than letting an `update` re-write a still-tombstoned row.
    const existing = await prisma.measurement.findFirst({
      where: { id, deletedAt: null },
    });

    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });

    if (jsonError) return jsonError;
    const parsed = updateMeasurementSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — measurement edit hot path; multi-issue 422 +
      // audit breadcrumb keyed `measurements.update.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "measurements.update.validation-failed" },
        meta: { issue_count: issues.length, measurement_id: id },
      });
      // v1.4.49 — strip `message` from the audit-ledger row; the
      // update schema carries free-text `notes`.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
      // .create`, because that helper is the only writer that stamps
      // `actorUserId`. Filed under the resolved record either way; without the
      // stamp a manager's malformed payload would read as the owner's own.
      void auditLog("measurements.update.validation-failed", {
        userId: user.id,
        details: {
          issues: auditIssues,
          measurementId: id,
        },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
      return returnAllZodIssues(parsed.error, 422);
    }

    const data = parsed.data;

    // v1.27.5 (di-001) — the edit path was the ONE write surface that skipped
    // the per-type plausibility bands: every other producer (POST, batch,
    // CSV import, Apple export, Telegram, MCP) enforces `VALUE_RANGES`, so an
    // implausible edited value flowed unchecked into rollups, the health
    // score, the BP gates and the Coach snapshot.
    if (data.value !== undefined && data.value !== existing.value) {
      // Server-owned rows first: a value attributed to a connector / import /
      // computed engine is the provider's reading — editing the number would
      // forge a source-attributed row the server never received. Timestamp
      // and note edits stay allowed — annotating a Withings reading is
      // legitimate.
      //
      // v1.38.x — gated on `USER_CORRECTABLE_MEASUREMENT_SOURCES` rather than
      // the write-side `WRITABLE_MEASUREMENT_SOURCES` the two once shared,
      // because `EXTERNAL` separates the questions. A client may not NAME that
      // source (it is resolved from the ingest credential, and the write
      // allowlist is published as `ingest.writeAllowlist`), but the hardware
      // behind the token is the user's own scale, so the rationale above —
      // "the value is the provider's" — does not reach it. Locking those rows
      // would also break the correctability the settings card and the Home
      // Assistant guide promise. This is the only site that reads the wider
      // set; re-merging the two constants silently value-locks bridge rows.
      if (
        !(USER_CORRECTABLE_MEASUREMENT_SOURCES as readonly string[]).includes(
          existing.source,
        )
      ) {
        annotate({
          action: { name: "measurements.update.server-owned-source" },
          meta: { measurement_id: id, source: existing.source },
        });
        return apiError(
          "Values from a connected source cannot be edited",
          409,
          { errorCode: "measurement.update.server_owned_source" },
        );
      }

      // Range check against the row's OWN type (the edit body carries no
      // type). Returned through the standard multi-issue 422 envelope so the
      // edit sheet renders it like any other field error.
      const rangeCheck = z
        .object({
          value: z.number().superRefine((value, ctx) => {
            const rangeError = validateMeasurementRange(existing.type, value);
            if (rangeError) {
              ctx.addIssue({ code: "custom", message: rangeError });
            }
          }),
        })
        .safeParse({ value: data.value });
      if (!rangeCheck.success) {
        annotate({
          action: { name: "measurements.update.validation-failed" },
          meta: {
            issue_count: rangeCheck.error.issues.length,
            measurement_id: id,
            reason: "value_out_of_range",
          },
        });
        return returnAllZodIssues(rangeCheck.error, 422);
      }
    }

    let measurement;
    try {
      measurement = await prisma.measurement.update({
        where: { id },
        data: {
          ...(data.value !== undefined && { value: data.value }),
          ...(data.measuredAt !== undefined && { measuredAt: data.measuredAt }),
          // v1.23 — write the note to the encrypted column; null the legacy
          // plaintext column. An explicit `null` clears the note.
          ...(data.notes !== undefined && {
            notes: null,
            notesEncrypted: encryptNote(data.notes),
          }),
        },
      });
    } catch (err) {
      // v1.4.28 FB-B1 — re-pointing `measuredAt` onto an existing
      // `(userId, type, measuredAt, source, sleepStage)` tuple raises
      // `P2002`. Mirror the POST handler's catch so the row-edit Sheet
      // surfaces a clean 409 with a translatable `errorCode` instead of
      // the bare 500 the UI used to render as the generic save-error
      // toast.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return apiError(
          "A measurement with this timestamp already exists",
          409,
          { errorCode: "measurement.duplicate_timestamp" },
        );
      }
      throw err;
    }

    await auditLog("measurement.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C4 — the overwritten scalars. Without them the owner's feed says a
      // reading changed and cannot say from what. The note is named and never
      // quoted: it is encrypted on the row and copying it here would make the
      // audit table a second store for it.
      details: {
        measurementId: id,
        ...overwriteDetails({
          before: { value: existing.value, measuredAt: existing.measuredAt },
          after: {
            value: measurement.value,
            measuredAt: measurement.measuredAt,
          },
          redacted: data.notes !== undefined ? ["notes"] : [],
        }),
      },
    });

    annotate({
      action: {
        name: "measurement.update",
        entity_type: "measurement",
        entity_id: id,
      },
    });

    // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
    // caches so subsequent reads reflect the edited row. Interactive
    // edit — hard-evict so the SWR readers don't serve the pre-edit body.
    invalidateUserMeasurements(user.id, { evict: true });

    // v1.37.19 (C2-F1) — shared post-mutation tail. Both the OLD and the
    // NEW identity ride the list: an edit can move the row across day
    // boundaries or re-type it, and the helper collapses identical
    // (type, day) pairs so the common in-place edit fires once.
    await afterMeasurementMutation(user.id, [
      { type: measurement.type, measuredAt: measurement.measuredAt },
      { type: existing.type, measuredAt: existing.measuredAt },
    ]);

    return apiSuccess(shapeMeasurementNotes(measurement));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. The row tombstones and `measurements/restore` puts it
    // back, so the destruction is reversible by the owner and by whoever did
    // it; the audit row already names the reading and its type.
    const { user } = await requireRecordAuth("manage", "measurements");

    const { id } = await params;

    const existing = await prisma.measurement.findUnique({
      where: { id },
    });

    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement not found", 404);
    }

    // v1.7.0 — soft-delete instead of a hard `delete`. Setting `deletedAt`
    // (+ bumping `syncVersion`) leaves the row in place so the
    // `/api/sync/changes` delta feed can surface it as a tombstone to
    // paired clients that were offline at delete time. Every list /
    // analytics / rollup read already filters `deletedAt: null`
    // (see `measurements/route.ts:100`), so the row is invisible to
    // normal reads from this point on. A row that is already tombstoned
    // re-bumps `syncVersion` harmlessly (idempotent re-delete).
    await prisma.measurement.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        syncVersion: { increment: 1 },
      },
    });

    await auditLog("measurement.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { measurementId: id, type: existing.type },
    });

    annotate({
      action: {
        name: "measurement.delete",
        entity_type: "measurement",
        entity_id: id,
      },
    });

    // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
    // caches so subsequent reads reflect the deletion. Interactive
    // delete — hard-evict so the SWR readers don't serve the pre-delete
    // body.
    invalidateUserMeasurements(user.id, { evict: true });

    // v1.37.19 (C2-F1) — shared post-mutation tail (the recompute drops
    // the rollup row when the day's measurement count goes to zero).
    await afterMeasurementMutation(user.id, [
      { type: existing.type, measuredAt: existing.measuredAt },
    ]);

    return apiSuccess({ deleted: true });
  },
);
