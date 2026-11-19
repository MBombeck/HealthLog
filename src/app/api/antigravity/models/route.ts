/**
 * GET /api/antigravity/models
 *
 * Lists the models the user's Antigravity profile offers. The list comes from
 * the CLI at request time (the model selector in the session's configOptions),
 * so HealthLog keeps no static model list.
 *
 * The response always includes the model the user picked (`selectedModel`).
 * When the list is empty, `reason` says why.
 */
import { apiHandler, HttpError, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  antigravityProfileLocation,
  antigravityReasonOf,
  probeAntigravity,
  type AntigravityModel,
  type AntigravityFailureReason,
} from "@/lib/ai/antigravity-client";

export const dynamic = "force-dynamic";

export type AntigravityModelsReason =
  AntigravityFailureReason | "not_set_up" | "profile_missing" | "no_models";

export interface AntigravityModelsResponse {
  models: AntigravityModel[];
  /** The model the user picked, or null for the CLI's default. */
  selectedModel: string | null;
  /** Why `models` is empty. Null when the CLI offered models. */
  reason: AntigravityModelsReason | null;
  /** The advertised thought levels the CLI offers, or null when none. */
  thoughtLevels?: string[] | null;
}

export const GET = apiHandler(async () => {
  const { user: caller } = await requireAuth();

  // Listing the models starts the CLI, so it is limited like the connection test.
  const rl = await checkRateLimit(
    `antigravity-models:${caller.id}`,
    30,
    60_000,
  );
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const row = await prisma.user.findUnique({
    where: { id: caller.id },
    select: { antigravityProfileId: true, antigravityModel: true },
  });
  if (!row) {
    return apiError("User not found", 404);
  }

  const selectedModel = row.antigravityModel;
  const empty = (reason: AntigravityModelsReason) =>
    apiSuccess<AntigravityModelsResponse>({
      models: [],
      selectedModel,
      reason,
    });

  if (!row.antigravityProfileId) return empty("not_set_up");

  const profile = antigravityProfileLocation(row.antigravityProfileId);
  if (!profile) return empty("profile_missing");

  try {
    const { modelOptions, thoughtLevelOptions } = await probeAntigravity(
      profile,
      selectedModel,
    );
    if (!modelOptions || modelOptions.models.length === 0) {
      return empty("no_models");
    }
    return apiSuccess<AntigravityModelsResponse>({
      models: modelOptions.models,
      selectedModel,
      reason: null,
      thoughtLevels: thoughtLevelOptions?.choices ?? null,
    });
  } catch (error) {
    return empty(antigravityReasonOf(error));
  }
});
