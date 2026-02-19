import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { NextRequest } from "next/server";

/**
 * Manually trigger a Withings sync for the current user.
 */
export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    let fullSync = false;
    try {
      const body = await request.json();
      fullSync = body?.fullSync === true;
    } catch {
      // no body provided -> default incremental sync
    }

    const imported = await syncUserMeasurements(sessionData.user.id, {
      fullSync,
    });
    return apiSuccess({ imported, fullSync });
  } catch (err) {
    console.error("[withings] Manual sync error:", err);
    return apiError("Sync fehlgeschlagen", 500);
  }
}
