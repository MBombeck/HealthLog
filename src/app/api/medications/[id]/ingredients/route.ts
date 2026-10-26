/**
 * `PUT /api/medications/{id}/ingredients` — a supplement's composition per
 * unit (tablet, capsule).
 *
 * `{ ingredients: [{ nutrient, amount, unit }], source }` replaces the set.
 * Amounts are stored in the catalogue's canonical unit (an input unit such as
 * `IU` is kept beside it as `enteredAmount` / `enteredUnit`). The change
 * re-counts every taken dose of this medication into the day's micronutrients
 * (`recompute.queued`). Needs the `nutrients` module.
 *
 * MANAGE: a composition rewrites what every past dose of the medication adds
 * to the record's micronutrients, the kind of change the level names. C1 (the
 * rate bucket keys on the actor) and C4 (the audit row files the composition
 * it replaced).
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import {
  canonicalComposition,
  compositionSummary,
  toIngredientDtos,
} from "@/lib/medications/ingredients/composition";
import { enqueueSupplementNutrientRecompute } from "@/lib/medications/ingredients/recompute-job";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { medicationIngredientsPutSchema } from "@/lib/validations/medication-ingredients";

type RouteParams = { params: Promise<{ id: string }> };

const PUT_RATE_LIMIT = 30;
const PUT_WINDOW_MS = 60_000;

const INGREDIENT_SELECT = {
  nutrient: true,
  amountPerUnit: true,
  unit: true,
  enteredAmount: true,
  enteredUnit: true,
} as const;

export const PUT = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(putIngredients),
);

async function putIngredients(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { user, actor } = await requireRecordAuth("manage", "medications");
  const { id } = await params;
  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const medication = await prisma.medication.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      ingredients: { select: INGREDIENT_SELECT },
    },
  });
  if (!medication || medication.userId !== user.id) {
    return apiError("Medication not found", 404, {
      errorCode: "medications.notFound",
    });
  }

  // Keyed on the ACTOR, so a manager burns their own allowance.
  const rl = await checkRateLimit(
    `medication-ingredients:put:${actor.id}`,
    PUT_RATE_LIMIT,
    PUT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many requests", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const parsed = await parseJsonBody(request, medicationIngredientsPutSchema, {
    maxBytes: 16 * 1024,
    errorCode: "medications.ingredients.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const check = canonicalComposition(parsed.data.ingredients);
  if (!check.ok) {
    if (check.kind === "unknownNutrient") {
      return apiError("Unknown nutrient code", 422, {
        errorCode: "medications.ingredients.invalid",
        index: check.index,
      });
    }
    return apiError("This unit is not offered for the nutrient", 422, {
      errorCode: "medications.ingredients.unitMismatch",
      index: check.index,
      allowedUnits: check.allowedUnits,
    });
  }

  const source = parsed.data.source;
  const stored = await prisma.$transaction(async (tx) => {
    await tx.medicationIngredient.deleteMany({
      where: { medicationId: id, userId: user.id },
    });
    if (check.ingredients.length > 0) {
      await tx.medicationIngredient.createMany({
        data: check.ingredients.map((ingredient) => ({
          userId: user.id,
          medicationId: id,
          nutrient: ingredient.nutrient,
          amountPerUnit: ingredient.amountPerUnit,
          unit: ingredient.unit,
          enteredAmount: ingredient.enteredAmount,
          enteredUnit: ingredient.enteredUnit,
          source,
        })),
      });
    }
    return tx.medicationIngredient.findMany({
      where: { medicationId: id, userId: user.id },
      select: INGREDIENT_SELECT,
    });
  });

  await auditLog("medication.ingredients.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    // The composition this replaced, as one comparable line per side.
    details: {
      medicationId: id,
      source,
      count: stored.length,
      ...overwriteDetails({
        before: { composition: compositionSummary(medication.ingredients) },
        after: { composition: compositionSummary(stored) },
      }),
    },
  });

  // Every taken dose of this medication, back to the first, counts with the
  // new composition: the account's whole SUPPLEMENT history is recomputed.
  const recompute = await enqueueSupplementNutrientRecompute(user.id);
  invalidateUserMedications(user.id, { evict: true });

  annotate({
    action: {
      name: "medication.ingredients.update",
      entity_type: "medication",
      entity_id: id,
    },
    meta: {
      count: stored.length,
      source,
      recompute_queued: recompute.queued,
    },
  });

  return apiSuccess({
    ingredients: toIngredientDtos(stored, actor.locale ?? user.locale ?? null),
    recompute,
  });
}
