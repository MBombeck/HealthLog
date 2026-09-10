/**
 * `POST /api/encounters/{id}/restore` — clear a visit's tombstone.
 *
 * MANAGE rather than WRITE: undoing a deletion is a management act when the
 * manager is the one who holds delete.
 *
 * The link rows survived the soft delete — they cascade only on a hard one —
 * so a restored visit comes back with its documents, labs and conditions still
 * filed against it. Its appointment reminder comes back too, but only if the
 * appointment is still in the future: restoring a visit whose date has passed
 * must not produce a nudge for something that already did or did not happen.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { encounterKindLabel } from "@/lib/encounters/kind-label";
import { toEncounterDTO } from "@/lib/encounters/dto";
import {
  ENCOUNTER_INCLUDE,
  loadEncounterLinks,
  resolveOwnerNotificationContext,
  shouldHaveReminder,
} from "@/lib/encounters/service";
import { reanchorAppointmentReminder } from "@/lib/encounters/appointment-reminder";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.encounter.findUnique({
      where: { id },
      include: { practitioner: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Visit not found", 404);
    }

    if (existing.deletedAt !== null) {
      const { timezone, locale } = await resolveOwnerNotificationContext(
        user.id,
      );
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.encounter.update({
          where: { id },
          data: { deletedAt: null },
        });
        if (
          existing.reminderId &&
          shouldHaveReminder(existing.status, existing.occurredAt, now)
        ) {
          const reminder = await tx.measurementReminder.findUnique({
            where: { id: existing.reminderId },
            select: { id: true, origin: true },
          });
          if (reminder?.origin === "ENCOUNTER") {
            await reanchorAppointmentReminder(
              tx,
              reminder.id,
              {
                userId: user.id,
                occurredAt: existing.occurredAt,
                practitionerName: existing.practitioner?.name ?? null,
                practitionerLocation: existing.practitioner?.location ?? null,
                kindLabel: encounterKindLabel(existing.kind, locale),
              },
              timezone,
            );
          }
        }
      });
    }

    const row = await prisma.encounter.findUniqueOrThrow({
      where: { id },
      include: ENCOUNTER_INCLUDE,
    });
    const visible = await actingDomainVisibility(prisma, grantId);
    const links = await loadEncounterLinks(prisma, user.id, id, visible);

    await auditLog("encounter.visit.restore", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { encounterId: id, occurredAt: row.occurredAt.toISOString() },
    });

    // A restored visit must reach the cached daily-digest / snapshot cells
    // (Today rail) on the next read — evict the analytics bucket.
    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "encounter.visit.restore",
        entity_type: "encounter",
        entity_id: id,
      },
    });

    return apiSuccess(toEncounterDTO(row, links));
  },
);
