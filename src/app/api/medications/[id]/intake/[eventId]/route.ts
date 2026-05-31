import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { updateIntakeEventSchema } from "@/lib/validations/medication";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string; eventId: string }> };

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id, eventId } = await params;

    // v1.7.0 sync — a tombstoned event 404s on PUT; the `deletedAt: null`
    // filter refuses to resurrect-edit a soft-deleted intake.
    const event = await prisma.medicationIntakeEvent.findFirst({
      where: { id: eventId, deletedAt: null },
    });

    if (!event || event.userId !== user.id || event.medicationId !== id) {
      return apiError("Intake not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = updateIntakeEventSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — per-event update hot path; multi-issue 422 +
      // audit breadcrumb keyed
      // `medications.intake.event.update.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "medications.intake.event.update.validation-failed" },
        meta: {
          issue_count: issues.length,
          medication_id: id,
          event_id: eventId,
        },
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "medications.intake.event.update.validation-failed",
            details: JSON.stringify({
              issues,
              medicationId: id,
              eventId,
            }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422);
    }

    const data = parsed.data;
    const updated = await prisma.medicationIntakeEvent.update({
      where: { id: eventId },
      data: {
        ...(data.takenAt !== undefined && { takenAt: data.takenAt }),
        ...(data.skipped !== undefined && { skipped: data.skipped }),
        ...(data.scheduledFor !== undefined && {
          scheduledFor: data.scheduledFor,
        }),
        // v1.7.0 sync — bump the reconciliation counter on every
        // server-side mutation so the `/api/sync/changes` feed echoes a
        // monotonic value to paired clients.
        syncVersion: { increment: 1 },
      },
    });

    await auditLog("medication.intake.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { eventId, medicationId: id },
    });

    annotate({
      action: {
        name: "medication.intake.update",
        entity_type: "intake_event",
        entity_id: eventId,
      },
      meta: { medication_id: id },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the edited event.
    invalidateUserMedications(user.id);

    // v1.4.39 W-MED — refresh the rollup row for both the old + new
    // scheduledFor day-keys when the timestamp moved across a day
    // boundary; if only takenAt / skipped changed the second call
    // collapses to a no-op upsert.
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });
    if (
      data.scheduledFor !== undefined &&
      data.scheduledFor.getTime() !== event.scheduledFor.getTime()
    ) {
      await recomputeMedicationComplianceForEvent({
        userId: user.id,
        medicationId: id,
        scheduledFor: data.scheduledFor,
        tz: user.timezone,
      });
    }

    // v1.5.0 — re-evaluate the one-shot active flag. A skip-flip on the
    // single live intake of a one-shot medication should reactivate it
    // (the dose is no longer logged), and the reverse case should
    // deactivate again. No-op for non-one-shot medications.
    await reconcileOneShotState(prisma, id, user.id);

    return apiSuccess(updated);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id, eventId } = await params;

    const event = await prisma.medicationIntakeEvent.findUnique({
      where: { id: eventId },
    });

    if (!event || event.userId !== user.id || event.medicationId !== id) {
      return apiError("Intake not found", 404);
    }

    // v1.7.0 sync — soft-delete instead of a hard `delete`. An intake is
    // an immutable fact, so a "correction" is a tombstone + re-insert
    // (never an in-place edit). Setting `deletedAt` (+ bumping
    // `syncVersion`) leaves the row in place so the `/api/sync/changes`
    // feed surfaces the deletion as a tombstone keyed on the server `id`
    // to paired clients offline at delete time. Every today / compliance
    // / list read filters `deletedAt: null`, so the row is invisible to
    // normal reads from here on. A re-delete re-bumps harmlessly.
    await prisma.medicationIntakeEvent.update({
      where: { id: eventId },
      data: {
        deletedAt: new Date(),
        syncVersion: { increment: 1 },
      },
    });

    const ip = getClientIp(request) ?? "unknown";
    await auditLog("medication.intake.delete", {
      userId: user.id,
      ipAddress: ip,
      details: { eventId, medicationId: id },
    });

    annotate({
      action: {
        name: "medication.intake.delete",
        entity_type: "intake_event",
        entity_id: eventId,
      },
      meta: { medication_id: id },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the deletion.
    invalidateUserMedications(user.id);

    // v1.4.39 W-MED — refresh the rollup row for the day the deleted
    // event sat on. When that day now holds zero events the helper
    // drops the rollup row entirely.
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });

    // v1.5.0 — re-evaluate the one-shot active flag. Deleting the
    // single live intake of a one-shot medication reactivates it so
    // the dashboard / lists / worker pick it back up. No-op for
    // non-one-shot medications.
    await reconcileOneShotState(prisma, id, user.id);

    return apiSuccess({ deleted: true });
  },
);
