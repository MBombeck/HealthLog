/**
 * GET / PATCH the caller's daily nutrient targets (#1402).
 *
 * Every target is optional and set by the person; there is no default. PATCH
 * replaces the codes the body names (`null` clears one) and keeps the rest; an
 * unknown code or an out-of-range value is refused with the multi-issue 422.
 * The targets live on their own `User` column (`nutrient_targets_json`);
 * `GET /api/nutrients/daily` and the MCP `get_nutrients` tool return the one
 * for the code they serve. Behind the opt-in `nutrients` module, like every
 * other nutrient route.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { Prisma } from "@/generated/prisma/client";
import { prisma, toJson } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { readNutrientTargets } from "@/lib/nutrients/targets";
import {
  mergeNutrientTargets,
  nutrientTargetCodes,
  nutrientTargetsPatchSchema,
} from "@/lib/validations/nutrient-targets";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const targets = await readNutrientTargets(user.id);
  annotate({
    action: { name: "nutrient.targets.read" },
    meta: { set: nutrientTargetCodes(targets) },
  });
  return apiSuccess({ targets });
});

export const PATCH = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, nutrientTargetsPatchSchema, {
    maxBytes: 8 * 1024,
    action: "nutrient.targets.validation-failed",
  });
  if (!parsed.ok) return parsed.error;

  const next = mergeNutrientTargets(
    await readNutrientTargets(user.id),
    parsed.data,
  );
  const set = nutrientTargetCodes(next);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      nutrientTargetsJson: set.length === 0 ? Prisma.DbNull : toJson(next),
    },
  });

  // Codes only, never the amounts: a target is a health figure.
  await auditLog("nutrient.targets.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { set },
  });
  annotate({
    action: { name: "nutrient.targets.update" },
    meta: { set },
  });
  return apiSuccess({ targets: next });
});
