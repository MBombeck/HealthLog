"use client";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { ApiTokenOverviewSection } from "@/components/admin/api-token-overview-section";
import { BugReportSection } from "@/components/admin/bug-report-section";
import { DangerZoneSection } from "@/components/admin/danger-zone-section";
import { FeedbackInboxSection } from "@/components/admin/feedback-inbox-section";
import { GeneralSettingsSection } from "@/components/admin/general-settings-section";
import { GlitchtipSection } from "@/components/admin/glitchtip-section";
import { LoginOverviewSection } from "@/components/admin/login-overview-section";
import { RemindersSection } from "@/components/admin/reminders-section";
import { ServicesSection } from "@/components/admin/services-section";
import { StatusCardGrid } from "@/components/admin/status-card-grid";
import { SystemStatusSection } from "@/components/admin/system-status-section";
import { UmamiSection } from "@/components/admin/umami-section";
import { UserManagementSection } from "@/components/admin/user-management-section";
import { WebPushVapidSection } from "@/components/admin/web-push-vapid-section";

export default function AdminPage() {
  const { user } = useAuth();
  const { t } = useTranslations();

  if (!user || user.role !== "ADMIN") return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("admin.title")}
        </h1>
        <p className="text-muted-foreground text-sm">{t("admin.subtitle")}</p>
      </div>

      <StatusCardGrid />

      <div className="space-y-6">
        <SystemStatusSection id="section-system-status" />

        <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
          {t("admin.sectionGeneral")}
        </h2>
        <GeneralSettingsSection id="section-admin-general" />
        <ServicesSection id="section-admin-services" />

        <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
          {t("admin.sectionIntegrations")}
        </h2>
        <UmamiSection id="section-admin-umami" />
        <GlitchtipSection id="section-admin-glitchtip" />
        <WebPushVapidSection id="section-admin-webpush" />
        <BugReportSection id="section-admin-bugreport" />

        <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
          {t("admin.feedback.sectionTitle")}
        </h2>
        <FeedbackInboxSection id="section-admin-feedback" />

        <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
          {t("admin.sectionMedication")}
        </h2>
        <RemindersSection id="section-admin-reminders" />

        <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
          {t("admin.sectionManagement")}
        </h2>
        <UserManagementSection
          id="section-user-management"
          currentUserId={user.id}
        />
        <ApiTokenOverviewSection id="section-api-tokens" />
        <LoginOverviewSection id="section-login-overview" />
        <DangerZoneSection id="section-danger-zone" />
      </div>
    </div>
  );
}
