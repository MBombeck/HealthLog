"use client";

// v1.28.x — Garmin is NOT a direct connector: Garmin's developer program is
// business-partner-only (approval-gated, needs public callbacks), so the
// self-hosted BYO model cannot register a paste-your-key Garmin app. The honest
// path is Apple Health (iOS) or Google Health Connect (Android), which already
// works with zero extra code. This quiet, non-connector info note pre-empts the
// recurring "where's Garmin?" question and points to the runbook.

import { ExternalLink, Watch } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { GARMIN_DOCS_HREF } from "@/components/settings/integrations/setup-guide-link";
import { useTranslations } from "@/lib/i18n/context";

export function GarminInfoNote() {
  const { t } = useTranslations();
  return (
    <SettingsCard data-testid="garmin-info">
      <SettingsCardHeader
        icon={Watch}
        title={t("settings.garminInfo.title")}
        description={
          <p className="text-muted-foreground">
            {t("settings.garminInfo.body")}{" "}
            <a
              href={GARMIN_DOCS_HREF}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="garmin-docs-link"
              data-slot="garmin-docs-link"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
            >
              {t("settings.garminInfo.docsLink")}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </p>
        }
      />
    </SettingsCard>
  );
}
