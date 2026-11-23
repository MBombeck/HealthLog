"use client";

import Link from "next/link";
import { Target } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { useCoachPlans } from "@/hooks/use-coach-plans";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The way to the Coach's stored plans from Settings.
 *
 * Plans are the person's own record: `/coach/plans` stays reachable and turns
 * read-only while the Coach is unavailable, but with the Coach off nothing in
 * the navigation leads there any more. This card is that way in. It renders
 * only when plans exist, so a person who never agreed a plan sees nothing.
 * Reads the same `?scope=all` slot the plans page reads, so the count and the
 * page cannot disagree.
 */
export function CoachPlansMemoryCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const query = useCoachPlans({
    filter: { scope: "all" },
    enabled: isAuthenticated,
  });
  const count = query.data?.length ?? 0;
  if (count === 0) return null;

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-coach-plans-title"
      data-testid="settings-coach-plans-card"
    >
      <SettingsCardHeader
        icon={Target}
        titleId="settings-coach-plans-title"
        title={t("settings.ai.coachPlans.title")}
        description={t("settings.ai.coachPlans.description")}
      />
      <SettingsCardActions align="start">
        <Button asChild variant="outline" size="sm">
          <Link href="/coach/plans" data-slot="settings-coach-plans-open">
            {t("settings.ai.coachPlans.open")}
          </Link>
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
