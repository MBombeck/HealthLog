import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { syncUserMeasurements } from "@/lib/withings/sync";

/**
 * Manually trigger a Withings sync for the current user.
 */
export async function POST() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    const imported = await syncUserMeasurements(sessionData.user.id);
    return apiSuccess({ imported });
  } catch (err) {
    console.error("[withings] Manual sync error:", err);
    return apiError("Sync fehlgeschlagen", 500);
  }
}
