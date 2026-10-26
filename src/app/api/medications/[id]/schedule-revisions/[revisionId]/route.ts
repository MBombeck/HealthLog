/**
 * v1.16.5 — DELETE /api/medications/[id]/schedule-revisions/[revisionId]
 * v1.16.6 — PATCH  /api/medications/[id]/schedule-revisions/[revisionId]
 *
 * DELETE removes a MANUAL schedule era (one the owner appended through
 * the sibling POST, or a correction minted by PATCH). Write-path
 * archives (`source: "ARCHIVED"`) are immutable history — the
 * wholesale-replace path minted them from rows that actually existed,
 * so deleting one would falsify the ledger; the route refuses with 409.
 * Deleting a correction restores the archived original it superseded.
 *
 * PATCH corrects an era. A MANUAL era updates in place. An ARCHIVED era
 * stays untouched as the audit record: the correction is minted as a
 * new MANUAL revision and the original's `supersededByRevisionId`
 * points at it, so every era consumer reads the correction while the
 * recorded history remains inspectable. Validation mirrors the sibling
 * POST (bounds order, live-plan ceiling, no overlap with other active
 * eras); the check-then-write runs under a `FOR UPDATE` lock on the
 * medication row so concurrent era writes serialise.
 *
 * Auth: requireAuth() + medication ownership; a revision belonging to
 * another medication (or another user's medication) surfaces as 404,
 * existence channel sealed like every medication sub-route.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { scheduleRevisionUpdateSchema } from "@/lib/validations/schedule-revision";
import {
  toRevisionPayloadEntry,
  type ScheduleRevisionEntry,
} from "@/lib/medications/scheduling/schedule-eras";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string; revisionId: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Correcting an era the compliance engine reads back
    // over months of somebody's history.
    const { user } = await requireRecordAuth("manage", "medications");
    const { id, revisionId } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const med = await prisma.medication.findUnique({
      where: { id },
      select: { createdAt: true },
    });
    if (!med) {
      return apiError("Medication not found", 404);
    }

    const parsed = await parseJsonBody(request, scheduleRevisionUpdateSchema, {
      maxBytes: 16 * 1024,
      input: (body) => body ?? {},
    });
    if (!parsed.ok) return parsed.error;

    const validFrom = new Date(parsed.data.validFrom);
    const validUntil = new Date(parsed.data.validUntil);

    // Sanity floor — mirrors the sibling POST.
    if (validFrom.getUTCFullYear() < 1900) {
      return apiError("validFrom must be a date after 1900", 422);
    }

    // Corrected snapshot, shaped exactly like the POST path: daily
    // recurrence at the (schema-deduped, sorted) times, window pulled
    // to their min/max.
    const times = parsed.data.timesOfDay;
    const entry = toRevisionPayloadEntry({
      timesOfDay: times,
      windowStart: times[0],
      windowEnd: times[times.length - 1],
      daysOfWeek: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
      label: null,
      dose: null,
      reminderGraceMinutes: null,
    });

    // Validate-then-write under the per-medication row lock — the same
    // serialisation as the sibling POST, so a concurrent era write can
    // never slip an overlapping interval past the check.
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM medications
        WHERE id = ${id}
        FOR UPDATE
      `;

      const target = await tx.medicationScheduleRevision.findUnique({
        where: { id: revisionId },
        select: {
          id: true,
          medicationId: true,
          source: true,
          supersededByRevisionId: true,
          validUntil: true,
          // v1.37.0 — the pre-image the audit row carries (C4).
          validFrom: true,
        },
      });
      if (!target || target.medicationId !== id) {
        return {
          ok: false as const,
          status: 404 as const,
          error: "Schedule revision not found",
        };
      }
      if (target.supersededByRevisionId !== null) {
        return {
          ok: false as const,
          status: 409 as const,
          error: "This era has already been corrected",
        };
      }

      const others = await tx.medicationScheduleRevision.findMany({
        where: {
          medicationId: id,
          supersededByRevisionId: null,
          id: { not: revisionId },
        },
        select: { validFrom: true, validUntil: true },
      });

      // Live-plan ceiling, mirroring the POST rule: the live era began
      // at the newest active `validUntil` (never earlier than
      // `createdAt`). The edited era's own recorded end counts — an
      // ARCHIVED era adjacent to the live plan may keep its boundary,
      // but no correction may extend into tracked live history.
      const liveBoundary = [
        target.validUntil,
        ...others.map((r) => r.validUntil),
      ].reduce((latest, v) => (v > latest ? v : latest), med.createdAt);
      if (validUntil.getTime() > liveBoundary.getTime()) {
        return {
          ok: false as const,
          status: 422 as const,
          error: "A corrected era must end before the current plan begins",
        };
      }

      // No overlap with any OTHER active interval `[validFrom,
      // validUntil)` — the corrected bounds may of course cover the
      // era's own previous interval.
      const overlaps = others.some(
        (r) =>
          validFrom.getTime() < r.validUntil.getTime() &&
          validUntil.getTime() > r.validFrom.getTime(),
      );
      if (overlaps) {
        return {
          ok: false as const,
          status: 422 as const,
          error: "The era overlaps an existing schedule era",
        };
      }

      const revisionSelect = {
        id: true,
        validFrom: true,
        validUntil: true,
        source: true,
      } as const;

      const previousBounds = {
        validFrom: target.validFrom,
        validUntil: target.validUntil,
      };
      if (target.source === "MANUAL") {
        const revision = await tx.medicationScheduleRevision.update({
          where: { id: revisionId },
          data: {
            validFrom,
            validUntil,
            payload: [entry] as unknown as Prisma.InputJsonValue,
          },
          select: revisionSelect,
        });
        return {
          ok: true as const,
          revision,
          mode: "in_place" as const,
          previousBounds,
        };
      }

      // ARCHIVED — immutable. Mint the correction as a MANUAL row and
      // park the original behind it as the audit record.
      const revision = await tx.medicationScheduleRevision.create({
        data: {
          medicationId: id,
          validFrom,
          validUntil,
          source: "MANUAL",
          payload: [entry] as unknown as Prisma.InputJsonValue,
        },
        select: revisionSelect,
      });
      await tx.medicationScheduleRevision.update({
        where: { id: revisionId },
        data: { supersededByRevisionId: revision.id },
      });
      return {
        ok: true as const,
        revision,
        mode: "supersede" as const,
        previousBounds,
      };
    });

    if (!outcome.ok) {
      return apiError(outcome.error, outcome.status);
    }

    await auditLog("medication.schedule_revision.updated", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The era boundaries the correction replaced. An era is a window
      // the compliance engine reads months of history through; moving it
      // silently re-scores days nobody looked at again.
      details: {
        medicationId: id,
        revisionId,
        mode: outcome.mode,
        ...(outcome.mode === "supersede" && {
          correctionRevisionId: outcome.revision.id,
        }),
        ...overwriteDetails({
          before: {
            validFrom: outcome.previousBounds.validFrom,
            validUntil: outcome.previousBounds.validUntil,
          },
          after: {
            validFrom: outcome.revision.validFrom,
            validUntil: outcome.revision.validUntil,
          },
        }),
      },
    });

    annotate({
      action: {
        name:
          outcome.mode === "in_place"
            ? "medication.schedule_revision.manual_updated"
            : "medication.schedule_revision.archived_corrected",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        revision_id: outcome.revision.id,
        ...(outcome.mode === "supersede" && {
          superseded_revision_id: revisionId,
        }),
      },
    });

    // v1.16.9 — an era write re-segments the bands every cached payload
    // (list next-due, compliance cells, dashboard tally) was built on;
    // hard-evict so the next read reflects the new history immediately.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({
      id: outcome.revision.id,
      validFrom: outcome.revision.validFrom.toISOString(),
      validUntil: outcome.revision.validUntil.toISOString(),
      source: outcome.revision.source,
      entries: [
        {
          timesOfDay: times,
          label: null,
          dose: null,
          scheduleType: "SCHEDULED",
        },
      ],
    });
  },
);

/**
 * v1.37.0 — a one-line rendering of an era's dosing plan, for the audit row
 * a hard delete leaves behind (C3). Defensive by construction: a malformed
 * payload degrades to an empty string rather than throwing on a delete path.
 */
