import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { tourProgressSchema } from "@/lib/onboarding/tour-progress";
import { Prisma } from "@/generated/prisma/client";

/**
 * v1.4.15 Phase B5 — onboarding tour completion endpoint.
 * v1.18.6 — extended with the resumable module-tour progress point.
 *
 * Operations on a single resource:
 *
 *   POST { completed: true,  outcome: "completed" | "skipped" }
 *     → flips `users.onboarding_tour_completed` to true. Auto-fires
 *       when the user reaches the end of the module tour OR explicitly
 *       dismisses it.
 *
 *   POST { completed: false }
 *     → resets the flag so the user can replay the tour from
 *       Settings → Advanced → "Modul-Tour neu starten". Also CLEARS
 *       `onboarding_tour_progress_json` back to null so the replay
 *       genuinely starts from the first module.
 *
 *   POST { progress: { lastStopId, completedStopIds, status, updatedAt } }
 *     → fire-and-forget mid-tour checkpoint so a reload resumes at the
 *       right module. May arrive WITH `completed` (the terminal
 *       checkpoint sends both) or alone (every `nextStep`).
 *
 * `outcome` is informational — it lands in the structured Wide Event
 * annotation so analytics can tell completion from dismiss without a
 * second column. Same DB write either way.
 */

const tourBodySchema = z
  .object({
    completed: z.boolean().optional(),
    outcome: z.enum(["completed", "skipped"]).optional(),
    progress: tourProgressSchema.optional(),
  })
  .refine((b) => b.completed !== undefined || b.progress !== undefined, {
    message: "Provide `completed` and/or `progress`.",
  });

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = z.safeParse(tourBodySchema, body);
  if (!parsed.success) {
    return apiError("Invalid input", 422, {
      errorCode: "onboarding.tour.invalid",
    });
  }

  // Build the update field-by-field (no mass assignment). `completed`
  // drives the coarse boolean; a replay (`completed:false`) wipes the
  // resume point; a progress checkpoint writes the JSON column.
  const data: Prisma.UserUpdateInput = {};
  if (parsed.data.completed !== undefined) {
    data.onboardingTourCompleted = parsed.data.completed;
    if (parsed.data.completed === false) {
      // Replay — start the resume point over.
      data.onboardingTourProgressJson = Prisma.JsonNull;
    }
  }
  if (parsed.data.progress !== undefined) {
    data.onboardingTourProgressJson = parsed.data.progress;
  }

  await prisma.user.update({ where: { id: user.id }, data });

  annotate({
    action: { name: "onboarding.tour.update" },
    meta: {
      completed: parsed.data.completed ?? null,
      outcome: parsed.data.outcome ?? null,
      progressStatus: parsed.data.progress?.status ?? null,
      lastStopId: parsed.data.progress?.lastStopId ?? null,
    },
  });

  return apiSuccess({
    onboardingTourCompleted:
      parsed.data.completed ?? user.onboardingTourCompleted,
    progress: parsed.data.progress ?? null,
  });
});
