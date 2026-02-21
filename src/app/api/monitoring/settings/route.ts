import { apiSuccess } from "@/lib/api-response";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getPublicMonitoringSettings();
  return apiSuccess({
    umamiEnabled: settings.umamiEnabled,
    umamiWebsiteId: settings.umamiWebsiteId,
    glitchtipEnabled: settings.glitchtipEnabled,
  });
}
