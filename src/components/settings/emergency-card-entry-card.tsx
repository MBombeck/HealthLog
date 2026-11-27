"use client";

/**
 * Settings > Health record: the way to the emergency card, beside the other
 * ways the record leaves the app (the report, the clinician links, the care
 * calendar). The card is a page of its own (`/emergency-card`, also in the
 * account menu); this row is here because its QR link is one more door out of
 * the record, and that is where people look for those.
 */
import Link from "next/link";
import { HeartPulse } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

export function EmergencyCardEntryCard() {
  const { t } = useTranslations();
  return (
    <SettingsCard data-slot="emergency-card-entry-card">
      <SettingsCardHeader
        anchor="emergency-card"
        icon={HeartPulse}
        title={t("nav.emergencyCard")}
        description={t("emergencyCard.entry.description")}
      />
      <SettingsCardActions>
        <Button asChild variant="outline" size="sm">
          <Link href="/emergency-card">{t("records.emergency.cardLink")}</Link>
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
