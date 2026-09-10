/**
 * v1.39 (C1) — `POST /api/onboarding/restart`.
 *
 * "Set up again", from Settings. It puts the nine steps back to `pending`,
 * clears the flow's completion stamp and clears the derivation marker so the
 * next confirm may derive a module map again.
 *
 * What it deliberately does NOT do:
 *
 *   - touch a single module. The design spec's ordering-versus-removal
 *     decision says a restart never turns off a module the person turned on by
 *     hand, and the safest way to hold that is for this route to write no
 *     module state at all. The protection against the SECOND confirm is
 *     elsewhere, in `mergeDerivedModulePreferences`.
 *   - clear the answers. They come back as the prefill for the re-run, which
 *     is what "never re-ask a value the account holds" means here.
 *   - clear `User.onboardingCompletedAt`. That column gates the first-run
 *     redirect in `src/proxy.ts`; clearing it would drop the person back into
 *     the wizard of today rather than into the questions they asked for.
 *   - forget a first result that really happened. The task produced a reading,
 *     a medication or a connection; a re-run of the questions does not unmake
 *     it.
 *
 * `requireAuth()` for the reason the answers route gives: the caller's own
 * record, refused outright under an acting-account switch.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma, toJson } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { defaultOnboardingSteps } from "@/lib/onboarding/needs";
import {
  ONBOARDING_RECORD_SELECT,
  toOnboardingStateDto,
} from "@/lib/onboarding/needs-store";
import { checkRateLimit } from "@/lib/rate-limit";
import { onboardingRestartSchema } from "@/lib/validations/onboarding-needs";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "onboarding.needs.restart" } });

  const rl = await checkRateLimit(
    `onboarding-restart:${user.id}`,
    10,
    10 * 60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "onboarding.needs.restart" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many onboarding writes, try again later", 429, {
      errorCode: "onboarding.restart.rateLimited",
    });
  }

  const { data: body, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = onboardingRestartSchema.safeParse(body ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "onboarding.needs.restart" },
      meta: { outcome: "validation_failed" },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "onboarding.restart.invalid",
    });
  }

  const steps = defaultOnboardingSteps();
  const written = await prisma.onboardingRecord.upsert({
    where: { userId: user.id },
    create: { userId: user.id, stepsJson: toJson(steps) },
    update: {
      stepsJson: toJson(steps),
      completedAt: null,
      modulesDerivedAt: null,
    },
    select: ONBOARDING_RECORD_SELECT,
  });

  await auditLog("onboarding.restart", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { steps: steps.length },
  });

  annotate({
    action: { name: "onboarding.needs.restart" },
    meta: { outcome: "reset" },
  });

  return apiSuccess({ onboarding: toOnboardingStateDto(written) });
});
