import { getSession } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getReminderThresholds } from "@/lib/app-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  const thresholds = await getReminderThresholds();
  return apiSuccess(thresholds);
}
