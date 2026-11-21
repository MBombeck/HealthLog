/**
 * #169 — removing a GLP-1 titration step by the client's own id.
 *
 *   DELETE /api/medications/[id]/glp1/dose-changes?clientId=<id>
 *
 * A device that removes a step before its upload answered does not know the
 * server id, and may not know whether the step exists on the server at all.
 * This form names the step by its client id and is idempotent: it removes the
 * step when one exists and spends the client id either way, so an upload of
 * the same step that commits later answers 410 instead of creating it. Same
 * level, bucket and audit row as the delete by server id beside it.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { apiError, getClientIp, returnAllZodIssues } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { glp1DoseChangeDeleteQuerySchema } from "@/lib/validations/medication";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { destroyedDetails } from "@/lib/sharing/audit-details";

type RouteParams = { params: Promise<{ id: string }> };

const RATE_LIMIT = 30;
const WINDOW_MS = 60_000;

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, actor } = await requireRecordAuth("manage", "medications");
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    // The actor's own bucket, shared with the step's other writes.
    const rl = await checkRateLimit(
      `medication-glp1:dose-change:${actor.id}`,
      RATE_LIMIT,
      WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many requests", 429, {
        headers: rateLimitHeaders(rl),
      });
    }

    const parsed = glp1DoseChangeDeleteQuerySchema.safeParse({
      clientId: request.nextUrl.searchParams.get("clientId") ?? undefined,
    });
    if (!parsed.success) {
      return returnAllZodIssues(
        parsed.error,
        422,
        undefined,
        glp1DoseChangeDeleteQuerySchema,
      );
    }
    const { clientId } = parsed.data;

    const removed = await prisma.$transaction(async (tx) => {
      const existing = await tx.medicationDoseChange.findUnique({
        where: { medicationId_clientId: { medicationId: id, clientId } },
      });
      if (existing) {
        await tx.medicationDoseChange.delete({ where: { id: existing.id } });
      }
      await tx.medicationDoseChangeTombstone.upsert({
        where: { medicationId_clientId: { medicationId: id, clientId } },
        create: { medicationId: id, clientId },
        update: {},
      });
      return existing;
    });

    if (removed) {
      await auditLog("medication.glp1.doseChange.delete", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: {
          medicationId: id,
          doseChangeId: removed.id,
          ...destroyedDetails({
            model: "MedicationDoseChange",
            id: removed.id,
            label: `${removed.doseValue} ${removed.doseUnit}`,
            effectiveAt: removed.effectiveFrom,
            extra: { clientId },
          }),
        },
      });
      invalidateUserMedications(user.id, { evict: true });
    }

    annotate({
      action: {
        name: "medication.glp1.doseChange.delete",
        entity_type: "medication_dose_change",
        ...(removed ? { entity_id: removed.id } : {}),
      },
      meta: { medication_id: id, by_client_id: true, removed: !!removed },
    });

    return new Response(null, { status: 204 });
  },
);
