import { apiSuccess } from "@/lib/api-response";
import { getGravatarUrl } from "@/lib/gravatar";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  annotate({ action: { name: "auth.me" } });

  return apiSuccess({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role ?? "USER",
    heightCm: user.heightCm,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    timezone: user.timezone,
    onboardingCompletedAt: user.onboardingCompletedAt,
    gravatarUrl: user.email ? getGravatarUrl(user.email) : null,
    glucoseUnit: user.glucoseUnit ?? null,
  });
});
