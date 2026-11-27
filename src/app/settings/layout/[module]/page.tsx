import { notFound } from "next/navigation";

import { LayoutModuleGate } from "@/components/settings/layout-module-gate";
import { RecordSettingsSectionGate } from "@/components/settings/record-settings-section-gate";
import {
  LAYOUT_GROUPS,
  layoutGroupModule,
  LAYOUT_GROUP_IDS,
  isLayoutGroupId,
} from "@/components/settings/layout-groups";
import { SettingsShell } from "@/components/settings/settings-shell";
import { ModuleSettingsLinkCard } from "@/components/settings/module-settings-link-card";
import { isModuleSettingsPageId } from "@/components/settings/module-settings-page-ids";
import { SettingsHubBackLink } from "@/components/settings/settings-hub-back-link";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";

/**
 * v1.25.11 (#148) — per-module Appearance subpage.
 *
 * `/settings/layout/<module>` renders ONLY that module's section (the existing
 * `*Section` component, verbatim) under the Appearance hub, with a
 * "← Appearance" back-link. The hub at `/settings/layout` lists the modules and
 * links here; the legacy `/settings/<module>` routes 301-redirect here
 * (next.config.ts).
 *
 * Each subpage is pre-rendered for the known module ids via
 * `generateStaticParams()`; `dynamicParams = false` 404s any other segment at
 * routing time (re-checked with `notFound()` for defence-in-depth). The slug
 * list is imported from the SERVER-safe `layout-groups` module so this server
 * component never pulls runtime values across a client boundary.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return LAYOUT_GROUP_IDS.map((module) => ({ module }));
}

interface PageProps {
  // Next.js 16 made route `params` an async Promise. We `await` it before use.
  params: Promise<{ module: string }>;
}

export default async function SettingsLayoutModulePage({ params }: PageProps) {
  const { module } = await params;

  if (!isLayoutGroupId(module)) {
    notFound();
  }

  const group = LAYOUT_GROUPS.find((entry) => entry.id === module);
  if (!group) {
    notFound();
  }

  // Heading lives in the shell (its own grid row spanning only the content
  // column). The title is the MODULE's title, resolved server-side from the
  // cookie locale (mirroring the onboarding pages) so the shell receives a
  // ready string — no client re-translation, so server HTML and the hydration
  // render carry the identical heading text.
  const locale = await resolveServerLocale();
  const { t } = getServerTranslator(locale);
  const Body = group.Body;
  const headingId = `settings-section-${module}-title`;

  return (
    <SettingsShell
      active="layout"
      heading={{
        title: t(group.titleKey),
        headingId,
        // The way back to the hub. `SettingsHubBackLink` and its string have
        // existed since the sub-pages were split out, but the only thing that
        // mounted them was the shell's slug FALLBACK — and these pages pass an
        // explicit `heading`, so the fallback never ran and no child route
        // ever painted a back link. Both ends existed; nothing connected them.
        topSlot: (
          <SettingsHubBackLink
            href="/settings/layout"
            labelKey="settings.sections.layout.backToHub"
          />
        ),
      }}
    >
      <RecordSettingsSectionGate section="layout">
        <section aria-labelledby={headingId} className="space-y-6">
          <LayoutModuleGate moduleKey={layoutGroupModule(group.id)}>
            <Body />
            {/* v1.44 — what the module needs beyond order and view lives
                on its page under Modules; say where. */}
            {isModuleSettingsPageId(group.id) ? (
              <ModuleSettingsLinkCard id={group.id} />
            ) : null}
          </LayoutModuleGate>
        </section>
      </RecordSettingsSectionGate>
    </SettingsShell>
  );
}
