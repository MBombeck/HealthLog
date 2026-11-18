/**
 * PATCH /api/antigravity/model
 *
 * Saves the model the user picked for Antigravity, or clears it (`null`) to
 * return to the CLI's default. The id is checked against the CLI's model list
 * when a completion runs, so a stale id fails there with a clear error.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import { antigravityModelPatchSchema } from "@/lib/validations/antigravity";

export const dynamic = "force-dynamic";

export interface AntigravityModelResponse {
  selectedModel: string | null;
}

export const PATCH = apiHandler(async (req: Request) => {
  const { user: caller } = await requireAuth();

  const parsed = await parseJsonBody(req, antigravityModelPatchSchema, {
    maxBytes: 1024,
    action: "antigravity.model.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const row = await prisma.user.findUnique({
    where: { id: caller.id },
    select: { antigravityProfileId: true },
  });
  if (!row) {
    return apiError("User not found", 404);
  }
  if (!row.antigravityProfileId) {
    return apiError("Antigravity is not set up", 409);
  }

  await prisma.user.update({
    where: { id: caller.id },
    data: { antigravityModel: parsed.data.model },
  });

  return apiSuccess<AntigravityModelResponse>({
    selectedModel: parsed.data.model,
  });
});
