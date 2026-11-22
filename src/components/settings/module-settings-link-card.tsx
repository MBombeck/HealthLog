"use client";

/**
 * The way from a module's arrangement page (`/settings/layout/<id>`) to its
 * own page under Modules, for the modules that have one.
 *
 * Kept apart from `module-settings-pages.tsx` so the arrangement route ships
 * the card it renders, not the labs, mood and injection-site settings that
 * module holds.
 */

import Link from "next/link";
import { ChevronRight, SlidersHorizontal } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleSettingsPageId } from "./module-settings-page-ids";

export function ModuleSettingsLinkCard({ id }: { id: ModuleSettingsPageId }) {
  const { t } = useTranslations();
  return (
    <SettingsCard data-slot="arrangement-module-settings-link">
      <SettingsCardHeader
        icon={SlidersHorizontal}
        title={t("settings.sections.modules.pages.moduleSettingsTitle")}
        description={t(
          "settings.sections.modules.pages.moduleSettingsDescription",
        )}
      />
      <SettingsCardActions align="start">
        <Button asChild variant="outline" size="sm">
          <Link href={`/settings/modules/${id}`}>
            {t("settings.sections.modules.openModuleSettings")}
            <ChevronRight className="size-4" aria-hidden="true" />
          </Link>
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