function summarisePayloadForAudit(payload: unknown): string {
  if (!Array.isArray(payload)) return "";
  return payload
    .map((raw) => {
      const entry = (raw ?? {}) as Partial<ScheduleRevisionEntry>;
      const times = Array.isArray(entry.timesOfDay)
        ? entry.timesOfDay.filter((t): t is string => typeof t === "string")
        : [];
      const dose = typeof entry.dose === "string" ? entry.dose : null;
      return [times.join(","), dose].filter(Boolean).join(" ");
    })
    .filter((part) => part !== "")
    .join(" | ");
}

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE, and a hard delete: the era row goes and the
    // supersede chain is repaired behind it. C3 below is what makes the era
    // readable back out of the feed.
    const { user } = await requireRecordAuth("manage", "medications");
    const { id, revisionId } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const revision = await prisma.medicationScheduleRevision.findUnique({
      where: { id: revisionId },
      // v1.37.0 — the era's own dates and payload summary go into the audit
      // row (C3); the row itself does not survive the delete.
      select: {
        id: true,
        medicationId: true,
        source: true,
        validFrom: true,
        validUntil: true,
        payload: true,
      },
    });
    if (!revision || revision.medicationId !== id) {
      return apiError("Schedule revision not found", 404);
    }

    if (revision.source !== "MANUAL") {
      return apiError("Only manually added schedule eras can be deleted", 409);
    }

    // Deleting a correction restores the archived original it had
    // superseded — the audit record becomes the era again, atomically
    // with the delete.
    await prisma.$transaction([
      prisma.medicationScheduleRevision.delete({
        where: { id: revisionId },
      }),
      prisma.medicationScheduleRevision.updateMany({
        where: { medicationId: id, supersededByRevisionId: revisionId },
        data: { supersededByRevisionId: null },
      }),
    ]);

    await auditLog("medication.schedule_revision.deleted", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The era's dates and its dosing summary. Without them the feed
      // says an era was deleted and the compliance history it explained
      // becomes unexplainable.
      details: {
        medicationId: id,
        revisionId,
        ...destroyedDetails({
          model: "MedicationScheduleRevision",
          id: revisionId,
          label: summarisePayloadForAudit(revision.payload),
          effectiveAt: revision.validFrom,
          extra: { validUntil: revision.validUntil },
        }),
      },
    });

    annotate({
      action: {
        name: "medication.schedule_revision.manual_deleted",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { revision_id: revisionId },
    });

    // v1.16.9 — an era write re-segments the bands every cached payload
    // (list next-due, compliance cells, dashboard tally) was built on;
    // hard-evict so the next read reflects the new history immediately.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({ deleted: true });
  },
);
