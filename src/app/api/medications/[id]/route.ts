import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { updateMedicationSchema } from "@/lib/validations/medication";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { readMedication } from "@/lib/medications/read-medication";
import { findMedicationForEdit } from "@/lib/medications/update-medication/preflight";
import { updateMedication } from "@/lib/medications/update-medication/update-medication";
import {
  deleteMedication,
  findMedicationForDelete,
} from "@/lib/medications/delete-medication";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("read", "medications");

    const { id } = await params;
    const body = await readMedication({ user, grantId, id });
    if (!body) {
      return apiError("Medication not found", 404);
    }

    return apiSuccess(body);
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // MANAGE, and the strongest candidate in the domain: a manager
    // administering somebody's regimen is the case the level exists for. What
    // it destroys is scheduling anchors, not history — the tombstone `where`
    // excludes every actioned row — and the previous cadence is the one
    // genuinely unrecoverable part, which is what C7 puts in the audit row.
    // The DELETE beside it stays refused.
    const { user, authMethod, grantId } = await requireRecordAuth(
      "manage",
      "medications",
    );

    const { id } = await params;
    // Route ownership check through the shared helper so the 404 leak shape
    // stays identical across every `[id]/**` handler. The edit still needs
    // `existing.active` for the pausedAt derivation, so it re-reads the
    // narrow pre-image after the guard passes.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;
    const existing = await findMedicationForEdit(id);
    if (!existing) {
      return apiError("Medication not found", 404);
    }

    const parsed = await parseJsonBody(request, updateMedicationSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const outcome = await updateMedication({
      user,
      grantId,
      authMethod,
      id,
      existing,
      data: parsed.data,
      ipAddress: getClientIp(request),
    });
    if (!outcome.ok) {
      return apiError(outcome.message, outcome.status, outcome.meta);
    }

    return apiSuccess(outcome.body);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // Ownership via the shared helper. The delete needs the medication name
    // for the audit-row detail; it is read after the guard passes.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;
    const existing = await findMedicationForDelete(id);
    if (!existing) {
      return apiError("Medication not found", 404);
    }

    await deleteMedication({
      userId: user.id,
      id,
      existing,
      ipAddress: getClientIp(request),
    });

    return apiSuccess({ deleted: true });
  },
);
