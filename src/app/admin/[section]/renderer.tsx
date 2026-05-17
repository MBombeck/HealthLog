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
import { useTranslations } from "@/lib/i18n/context";
import { AboutSection } from "@/components/settings/about-section";
import { AiQualitySection } from "@/components/admin/ai-quality-section";
import { AssistantSection } from "@/components/admin/assistant-section";
import { CoachFeedbackSection } from "@/components/admin/coach-feedback-section";
import { ApiTokenOverviewSection } from "@/components/admin/api-token-overview-section";
import { AppLogPreviewSection } from "@/components/admin/app-log-preview-section";
import { BackupsSection } from "@/components/admin/backups-section";
import { DangerZoneSection } from "@/components/admin/danger-zone-section";
import { FeedbackInboxSection } from "@/components/admin/feedback-inbox-section";
import { GeneralSettingsSection } from "@/components/admin/general-settings-section";
import { IntegrationsGroupSection } from "@/components/admin/integrations-group-section";
import { LoginOverviewSection } from "@/components/admin/login-overview-section";
import { RemindersSection } from "@/components/admin/reminders-section";
import { ServicesSection } from "@/components/admin/services-section";
import { SystemStatusSection } from "@/components/admin/system-status-section";
import { UserManagementSection } from "@/components/admin/user-management-section";
import type { AdminSectionSlug } from "@/components/admin/section-slugs";

interface RendererProps {
  slug: AdminSectionSlug;
}

export function AdminSectionRenderer({
  slug,
}: RendererProps): JSX.Element | null {
  const { user } = useAuth();
  const { t } = useTranslations();

  // The admin shell layout already gates non-admins via `<AuthShell>`,
  // but the auth hook is async — return nothing on the first render so
  // we don't flash sub-section UI to a non-admin who's about to get
  // redirected to `/`.
  if (!user || user.role !== "ADMIN") return null;

  switch (slug) {
    case "system-status":
      return (
        <SectionFrame
          title={t("admin.section.system-status.title")}
          subtitle={t("admin.section.system-status.subtitle")}
        >
          <SystemStatusSection />
        </SectionFrame>
      );
    case "general":
      return (
        <SectionFrame
          title={t("admin.section.general.title")}
          subtitle={t("admin.section.general.subtitle")}
        >
          <GeneralSettingsSection />
        </SectionFrame>
      );
    case "services":
      return (
        <SectionFrame
          title={t("admin.section.services.title")}
          subtitle={t("admin.section.services.subtitle")}
        >
          <ServicesSection />
        </SectionFrame>
      );
    case "integrations":
      return (
        <SectionFrame
          title={t("admin.section.integrations.title")}
          subtitle={t("admin.section.integrations.subtitle")}
        >
          <IntegrationsGroupSection />
        </SectionFrame>
      );
    case "ai-quality":
      return (
        <SectionFrame
          title={t("admin.section.ai-quality.title")}
          subtitle={t("admin.section.ai-quality.subtitle")}
        >
          <AiQualitySection />
        </SectionFrame>
      );
    case "assistant":
      return (
        <SectionFrame
          title={t("admin.section.assistant.title")}
          subtitle={t("admin.section.assistant.subtitle")}
        >
          <AssistantSection />
        </SectionFrame>
      );
    case "coach-feedback":
      return (
        <SectionFrame
          title={t("admin.section.coach-feedback.title")}
          subtitle={t("admin.section.coach-feedback.subtitle")}
        >
          <CoachFeedbackSection />
        </SectionFrame>
      );
    case "feedback":
      return (
        <SectionFrame
          title={t("admin.section.feedback.title")}
          subtitle={t("admin.section.feedback.subtitle")}
        >
          <FeedbackInboxSection />
        </SectionFrame>
      );
    case "reminders":
      return (
        <SectionFrame
          title={t("admin.section.reminders.title")}
          subtitle={t("admin.section.reminders.subtitle")}
        >
          <RemindersSection />
        </SectionFrame>
      );
    case "users":
      return (
        <SectionFrame
          title={t("admin.section.users.title")}
          subtitle={t("admin.section.users.subtitle")}
        >
          <UserManagementSection />
        </SectionFrame>
      );
    case "api-tokens":
      return (
        <SectionFrame
          title={t("admin.section.api-tokens.title")}
          subtitle={t("admin.section.api-tokens.subtitle")}
        >
          <ApiTokenOverviewSection />
        </SectionFrame>
      );
    case "login-overview":
      return (
        <SectionFrame
          title={t("admin.section.login-overview.title")}
          subtitle={t("admin.section.login-overview.subtitle")}
        >
          <LoginOverviewSection />
        </SectionFrame>
      );
    case "app-logs":
      return (
        <SectionFrame
          title={t("admin.section.app-logs.title")}
          subtitle={t("admin.section.app-logs.subtitle")}
        >
          <AppLogPreviewSection />
        </SectionFrame>
      );
    case "backups":
      return (
        <SectionFrame
          title={t("admin.section.backups.title")}
          subtitle={t("admin.section.backups.subtitle")}
        >
          <BackupsSection />
        </SectionFrame>
      );
    case "danger-zone":
      return (
        <SectionFrame
          title={t("admin.section.danger-zone.title")}
          subtitle={t("admin.section.danger-zone.subtitle")}
        >
          <DangerZoneSection />
        </SectionFrame>
      );
    case "about":
      // v1.4.36 W4e — About section reused as-is from the settings
      // surface. The component owns its own heading + cards layout
      // so no SectionFrame wrapper.
      return <AboutSection />;
    default:
      slug satisfies never;
      return null;
  }
}

interface SectionFrameProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

function SectionFrame({ title, subtitle, children }: SectionFrameProps) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}
