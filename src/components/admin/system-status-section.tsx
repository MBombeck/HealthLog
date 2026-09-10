"use client";

import dynamic from "next/dynamic";
import {
  Activity,
  AlertTriangle,
  Bell,
  BellRing,
  Clock,
  Cog,
  Database,
  Globe,
  Key,
  Loader2,
  Map,
  Server,
  Users,
} from "lucide-react";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  StatusItem,
  usePublicVersion,
  useSystemStatus,
  type FailingQueue,
} from "./_shared";

// v1.4.16 phase B3: Recharts is ~108 KiB Brotli — defer-load the host
// metrics chart so the system-status page only ships it when an admin
// actually opens this view. Splitting at the wrapper boundary (instead
// of per-primitive) keeps Recharts' `findAllByType` reconciliation
// working — same pattern the insights page uses for the scatter chart.
const HostMetricsChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.HostMetricsChart,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="bg-muted/40 h-[200px] w-full rounded-xl" />
    ),
  },
);

/**
 * The queues whose jobs gave up, named.
 *
 * Before this, a background job that threw on every single run showed up as one
 * digit in an unnamed `errors` counter, and the module it fed rendered an empty
 * screen as if empty were the answer. A broken queue has to say its own name,
 * so this card is rendered whenever there is anything to report and stays
 * silent otherwise — an operator should be able to trust that a quiet card
 * means quiet queues, which is why the "cannot ask" case renders its own line
 * rather than looking identical to health.
 */
export function FailingJobsCard({
  failingJobs,
}: {
  failingJobs: { windowHours: number; queues: FailingQueue[] } | null;
}) {
  const { t, tCount } = useTranslations();

  if (failingJobs === null) {
    return (
      <SettingsCard>
        <SettingsCardHeader
          icon={AlertTriangle}
          title={t("admin.failingJobs.title")}
          description={t("admin.failingJobs.description")}
        />
        <p className="text-muted-foreground text-sm">
          {t("admin.failingJobs.unavailable")}
        </p>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={AlertTriangle}
        title={t("admin.failingJobs.title")}
        description={t("admin.failingJobs.description")}
      />
      {failingJobs.queues.length === 0 ? (
        <p
          data-testid="failing-jobs-none"
          className="text-muted-foreground text-sm"
        >
          {t("admin.failingJobs.none", { hours: failingJobs.windowHours })}
        </p>
      ) : (
        <ul data-testid="failing-jobs-list" className="space-y-3">
          {failingJobs.queues.map((queue) => (
            <li key={queue.queue} className="text-sm">
              <p className="text-foreground font-medium">
                <span className="font-mono">{queue.queue}</span>{" "}
                <span className="text-destructive font-normal">
                  {tCount("admin.failingJobs.count", queue.failures, {
                    count: queue.failures,
                  })}
                </span>
              </p>
              <p className="text-muted-foreground text-xs">
                {t("admin.failingJobs.lastFailed", {
                  when: formatDateTime(queue.lastFailedAt),
                })}
              </p>
              {queue.lastError.length > 0 && (
                <p className="text-muted-foreground mt-0.5 font-mono text-xs break-all">
                  {queue.lastError}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

export function SystemStatusSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data: status, isError, refetch } = useSystemStatus();
  const { data: version } = usePublicVersion();

  return (
    <div className="space-y-6">
      <HostMetricsChart />
      <SettingsCard>
        <SettingsCardHeader
          icon={Server}
          title={t("admin.systemStatus")}
          description={t("admin.systemStatusDescription")}
        />
        {status ? (
          <div
            // `system-status-grid` names the answered snapshot. The two
            // branches below it are a load error and a spinner, so the
            // marker cannot stand for a section still waiting on the read.
            data-slot="system-status-grid"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <StatusItem
              icon={Database}
              label={t("admin.database")}
              value={
                status.database === "connected"
                  ? t("admin.databaseConnected")
                  : t("admin.databaseError")
              }
              tone={status.database === "connected" ? "success" : "destructive"}
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
              tone={status.worker.running ? "success" : "destructive"}
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
                tone={
                  status.integrations.umami.enabled ? "success" : "destructive"
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
                tone={
                  status.integrations.glitchtip.enabled
                    ? "success"
                    : "destructive"
                }
              />
            )}
            {status.integrations.webPush && (
              <StatusItem
                icon={BellRing}
                label={t("admin.integrationWebPush")}
                value={t("admin.configured")}
                tone="success"
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
                    : t("admin.offlineGeoFallback", {
                        host: version.geoProviderHost ?? "ipwho.is",
                      })
                }
                tone={version.offlineGeoEnabled ? "success" : "warning"}
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
          <QueryErrorRow
            message={t("admin.systemStatusLoadError")}
            onRetry={() => void refetch()}
            retryLabel={t("admin.systemStatusRetry")}
            retrySlot="system-status-retry"
          />
        ) : (
          <div className="flex items-center gap-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
            <span className="text-muted-foreground text-sm">
              {t("admin.loadingStatus")}
            </span>
          </div>
        )}
      </SettingsCard>
      {status && <FailingJobsCard failingJobs={status.failingJobs} />}
    </div>
  );
}
