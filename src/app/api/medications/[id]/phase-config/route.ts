import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { phaseConfigSchema } from "@/lib/validations/phase-config";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
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
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = phaseConfigSchema.safeParse(body);
    if (!parsed.success) {
      // v1.5.5 F-1 H-3 — every v1.5.5 route returns the multi-issue
      // 422 envelope so iOS sees per-field feedback the same way the
      // bulk-delete and intake routes already do. The old `400 Invalid
      // input` flat response was the last hold-out in the surface.
      return returnAllZodIssues(parsed.error, 422);
    }

    // v1.5.5 F-1 H-4 — build the Prisma payload field-by-field rather
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
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
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
