import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const onboardingSchema = z.object({
  heightCm: z.number().min(50).max(300).optional(),
  dateOfBirth: z.string().optional(),
  gender: z.enum(["MALE", "FEMALE"]).optional(),
});

/**
 * Complete the onboarding flow. Saves optional profile data and marks
 * onboarding as completed.
 */
export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const body = await request.json();
  const result = z.safeParse(onboardingSchema, body);
  if (!result.success) {
    return apiError("Ungültige Eingabe", 422);
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

  await prisma.user.update({
    where: { id: sessionData.user.id },
    data,
  });

  return apiSuccess({ completed: true });
}
