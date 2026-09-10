"use client";

/**
 * Client-only renderer that picks the right admin section component for
 * a given slug. Lives next to the route page so the shell can stay a
 * server component while the auth-gated body remains a client component.
 *
 * This is the equivalent of `SECTION_COMPONENTS` in
 * `src/app/settings/[section]/page.tsx`, lifted to a separate file so
 * the route page can be a server component (Settings can keep
 * `"use client"`-leaning components in its page because none of them
 * read `useAuth()` to gate rendering).
 */

import type { JSX } from "react";

import { useAuth } from "@/hooks/use-auth";
import { AboutSection } from "@/components/settings/about-section";
import { AiQualitySection } from "@/components/admin/ai-quality-section";
import { AiServerKeySection } from "@/components/admin/ai-server-key-section";
import { ProviderHealthSection } from "@/components/admin/provider-health-section";
import { CentralCodexSection } from "@/components/admin/central-codex-section";
import { AssistantSection } from "@/components/admin/assistant-section";
import { CoachFeedbackSection } from "@/components/admin/coach-feedback-section";
import { ApiTokenOverviewSection } from "@/components/admin/api-token-overview-section";
import { AppLogPreviewSection } from "@/components/admin/app-log-preview-section";
import { BackupsSection } from "@/components/admin/backups-section";
import { OffhostBackupsSection } from "@/components/admin/offhost-backups-section";
import { DangerZoneSection } from "@/components/admin/danger-zone-section";
import { EncryptionSection } from "@/components/admin/encryption-section";
import { GeneralSettingsSection } from "@/components/admin/general-settings-section";
import { IntegrationsGroupSection } from "@/components/admin/integrations-group-section";
import { LoginOverviewSection } from "@/components/admin/login-overview-section";
import { ModuleAvailabilitySection } from "@/components/admin/module-availability-section";
import { RemindersSection } from "@/components/admin/reminders-section";
import { ServicesSection } from "@/components/admin/services-section";
import { SystemStatusSection } from "@/components/admin/system-status-section";
import { InviteTokensSection } from "@/components/admin/invite-tokens-section";
import { UserManagementSection } from "@/components/admin/user-management-section";
import type { AdminSectionSlug } from "@/components/admin/section-slugs";

interface RendererProps {
  slug: AdminSectionSlug;
}

export function AdminSectionRenderer({
  slug,
}: RendererProps): JSX.Element | null {
  const { user } = useAuth();

  // The admin shell layout already gates non-admins via `<AuthShell>`,
  // but the auth hook is async — return nothing on the first render so
  // we don't flash sub-section UI to a non-admin who's about to get
  // redirected to `/`.
  if (!user || user.role !== "ADMIN") return null;

  switch (slug) {
    case "system-status":
      return (
        <SectionFrame>
          <SystemStatusSection />
        </SectionFrame>
      );
    case "general":
      return (
        <SectionFrame>
          <GeneralSettingsSection />
        </SectionFrame>
      );
    case "services":
      return (
        <SectionFrame>
          <ServicesSection />
        </SectionFrame>
      );
    case "integrations":
      return (
        <SectionFrame>
          <IntegrationsGroupSection />
        </SectionFrame>
      );
    case "coach":
      // v1.18.1 — the former ai-quality, assistant, and coach-feedback
      // sections fold into one Coach area: surface toggles + operator
      // config first, then the two feedback-quality tables.
      // v1.18.6 (W9) — server-wide module availability moved out to its own
      // `module-availability` section: it gates EVERY module, not just the
      // coach, so it no longer belongs stacked under Coach.
      return (
        <SectionFrame>
          <AssistantSection />
          <AiServerKeySection />
          <CentralCodexSection />
          <ProviderHealthSection />
          <CoachFeedbackSection />
          <AiQualitySection />
        </SectionFrame>
      );
    case "module-availability":
      // v1.18.6 (W9) — operator-side server-wide module on/off, its own
      // admin section (was stacked under Coach). Reconciled name: the
      // user-facing "Module" settings pick from what is available here.
      return (
        <SectionFrame>
          <ModuleAvailabilitySection />
        </SectionFrame>
      );
    case "reminders":
      return (
        <SectionFrame>
          <RemindersSection />
        </SectionFrame>
      );
    case "users":
      return (
        <SectionFrame>
          <UserManagementSection />
        </SectionFrame>
      );
    case "invites":
      // v1.16.0 — invites moved out of Users into their own section:
      // the full table (status, redemptions, revocation) is a workflow
      // of its own and was drowning under the account list.
      return (
        <SectionFrame>
          <InviteTokensSection />
        </SectionFrame>
      );
    case "api-tokens":
      return (
        <SectionFrame>
          <ApiTokenOverviewSection />
        </SectionFrame>
      );
    case "login-overview":
      return (
        <SectionFrame>
          <LoginOverviewSection />
        </SectionFrame>
      );
    case "app-logs":
      return (
        <SectionFrame>
          <AppLogPreviewSection />
        </SectionFrame>
      );
    case "backups":
      // Two cards, two independent failure modes: the copies held in this
      // database, then the copies that reached the operator's bucket.
      return (
        <SectionFrame>
          <BackupsSection />
          <OffhostBackupsSection />
        </SectionFrame>
      );
    case "encryption":
      return (
        <SectionFrame>
          <EncryptionSection />
        </SectionFrame>
      );
    case "danger-zone":
      return (
        <SectionFrame>
          <DangerZoneSection />
        </SectionFrame>
      );
    case "about":
      // v1.4.36 W4e — About section reused as-is from the settings surface.
      // v1.18.6 (W9) — route it through `SectionFrame` like every other admin
      // section so it gets the same visible heading + subtitle (the one admin
      // page that was bypassing the frame and showing no heading).
      return (
        <SectionFrame>
          <AboutSection />
        </SectionFrame>
      );
    default:
      slug satisfies never;
      return null;
  }
}

/**
 * The card-stack wrapper for a section. It took a `title` and a `subtitle`
 * from all seventeen call sites and rendered neither — the visible heading
 * moved to `<AdminShell>` in v1.18.6.1, which reads the same i18n keys
 * itself. A prop contract nothing honours is a promise a later reader
 * believes, so it is gone.
 */
function SectionFrame({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}
