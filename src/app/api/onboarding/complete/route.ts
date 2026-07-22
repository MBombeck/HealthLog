import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const onboardingSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  heightCm: z.number().min(50).max(300).optional(),
  dateOfBirth: z.string().optional(),
  gender: z.enum(["MALE", "FEMALE"]).optional(),
});

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
  const result = z.safeParse(onboardingSchema, body);
  if (!result.success) {
    return apiError("Invalid input", 422, {
      errorCode: "onboarding.complete.invalid",
    });
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
