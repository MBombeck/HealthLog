"use client";

/**
 * Settings → Appearance → Documents.
 *
 * Reached from the wrench beside the vault's Upload button, the way the
 * illness journal's wrench reaches its own page. Two choices, each in its own
 * card with the toggle in the header's status slot (the illness page's
 * shape): the card/list view and the month arrangement. Both persist per user
 * through `/api/documents/inbound/layout`.
 */
import { Eye, Rows3, WrapText } from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { ModuleViewToggle } from "@/components/module-list/module-view-toggle";
import { ViewToggle } from "@/components/ui/view-toggle";
import { useTranslations } from "@/lib/i18n/context";
import { useDocumentsLayout } from "@/lib/queries/use-documents-layout";

export function DocumentsSection() {
  const { t } = useTranslations();
  const { layout, setView, setArrangement } = useDocumentsLayout();

  return (
    <div className="space-y-6" data-slot="documents-layout-settings">
      <SettingsCard id="documents-view" className="scroll-mt-28">
        <SettingsCardHeader
          icon={Eye}
          title={t("moduleList.viewHeading")}
          description={t("documents.layout.viewDescription")}
          status={<ModuleViewToggle view={layout.view} onChange={setView} />}
        />
      </SettingsCard>

      <SettingsCard id="documents-arrangement" className="scroll-mt-28">
        <SettingsCardHeader
          icon={Rows3}
          title={t("documents.layout.arrangementHeading")}
          description={t("documents.layout.arrangementDescription")}
          status={
            <ViewToggle
              view={layout.arrangement}
              onChange={setArrangement}
              groupLabel={t("documents.layout.arrangementHeading")}
              dataSlotPrefix="documents-arrangement"
              segments={[
                {
                  value: "stacked",
                  label: t("documents.layout.stacked"),
                  icon: Rows3,
                },
                {
                  value: "flow",
                  label: t("documents.layout.flow"),
                  icon: WrapText,
                },
              ]}
            />
          }
        />
      </SettingsCard>
    </div>
  );
}
