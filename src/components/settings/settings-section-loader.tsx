"use client";

import dynamic from "next/dynamic";
import { useEffect, type ComponentType } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCard } from "@/components/settings/settings-card";
import type { SettingsSectionSlug } from "@/components/settings/section-slugs";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";

/**
 * One settings section, loaded on its own.
 *
 * The section route renders exactly one of twenty-one sections, but importing
 * them statically put all twenty-one (and everything under them: the import
 * panel, the integration cards, the MCP and API token tables, the score
 * editor) into the route's entry bundle, so opening "About" downloaded the
 * whole settings tree. Each section is now its own chunk. A first load still
 * renders the section on the server (`ssr` stays on), so nothing jumps; the
 * placeholder below only shows while a client-side switch between sections
 * fetches the next chunk.
 */

/** Props a section takes. Only Integrations takes any. */
interface SectionProps {
  callbackUrls?: IntegrationCallbackUrls;
}

function SectionLoading() {
  // The settings card shell itself, so the section does not move when the
  // real cards arrive (UI standards §13: a loading state paints the card).
  return (
    <div className="space-y-6" data-slot="settings-section-loading">
      <SettingsCard data-slot="settings-section-loading-card">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-9 w-full" />
      </SettingsCard>
      <SettingsCard data-slot="settings-section-loading-card">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-full max-w-sm" />
      </SettingsCard>
    </div>
  );
}

/**
 * One import per section, shared by the lazy component below and by the
 * preload. One call site per file keeps the bundler to one chunk per section;
 * a second `import()` of the same file elsewhere emitted a second copy.
 */
const LOADERS: Record<
  SettingsSectionSlug,
  () => Promise<ComponentType<SectionProps>>
> = {
  account: () =>
    import("@/components/settings/account-section").then(
      (m) => m.AccountSection,
    ),
  access: () =>
    import("@/components/settings/access-section").then((m) => m.AccessSection),
  security: () =>
    import("@/components/settings/security-section").then(
      (m) => m.SecuritySection,
    ),
  modules: () =>
    import("@/components/settings/modules-section").then(
      (m) => m.ModulesSection,
    ),
  about: () =>
    import("@/components/settings/about-section").then((m) => m.AboutSection),
  ai: () => import("@/components/settings/ai-section").then((m) => m.AiSection),
  coach: () =>
    import("@/components/settings/coach-section").then((m) => m.CoachSection),
  integrations: () =>
    import("@/components/settings/integrations-section").then(
      (m) =>
        function IntegrationsWithUrls({ callbackUrls }: SectionProps) {
          // The route always passes the server-resolved URLs; the guard
          // keeps the section's own prop contract required.
          if (!callbackUrls) return null;
          return <m.IntegrationsSection callbackUrls={callbackUrls} />;
        },
    ),
  sources: () =>
    import("@/components/settings/sources-section").then(
      (m) => m.SourcesSection,
    ),
  notifications: () =>
    import("@/components/settings/notifications-section").then(
      (m) => m.NotificationsSection,
    ),
  layout: () =>
    import("@/components/settings/layout-section").then((m) => m.LayoutSection),
  environment: () =>
    import("@/components/settings/environment-section").then(
      (m) => m.EnvironmentSection,
    ),
  anamnesis: () =>
    import("@/components/settings/anamnesis-section").then(
      (m) => m.AnamnesisSection,
    ),
  score: () =>
    import("@/components/settings/score-section").then((m) => m.ScoreSection),
  thresholds: () =>
    import("@/components/settings/thresholds-section").then(
      (m) => m.ThresholdsSection,
    ),
  api: () =>
    import("@/components/settings/api-section").then((m) => m.ApiSection),
  mcp: () =>
    import("@/components/settings/mcp-section").then((m) => m.McpSection),
  gesundheitsakte: () =>
    import("@/components/settings/gesundheitsakte-section").then(
      (m) => m.GesundheitsakteSection,
    ),
  export: () =>
    import("@/components/settings/export-section").then((m) => m.ExportSection),
  advanced: () =>
    import("@/components/settings/advanced-section").then(
      (m) => m.AdvancedSection,
    ),
  privacy: () =>
    import("@/components/settings/privacy-section").then(
      (m) => m.PrivacySection,
    ),
};

const SECTIONS: Record<SettingsSectionSlug, ComponentType<SectionProps>> = {
  account: dynamic(LOADERS.account, { loading: () => <SectionLoading /> }),
  access: dynamic(LOADERS.access, { loading: () => <SectionLoading /> }),
  security: dynamic(LOADERS.security, { loading: () => <SectionLoading /> }),
  modules: dynamic(LOADERS.modules, { loading: () => <SectionLoading /> }),
  about: dynamic(LOADERS.about, { loading: () => <SectionLoading /> }),
  ai: dynamic(LOADERS.ai, { loading: () => <SectionLoading /> }),
  coach: dynamic(LOADERS.coach, { loading: () => <SectionLoading /> }),
  integrations: dynamic(LOADERS.integrations, {
    loading: () => <SectionLoading />,
  }),
  sources: dynamic(LOADERS.sources, { loading: () => <SectionLoading /> }),
  notifications: dynamic(LOADERS.notifications, {
    loading: () => <SectionLoading />,
  }),
  layout: dynamic(LOADERS.layout, { loading: () => <SectionLoading /> }),
  environment: dynamic(LOADERS.environment, {
    loading: () => <SectionLoading />,
  }),
  anamnesis: dynamic(LOADERS.anamnesis, { loading: () => <SectionLoading /> }),
  score: dynamic(LOADERS.score, { loading: () => <SectionLoading /> }),
  thresholds: dynamic(LOADERS.thresholds, {
    loading: () => <SectionLoading />,
  }),
  api: dynamic(LOADERS.api, { loading: () => <SectionLoading /> }),
  mcp: dynamic(LOADERS.mcp, { loading: () => <SectionLoading /> }),
  gesundheitsakte: dynamic(LOADERS.gesundheitsakte, {
    loading: () => <SectionLoading />,
  }),
  export: dynamic(LOADERS.export, { loading: () => <SectionLoading /> }),
  advanced: dynamic(LOADERS.advanced, { loading: () => <SectionLoading /> }),
  privacy: dynamic(LOADERS.privacy, { loading: () => <SectionLoading /> }),
};

/**
 * The section mounts only once the record gate has the account
 * (`RecordSettingsSectionGate`), so without a head start its chunk would be
 * fetched after that and the reader would see two loading states in a row.
 * This starts the fetch at hydration, beside the gate's own read; the module
 * cache makes the later lazy render of the same file free.
 */
export function SettingsSectionPreload({
  section,
}: {
  section: SettingsSectionSlug;
}) {
  useEffect(() => {
    void LOADERS[section]().catch(() => {
      // The section's own lazy import retries and reports; a failed head
      // start changes nothing.
    });
  }, [section]);
  return null;
}

export function SettingsSectionLoader({
  section,
  callbackUrls,
}: {
  section: SettingsSectionSlug;
  callbackUrls?: IntegrationCallbackUrls;
}) {
  const Section = SECTIONS[section];
  return <Section callbackUrls={callbackUrls} />;
}
