import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  const sessionData = await getSession();

  if (!sessionData) {
    return apiError("Nicht angemeldet", 401);
  }

  const { user } = sessionData;
  return apiSuccess({
    id: user.id,
    username: user.username,
    heightCm: user.heightCm,
    timezone: user.timezone,
    bpSysTargetLow: user.bpSysTargetLow,
    bpSysTargetHigh: user.bpSysTargetHigh,
    bpDiaTargetLow: user.bpDiaTargetLow,
    bpDiaTargetHigh: user.bpDiaTargetHigh,
  });
}
