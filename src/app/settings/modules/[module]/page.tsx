import { notFound } from "next/navigation";

import { LayoutModuleGate } from "@/components/settings/layout-module-gate";
import { RecordSettingsSectionGate } from "@/components/settings/record-settings-section-gate";
import { ModuleSettingsPageBody } from "@/components/settings/module-settings-pages";
import {
  MODULE_SETTINGS_PAGE_IDS,
  isModuleSettingsPageId,
  moduleSettingsPageKeys,
  moduleSettingsPageModule,
} from "@/components/settings/module-settings-page-ids";
import { SettingsShell } from "@/components/settings/settings-shell";
import { SettingsHubBackLink } from "@/components/settings/settings-hub-back-link";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";

/**
 * A module's own settings: `/settings/modules/<id>`.
 *
 * What a module needs beyond order and view (the labs biomarker catalog and
 * on-device text recognition, the mood tags, the injection sites) lives here,
 * under Settings > Modules, with a back link to the Modules list. Pre-rendered
 * for the known ids; any other segment 404s at routing time.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return MODULE_SETTINGS_PAGE_IDS.map((module) => ({ module }));
}

interface PageProps {
  params: Promise<{ module: string }>;
}

export default async function SettingsModulePage({ params }: PageProps) {
  const { module } = await params;
  if (!isModuleSettingsPageId(module)) notFound();

  const locale = await resolveServerLocale();
  const { t } = getServerTranslator(locale);
  const { titleKey } = moduleSettingsPageKeys(module);
  const headingId = `settings-section-modules-${module}-title`;

  return (
    <SettingsShell
      active="modules"
      heading={{
        title: t(titleKey),
        headingId,
        topSlot: (
          <SettingsHubBackLink
            href="/settings/modules"
            labelKey="settings.sections.modules.backToHub"
          />
        ),
      }}
    >
      {/* The cards here lived under Arrangement until v1.44 and keep its
          posture inside somebody else's record, so the gate is asked about
          `layout`, not about the Modules switches. */}
      <RecordSettingsSectionGate section="layout">
        <section aria-labelledby={headingId} className="space-y-6">
          <LayoutModuleGate moduleKey={moduleSettingsPageModule(module)}>
            <ModuleSettingsPageBody id={module} />
          </LayoutModuleGate>
        </section>
      </RecordSettingsSectionGate>
    </SettingsShell>
  );
}
