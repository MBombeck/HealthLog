"use client";

import { DashboardLayoutSection } from "@/components/settings/dashboard-layout-section";
import { ThresholdsSection } from "@/components/settings/thresholds-section";
import { useTranslations } from "@/lib/i18n/context";

export function DashboardSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-dashboard-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-dashboard-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.dashboard.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.dashboard.description")}
        </p>
      </header>

      <DashboardLayoutSection id="dashboard-layout" />
      <ThresholdsSection id="thresholds" />
    </section>
  );
}
