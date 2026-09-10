import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { onboardingCompleteSchema } from "@/lib/validations/onboarding";

/**
 * Complete the onboarding flow. Saves optional profile data and marks
 * onboarding as completed.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "onboarding.complete" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const result = z.safeParse(onboardingCompleteSchema, body);
  if (!result.success) {
    return apiValidationError(
      "Invalid input",
      sanitiseZodIssues(result.error.issues),
      422,
      {
        errorCode: "onboarding.complete.invalid",
      },
    );
  }

  const data: Record<string, unknown> = {
    onboardingCompletedAt: new Date(),
  };

  if (result.data.heightCm) {
    data.heightCm = result.data.heightCm;
  }

  if (result.data.dateOfBirth) {
    const dob = new Date(result.data.dateOfBirth);
    if (!isNaN(dob.getTime())) {
      data.dateOfBirth = dob;
    }
  }

  if (result.data.gender) {
    data.gender = result.data.gender;
  }

  if (result.data.displayName) {
    data.displayName = result.data.displayName;
  }

  await prisma.user.update({
    where: { id: user.id },
    data,
  });

  // v1.4.22 C4 — clear the proxy-readable onboarding cookie so the
  // next navigation drops the /onboarding redirect immediately.
  await setOnboardingPendingCookie(false);

  return apiSuccess({ completed: true });
});
