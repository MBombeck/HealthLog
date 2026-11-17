/**
 * #169 — correcting and removing one GLP-1 titration step.
 *
 *   PATCH  /api/medications/[id]/glp1/dose-changes/[doseChangeId]
 *   DELETE /api/medications/[id]/glp1/dose-changes/[doseChangeId]
 *
 * The steps feed the Coach snapshot, the plateau insight, the doctor report
 * and the timeline, so a typo has to be correctable rather than living on as
 * history. Same level as the create (`POST .../glp1`): MANAGE over the
 * `medications` section, the actor's own 30/min bucket, and an audit row that
 * reconstructs the change: the previous values on a correction (C4), the
 * removed step's dose and date on a removal (C3). The removal is hard, like
 * the side-effect delete beside it: a titration step carries no sync
 * tombstone, and its audit row says what it was.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { glp1DoseChangePatchSchema } from "@/lib/validations/medication";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { encryptNote, shapeDoseChangeNote } from "@/lib/crypto/note-cipher";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";

type RouteParams = {
  params: Promise<{ id: string; doseChangeId: string }>;
};

const RATE_LIMIT = 30;
const WINDOW_MS = 60_000;

/** The step, when it belongs to this medication; null answers 404. */
function findStep(medicationId: string, doseChangeId: string) {
  return prisma.medicationDoseChange.findFirst({
    where: { id: doseChangeId, medicationId },
  });
}

/** The actor's own bucket (C1): a manager cannot lock the owner out. */
async function refuseOverRate(actor: { id: string }): Promise<Response | null> {
  const rl = await checkRateLimit(
    `medication-glp1:dose-change:${actor.id}`,
    RATE_LIMIT,
    WINDOW_MS,
  );
  if (rl.allowed) return null;
  return apiError("Too many requests", 429, {
    headers: rateLimitHeaders(rl),
  });
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, actor } = await requireRecordAuth("manage", "medications");
    const { id, doseChangeId } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;
    const limited = await refuseOverRate(actor);
    if (limited) return limited;

    const existing = await findStep(id, doseChangeId);
    if (!existing) return apiError("Dose change not found", 404);

    const parsed = await parseJsonBody(request, glp1DoseChangePatchSchema, {
      maxBytes: 16 * 1024,
    });
    if (!parsed.ok) return parsed.error;
    const { effectiveFrom, doseValue, doseUnit, note } = parsed.data;

    const updated = await prisma.medicationDoseChange.update({
      where: { id: existing.id },
      data: {
        ...(effectiveFrom !== undefined && { effectiveFrom }),
        ...(doseValue !== undefined && { doseValue }),
        ...(doseUnit !== undefined && { doseUnit }),
        // A note is sealed at rest; the plaintext column is cleared with it.
        ...(note !== undefined && {
          noteEncrypted: encryptNote(note),
          note: null,
        }),
      },
    });

    await auditLog("medication.glp1.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        kind: "doseChange.update",
        doseChangeId: existing.id,
        ...overwriteDetails({
          before: {
            effectiveFrom: existing.effectiveFrom,
            doseValue: existing.doseValue,
            doseUnit: existing.doseUnit,
          },
          after: {
            effectiveFrom: updated.effectiveFrom,
            doseValue: updated.doseValue,
            doseUnit: updated.doseUnit,
          },
          // The note is free text; the audit row says it changed, not what.
          redacted: note !== undefined ? ["note"] : [],
        }),
      },
    });

    annotate({
      action: {
        name: "medication.glp1.doseChange.update",
        entity_type: "medication_dose_change",
        entity_id: existing.id,
      },
      meta: { medication_id: id },
    });

    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({ doseChange: shapeDoseChangeNote(updated) });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, actor } = await requireRecordAuth("manage", "medications");
    const { id, doseChangeId } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;
    const limited = await refuseOverRate(actor);
    if (limited) return limited;

    const existing = await findStep(id, doseChangeId);
    if (!existing) return apiError("Dose change not found", 404);

    await prisma.medicationDoseChange.delete({ where: { id: existing.id } });

    await auditLog("medication.glp1.doseChange.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        doseChangeId: existing.id,
        ...destroyedDetails({
          model: "MedicationDoseChange",
          id: existing.id,
          label: `${existing.doseValue} ${existing.doseUnit}`,
          effectiveAt: existing.effectiveFrom,
          extra: { clientId: existing.clientId },
        }),
      },
    });

    annotate({
      action: {
        name: "medication.glp1.doseChange.delete",
        entity_type: "medication_dose_change",
        entity_id: existing.id,
      },
      meta: { medication_id: id },
    });

    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({ id: existing.id, deleted: true });
  },
);
