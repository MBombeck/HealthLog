import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { efficacyTargetOverrideSchema } from "@/lib/validations/medication-efficacy";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * PUT /api/medications/[id]/efficacy/target — set or clear the user's explicit
 * efficacy-target override for a medication. `clear:true` removes the override
 * rows so the resolver reverts to the derived (ATC / name) target; otherwise
 * exactly one of `measurementType` / `biomarkerId` pins the new target. The
 * override is the ONLY thing the "Wirkung" view persists — everything else is
 * derived each read.
 *
 * `userId` is never a body field: ownership is narrowed through the parent
 * medication (and the biomarker, when a lab target is pinned). The write
 * builds its `data` object field-by-field (no mass assignment).
 *
 * Declares `"guardian"` (#1408): the owner, or the guardian of a managed
 * profile, picks what the Effect view follows; an adult's delegate does not,
 * at any level. Both arms land in the audit log, which names the guardian
 * when one made the change.
 */
export const PUT = apiHandler(
  async (request: Request, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("guardian", "record");
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const parsed = await parseJsonBody(request, efficacyTargetOverrideSchema, {
      maxBytes: 8 * 1024,
    });
    if (!parsed.ok) return parsed.error;
    const { clear, measurementType, biomarkerId, primary } = parsed.data;

    // Clearing reverts to the derived resolution — drop every override row.
    if (clear) {
      await prisma.medicationEfficacyTarget.deleteMany({
        where: { medicationId: id },
      });
      await auditLog("medication.efficacy.target.clear", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: { medicationId: id },
      });
      annotate({
        action: {
          name: "medication.efficacy.target.clear",
          entity_type: "medication",
          entity_id: id,
        },
        meta: {},
      });
      return apiSuccess({ cleared: true });
    }

    // A lab target must reference a biomarker the caller owns.
    if (biomarkerId) {
      const biomarker = await prisma.biomarker.findFirst({
        where: { id: biomarkerId, userId: user.id },
        select: { id: true },
      });
      if (!biomarker) {
        return apiError("Biomarker not found", 404);
      }
    }

    // Replace the override with the single pinned target (field-by-field data).
    await prisma.$transaction([
      prisma.medicationEfficacyTarget.deleteMany({
        where: { medicationId: id },
      }),
      prisma.medicationEfficacyTarget.create({
        data: {
          medicationId: id,
          measurementType: measurementType ?? null,
          biomarkerId: biomarkerId ?? null,
          primary: primary ?? true,
        },
        select: { id: true },
      }),
    ]);

    await auditLog("medication.efficacy.target.set", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        kind: measurementType ? "metric" : "lab",
      },
    });

    annotate({
      action: {
        name: "medication.efficacy.target.set",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { kind: measurementType ? "metric" : "lab" },
    });

    return apiSuccess({ ok: true });
  },
);
