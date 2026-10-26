import { prisma } from "@/lib/db";
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { phaseConfigSchema } from "@/lib/validations/phase-config";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "medications");

    const { id } = await params;
    // v1.4.25 — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const config = await prisma.reminderPhaseConfig.findUnique({
      where: { medicationId: id },
    });

    annotate({
      action: {
        name: "medication.phase_config.get",
        entity_type: "medication",
        entity_id: id,
      },
    });

    // Return config or defaults
    return apiSuccess(
      config ?? {
        greenValue: 60,
        greenMode: "MINUTES",
        yellowValue: 30,
        yellowMode: "MINUTES",
        orangeValue: 0,
        orangeMode: "MINUTES",
        redValue: 240,
        redMode: "MINUTES",
      },
    );
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.4.25 — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const parsed = await parseJsonBody(request, phaseConfigSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    // v1.5.5 — build the Prisma payload field-by-field rather
    // than spreading `parsed.data`. A future schema extension would
    // otherwise land on the upsert silently; the explicit pick keeps
    // the surface honest at the call site.
    const {
      greenValue,
      greenMode,
      yellowValue,
      yellowMode,
      orangeValue,
      orangeMode,
      redValue,
      redMode,
    } = parsed.data;
    const phaseFields = {
      greenValue,
      greenMode,
      yellowValue,
      yellowMode,
      orangeValue,
      orangeMode,
      redValue,
      redMode,
    };

    const config = await prisma.reminderPhaseConfig.upsert({
      where: { medicationId: id },
      create: { medicationId: id, ...phaseFields },
      update: phaseFields,
    });

    annotate({
      action: {
        name: "medication.phase_config.update",
        entity_type: "medication",
        entity_id: id,
      },
    });

    return apiSuccess(config);
  },
);

export const DELETE = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.4.25 — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    await prisma.reminderPhaseConfig.deleteMany({
      where: { medicationId: id },
    });

    annotate({
      action: {
        name: "medication.phase_config.reset",
        entity_type: "medication",
        entity_id: id,
      },
    });

    return apiSuccess({ reset: true });
  },
);
