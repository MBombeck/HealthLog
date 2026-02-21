"use client";

import { useEffect, useState } from "react";
import { UmamiScript } from "@/components/monitoring/umami-script";
import { GlitchtipReporter } from "@/components/monitoring/glitchtip-reporter";

interface MonitoringSettings {
  umamiEnabled: boolean;
  umamiWebsiteId: string | null;
  glitchtipEnabled: boolean;
}

export function MonitoringBootstrap() {
  const [settings, setSettings] = useState<MonitoringSettings | null>(null);

  useEffect(() => {
    let active = true;

    fetch("/api/monitoring/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (!active || !json?.data) return;
        setSettings(json.data as MonitoringSettings);
      })
      .catch(() => {
        if (!active) return;
        setSettings({
          umamiEnabled: false,
          umamiWebsiteId: null,
          glitchtipEnabled: false,
        });
      });

    return () => {
      active = false;
    };
  }, []);

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
