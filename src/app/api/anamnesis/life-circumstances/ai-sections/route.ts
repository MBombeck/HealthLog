/**
 * `PATCH /api/anamnesis/life-circumstances/ai-sections` — switch which
 * life-circumstance sections may reach the AI (#614).
 *
 * `{ sections: { <SECTION>: boolean }, baseUpdatedAt? }` with at least one
 * key, over `SMOKING_STATUS`, `ALCOHOL_PATTERN`, `SHIFT_SCHEDULE`, `ACTIVITY`,
 * `WORK`, `HABITS`, `GOALS`. Sections not named keep their state. A stale
 * `baseUpdatedAt` is 409 `about_me_conflict`, the token `about-me` uses.
 * Own account only: which of a person's answers a model may read is that
 * person's decision.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { updateLifeAiSections } from "@/lib/profile/life-circumstances";
import { lifeAiSectionsPatchSchema } from "@/lib/validations/life-circumstances";

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = await parseJsonBody(request, lifeAiSectionsPatchSchema, {
    maxBytes: 4 * 1024,
    errorCode: "anamnesis.lifeSections.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const outcome = await updateLifeAiSections(
    user.id,
    parsed.data.sections,
    parsed.data.baseUpdatedAt ? new Date(parsed.data.baseUpdatedAt) : undefined,
  );
  if (outcome.conflict) {
    annotate({ action: { name: "anamnesis.life_sections.conflict" } });
    return apiError("Self-context changed since it was loaded", 409, {
      errorCode: "about_me_conflict",
    });
  }

  // Section names and switch states only; nothing about the answers.
  await auditLog("anamnesis.life_sections.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { sections: parsed.data.sections },
  });
  annotate({
    action: { name: "anamnesis.life_sections.update" },
    meta: { changed: Object.keys(parsed.data.sections).length },
  });
  return apiSuccess({
    aiSections: outcome.aiSections,
    updatedAt: outcome.updatedAt,
  });
});
