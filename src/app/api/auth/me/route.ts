import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessionData = await getSession();

    if (!sessionData) {
      return apiError("Nicht angemeldet", 401);
    }

    const { user } = sessionData;
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
    });
  } catch (err) {
    console.error("Auth me error:", err);
    return apiError("Sitzungsfehler", 500);
  }
}
