import { UmamiScript } from "@/components/monitoring/umami-script";
import { GlitchtipReporter } from "@/components/monitoring/glitchtip-reporter";
import type { PublicMonitoringSettings } from "@/lib/monitoring-settings";

/**
 * Mounts the operator's analytics script and error reporter. The root layout
 * reads the instance-wide switches on the server and passes them in, so no
 * page load asks for three values the document render already has. `null`
 * (the key-mismatch page) mounts nothing.
 */
export function MonitoringBootstrap({
  settings,
}: {
  settings: Pick<
    PublicMonitoringSettings,
    "umamiEnabled" | "umamiWebsiteId" | "glitchtipEnabled"
  > | null;
}) {
  if (!settings) return null;

  return (
    <>
      <UmamiScript
        enabled={settings.umamiEnabled}
        websiteId={settings.umamiWebsiteId}
      />
      <GlitchtipReporter enabled={settings.glitchtipEnabled} />
    </>
  );
}
