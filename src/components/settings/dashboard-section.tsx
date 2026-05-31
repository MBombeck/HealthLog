"use client";

import { DashboardLayoutSection } from "@/components/settings/dashboard-layout-section";
import { UnitPreferenceCard } from "@/components/settings/unit-preference-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

export function DashboardSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

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

      <UnitPreferenceCard isAuthenticated={isAuthenticated} />

      <DashboardLayoutSection id="dashboard-layout" />
    </section>
  );
}
