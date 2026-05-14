import { notFound } from "next/navigation";
import type { JSX } from "react";

import { AccountSection } from "@/components/settings/account-section";
import { AboutSection } from "@/components/settings/about-section";
import { AdvancedSection } from "@/components/settings/advanced-section";
import { AiSection } from "@/components/settings/ai-section";
import { ApiSection } from "@/components/settings/api-section";
import { DashboardSection } from "@/components/settings/dashboard-section";
import { ExportSection } from "@/components/settings/export-section";
import { IntegrationsSection } from "@/components/settings/integrations-section";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { SectionPlaceholder } from "@/components/settings/section-placeholder";
import { SourcesSection } from "@/components/settings/sources-section";
import { ThresholdsSection } from "@/components/settings/thresholds-section";
import {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
} from "@/components/settings/section-slugs";
import { SettingsShell } from "@/components/settings/settings-shell";

/**
 * Dynamic settings section route. Each of the eight `SETTINGS_SECTION_SLUGS`
 * is pre-rendered at build via `generateStaticParams()` so the URLs are
 * statically known to Next.js, while the `dynamicParams = false` flag below
 * tells the router to 404 (instead of attempting on-demand rendering) for any
 * slug not in the list — which is exactly what `notFound()` would do at
 * request time, just earlier and without rendering.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return SETTINGS_SECTION_SLUGS.map((section) => ({ section }));
}

const SECTION_COMPONENTS: Record<
  SettingsSectionSlug,
  () => JSX.Element | null
> = {
  account: AccountSection,
  about: AboutSection,
  ai: AiSection,
  integrations: IntegrationsSection,
  notifications: NotificationsSection,
  dashboard: DashboardSection,
  thresholds: ThresholdsSection,
  sources: SourcesSection,
  api: ApiSection,
  export: ExportSection,
  advanced: AdvancedSection,
};

interface PageProps {
  // Next.js 16 made route `params` an async Promise. We `await` it before use.
  params: Promise<{ section: string }>;
}

export default async function SettingsSectionPage({ params }: PageProps) {
  const { section } = await params;

  // Defence-in-depth — `dynamicParams = false` already 404s unknown slugs at
  // routing time, but we re-check here so a hand-rolled override of the route
  // config can never silently fall through to a typo'd slug.
  if (!isSettingsSectionSlug(section)) {
    notFound();
  }

  const SectionComponent = SECTION_COMPONENTS[section];
  // Defensive fallback: in theory unreachable since `isSettingsSectionSlug`
  // guards the slug, but a future slug added to `SETTINGS_SECTION_SLUGS`
  // without a wired component would otherwise crash silently — placeholder
  // surfaces the gap visually instead.
  const body = SectionComponent ? (
    <SectionComponent />
  ) : (
    <SectionPlaceholder slug={section} />
  );

  return <SettingsShell active={section}>{body}</SettingsShell>;
}
