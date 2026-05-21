"use client";

import dynamic from "next/dynamic";
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
  Map,
  RotateCw,
  Server,
  Users,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { StatusItem, useSystemStatus } from "./_shared";

interface VersionResponse {
  version: string;
  buildSha: string | null;
  builtAt: string | null;
  offlineGeoEnabled?: boolean;
}

function useOfflineGeoState() {
  return useQuery({
    queryKey: queryKeys.publicVersion(),
    queryFn: async () => {
      const res = await fetch("/api/version");
      if (!res.ok) throw new Error("Failed to load version");
      return (await res.json()).data as VersionResponse;
    },
    staleTime: 5 * 60_000,
  });
}

// v1.4.16 phase B3: Recharts is ~108 KiB Brotli — defer-load the host
// metrics chart so the system-status page only ships it when an admin
// actually opens this view. Splitting at the wrapper boundary (instead
// of per-primitive) keeps Recharts' `findAllByType` reconciliation
// working — same pattern the insights page uses for the scatter chart.
const HostMetricsChart = dynamic(
  () =>
    import("./host-metrics-chart").then((mod) => ({
      default: mod.HostMetricsChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="bg-muted/40 h-[200px] w-full animate-pulse rounded-xl motion-reduce:animate-none" />
    ),
  },
);

export function SystemStatusSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data: status, isError, refetch, isFetching } = useSystemStatus();
  const { data: version } = useOfflineGeoState();

  return (
    <div className="space-y-6">
      <HostMetricsChart />
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="flex items-center gap-2">
          <Server className="text-primary h-5 w-5" />
          <div className="text-lg font-semibold">{t("admin.systemStatus")}</div>
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
                status.worker.running
                  ? "text-dracula-green"
                  : "text-destructive"
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
            {/* v1.4.27 R5 — offline GeoLite2 availability. Renders only
                when /api/version returns the new field so legacy
                responses do not produce a placeholder row. */}
            {version?.offlineGeoEnabled !== undefined && (
              <StatusItem
                icon={Map}
                label={t("admin.offlineGeoLabel")}
                value={
                  version.offlineGeoEnabled
                    ? t("admin.offlineGeoEnabled")
                    : t("admin.offlineGeoFallback")
                }
                className={
                  version.offlineGeoEnabled
                    ? "text-dracula-green"
                    : "text-dracula-yellow"
                }
              />
            )}
          </div>
        ) : isError ? (
          // P19: surface load failures inline instead of leaving the
          // section spinning forever. The hook throws on non-OK
          // responses, so isError is true on 500s, network errors, etc.
          // v1.4.16 Wave-C MED — pair the alert with a Retry button so a
          // transient 500 (rolling deploy, DB blip) doesn't require a
          // full page reload to recover.
          <div
            role="alert"
            className="text-destructive bg-destructive/10 border-destructive/30 mt-4 flex flex-col items-start gap-2 rounded-md border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span>{t("admin.systemStatusLoadError")}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isFetching}
              onClick={() => void refetch()}
              className="min-h-9"
              data-testid="system-status-retry"
            >
              {isFetching ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <RotateCw className="mr-1 h-3.5 w-3.5" />
              )}
              {t("admin.systemStatusRetry")}
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
            <span className="text-muted-foreground text-sm">
              {t("admin.loadingStatus")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
