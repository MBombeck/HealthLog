"use client";

/**
 * The pages a module's own settings live on: `/settings/modules/<id>`.
 *
 * Settings > Arrangement holds order and view only. What a module needs
 * beyond that (the biomarker catalog and on-device text recognition for
 * labs, the mood tags, the medicine registry the leaflet search opens and the
 * injection sites a medication rotation leaves out)
 * lives on the module's page under Modules, reached from the module's row in
 * Settings > Modules and from the wrench on the module's own page. Each page
 * links to the module's arrangement page and back.
 *
 * Every page is gated on its module through the surface map
 * (`settings-module:<id>`), fail-open like the rest of Settings.
 */

import Link from "next/link";
import { ArrowUpDown, ChevronRight } from "lucide-react";

import { LabsModuleSettings } from "@/components/labs/labs-settings";
import { InjectionSitesCard } from "@/components/settings/injection-sites-card";
import { MedicineRegistryCard } from "@/components/settings/medicine-registry-card";
import { MoodSection } from "@/components/settings/mood-section";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleSettingsPageId } from "./module-settings-page-ids";

/** A card pointing at the module's order-and-view page under Arrangement. */
function ArrangementLinkCard({ id }: { id: ModuleSettingsPageId }) {
  const { t } = useTranslations();
  return (
    <SettingsCard data-slot="module-settings-arrangement-link">
      <SettingsCardHeader
        icon={ArrowUpDown}
        title={t("settings.sections.modules.pages.arrangementTitle")}
        description={t(
          "settings.sections.modules.pages.arrangementDescription",
        )}
      />
      <SettingsCardActions align="start">
        <Button asChild variant="outline" size="sm">
          <Link href={`/settings/layout/${id}`}>
            {t("settings.sections.modules.pages.openArrangement")}
            <ChevronRight className="size-4" aria-hidden="true" />
          </Link>
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}

function MedicationsModulePage() {
  const { isAuthenticated } = useAuth();
  return (
    <div className="space-y-6">
      {/* #1430 — where "Find leaflet" searches; independent of language. */}
      <MedicineRegistryCard isAuthenticated={isAuthenticated} />
      <InjectionSitesCard isAuthenticated={isAuthenticated} />
      <ArrangementLinkCard id="medications" />
    </div>
  );
}

function LabsModulePage() {
  return (
    <div className="space-y-6">
      <LabsModuleSettings />
      <ArrangementLinkCard id="labs" />
    </div>
  );
}

function MoodModulePage() {
  return <MoodSection />;
}

export const MODULE_SETTINGS_PAGE_BODIES: Record<
  ModuleSettingsPageId,
  () => React.JSX.Element
> = {
  medications: MedicationsModulePage,
  mood: MoodModulePage,
  labs: LabsModulePage,
};

export function ModuleSettingsPageBody({ id }: { id: ModuleSettingsPageId }) {
  const Body = MODULE_SETTINGS_PAGE_BODIES[id];
  return <Body />;
}
