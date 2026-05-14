import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * v1.4.25 W14b — POST /api/onboarding/step.
 *
 * Persists the user's progress through the rebuilt
 * `/onboarding/[step]` wizard. Body: `{ step: number }` where `step`
 * is 1..4. The endpoint enforces a strict step-by-step contract:
 *
 *   - Submitted step must equal `current + 1` (no skipping ahead).
 *   - Submitting step 4 marks completion — `onboardingCompletedAt`
 *     flips from null to NOW() in the same write and the
 *     `hl_onboarding` proxy cookie is cleared.
 *   - Already-completed users (`onboardingCompletedAt != null`)
 *     receive a 409. Replays must call this endpoint only while the
 *     wizard is in-progress.
 *
 * Companion to:
 *   - `GET ` not implemented (the User row is already loaded into
 *     every server-rendered step page).
 *   - `POST /api/onboarding/complete` remains the legacy v1.4.20
 *     completion path used by the old single-file wizard; the new
 *     flow uses this endpoint with `step: 4` instead.
 *
 * Rate limit: 30 writes / 10 min / user — generous for a 4-step flow
 * but tight enough to defang a stuck retry loop.
 */

const stepBodySchema = z.object({
  step: z.number().int().min(1).max(4),
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "onboarding.step" } });

  const rl = await checkRateLimit(
    `onboarding-step:${user.id}`,
    30,
    10 * 60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many onboarding writes, try again later", 429);
  }

  const { data: body, error: jsonError } = await safeJson<unknown>(request);
  if (jsonError) return jsonError;

  const parsed = stepBodySchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "validation_failed" },
    });
    return apiError("Invalid step payload", 422);
  }
  const { step } = parsed.data;

  // Re-fetch the fresh User row so concurrent step submissions in
  // separate tabs can't race past each other — the session.user
  // snapshot might be a request-old.
  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      onboardingStep: true,
      onboardingCompletedAt: true,
    },
  });
  if (!fresh) {
    return apiError("User not found", 404);
  }

  if (fresh.onboardingCompletedAt) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "already_completed" },
    });
    return apiError("Onboarding already completed", 409);
  }

  const current = fresh.onboardingStep ?? 0;
  if (step !== current + 1) {
    annotate({
      action: { name: "onboarding.step" },
      meta: { outcome: "out_of_order", current, requested: step },
    });
    return apiError(
      `Step out of order — current step is ${current}`,
      409,
    );
  }

  const completing = step === 4;
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      onboardingStep: step,
      ...(completing ? { onboardingCompletedAt: new Date() } : {}),
    },
    select: {
      onboardingStep: true,
      onboardingCompletedAt: true,
    },
  });

  if (completing) {
    // Mirror /api/onboarding/complete — clear the proxy-readable
    // pending cookie so the next navigation drops the /onboarding
    // redirect immediately.
    await setOnboardingPendingCookie(false);
  }

  await auditLog("onboarding.step", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      step,
      completed: completing,
    },
  });

  annotate({
    action: { name: "onboarding.step" },
    meta: { outcome: completing ? "completed" : "advanced", step },
  });

  return apiSuccess({
    step: updated.onboardingStep,
    onboardingCompletedAt: updated.onboardingCompletedAt,
  });
});
