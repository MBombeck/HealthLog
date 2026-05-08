"use client";

import {
  Activity,
  AlertTriangle,
  Bell,
  BellRing,
  Bug,
  Clock,
  Cog,
  Database,
  Globe,
  Key,
  Loader2,
  Server,
  Users,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { StatusItem, useSystemStatus } from "./_shared";

export function SystemStatusSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data: status } = useSystemStatus();

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Server className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("admin.systemStatus")}</h2>
      </div>
      {status ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatusItem
            icon={Database}
            label={t("admin.database")}
            value={
              status.database === "connected"
                ? t("admin.databaseConnected")
                : t("admin.databaseError")
            }
            className={
              status.database === "connected"
                ? "text-dracula-green"
                : "text-destructive"
            }
          />
          <StatusItem
            icon={Clock}
            label={t("admin.startedAt")}
            value={formatDateTime(status.startTime)}
          />
          <StatusItem
            icon={Users}
            label={t("admin.users")}
            value={String(status.counts.users)}
          />
          <StatusItem
            icon={Activity}
            label={t("admin.measurementsCount")}
            value={fmt.integer(status.counts.measurements)}
          />
          <StatusItem
            icon={Key}
            label={t("admin.activeTokens")}
            value={String(status.counts.activeTokens)}
          />
          <StatusItem
            icon={Globe}
            label={t("admin.activeSessions")}
            value={String(status.counts.activeSessions)}
          />
          <StatusItem
            icon={Cog}
            label={t("admin.workerStatus")}
            value={
              status.worker.running
                ? t("admin.workerRunning")
                : t("admin.workerStopped")
            }
            className={
              status.worker.running ? "text-dracula-green" : "text-destructive"
            }
          />
          {status.worker.lastReminderCheck && (
            <StatusItem
              icon={Bell}
              label={t("admin.lastReminderCheck")}
              value={formatDateTime(status.worker.lastReminderCheck)}
            />
          )}
          {status.integrations.umami && (
            <StatusItem
              icon={Activity}
              label="Umami"
              value={
                status.integrations.umami.enabled
                  ? t("common.active")
                  : t("common.disabled")
              }
              className={
                status.integrations.umami.enabled
                  ? "text-dracula-green"
                  : "text-destructive"
              }
            />
          )}
          {status.integrations.glitchtip && (
            <StatusItem
              icon={AlertTriangle}
              label="GlitchTip"
              value={
                status.integrations.glitchtip.enabled
                  ? t("common.active")
                  : t("common.disabled")
              }
              className={
                status.integrations.glitchtip.enabled
                  ? "text-dracula-green"
                  : "text-destructive"
              }
            />
          )}
          {status.integrations.webPush && (
            <StatusItem
              icon={BellRing}
              label={t("admin.integrationWebPush")}
              value={t("admin.configured")}
              className="text-dracula-green"
            />
          )}
          {status.integrations.bugReport && (
            <StatusItem
              icon={Bug}
              label={t("admin.integrationBugReport")}
              value={t("admin.configured")}
              className="text-dracula-green"
            />
          )}
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">
            {t("admin.loadingStatus")}
          </span>
        </div>
      )}
    </div>
  );
}
