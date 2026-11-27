import type { ModuleKey } from "@/lib/modules/registry";
import { surfaceModule } from "@/lib/modules/surface";

/**
 * Server-safe ids and copy keys of the module pages under Settings > Modules
 * (`/settings/modules/<id>`). The route reads them in
 * `generateStaticParams()`, so they live apart from the client bodies in
 * `module-settings-pages.tsx`.
 */
export const MODULE_SETTINGS_PAGE_IDS = [
  "medications",
  "mood",
  "labs",
] as const;

export type ModuleSettingsPageId = (typeof MODULE_SETTINGS_PAGE_IDS)[number];

export function isModuleSettingsPageId(
  value: string,
): value is ModuleSettingsPageId {
  return (MODULE_SETTINGS_PAGE_IDS as readonly string[]).includes(value);
}

/** i18n keys of a page's heading, under `settings.sections.modules.pages`. */
export function moduleSettingsPageKeys(id: ModuleSettingsPageId): {
  titleKey: string;
} {
  return { titleKey: `settings.sections.modules.pages.${id}.title` };
}

/** The module a page belongs to, from the surface map. */
export function moduleSettingsPageModule(
  id: ModuleSettingsPageId,
): ModuleKey | undefined {
  return surfaceModule(`settings-module:${id}`);
}
