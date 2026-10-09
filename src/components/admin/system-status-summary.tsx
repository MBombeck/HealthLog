"use client";

/**
 * `<SystemStatusSummary>` — compact at-a-glance system snapshot for the
 * `/admin` overview landing page.
 *
 * The full breakdown lives in `<SystemStatusSection>` at
 * `/admin/system-status`; this component only surfaces the handful of
 * facts an admin wants on the overview screen: app version, database
 * up/down, worker running, image build SHA + timestamp, and the
 * server-process start time. Same `useSystemStatus()` data source so we
 * don't re-fetch.
 */

import {
  Clock,
  Cog,
  Database,
  Globe,
  KeyRound,
  Loader2,
  Server,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations } from "@/lib/i18n/context";
import {
  geoLookupState,
  StatusItem,
  usePublicVersion,
  useSystemStatus,
} from "./_shared";
import { useKeyBackupStatus } from "./use-key-backup-status";

export function SystemStatusSummary() {
  const { t } = useTranslations();
  const { data: status, isError, refetch } = useSystemStatus();
  const { data: version } = usePublicVersion();
  const { data: keyBackup } = useKeyBackupStatus();

  return (
    <SettingsCard
      as="section"
      aria-labelledby="admin-overview-snapshot-heading"
    >
      <SettingsCardHeader
        icon={Server}
        titleId="admin-overview-snapshot-heading"
        title={t("admin.overview.snapshotTitle")}
      />

      {status ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatusItem
            icon={Database}
            label={t("admin.overview.snapshotDatabase")}
            value={
              status.database === "connected"
                ? t("admin.databaseConnected")
                : t("admin.databaseError")
            }
            tone={status.database === "connected" ? "success" : "destructive"}
          />
          <StatusItem
            icon={Cog}
            label={t("admin.overview.snapshotWorker")}
            value={
              status.worker.running
                ? t("admin.workerRunning")
                : t("admin.workerStopped")
            }
            tone={status.worker.running ? "success" : "destructive"}
          />
          <StatusItem
            icon={Clock}
            label={t("admin.overview.snapshotStarted")}
            value={formatDateTime(status.startTime)}
          />
          {/* v1.40.0 — the encryption key backup step, warning while due. */}
          {keyBackup && (
            <StatusItem
              icon={KeyRound}
              label={t("admin.keyBackup.tileLabel")}
              value={
                keyBackup.due
                  ? t("admin.keyBackup.tileDue")
                  : t("admin.keyBackup.tileDone")
              }
              tone={keyBackup.due ? "warning" : "success"}
            />
          )}
          {/* v1.4.27 R5 — surface the offline-geo state so the maintainer
              spots the missing MAXMIND_LICENSE_KEY without crawling logs.
              The field is undefined on legacy responses; the row only
              renders when /api/version answers the new shape. */}
          {version?.offlineGeoEnabled !== undefined && (
            <StatusItem
              icon={Globe}
              label={t("admin.overview.snapshotOfflineGeo")}
              value={
                {
                  offline: t("admin.overview.snapshotOfflineGeoOn"),
                  off: t("admin.offlineGeoOff"),
                  chosen: t("admin.offlineGeoChosen", {
                    host: version.geoProviderHost ?? "ipwho.is",
                  }),
                  default: t("admin.overview.snapshotOfflineGeoOff", {
                    host: version.geoProviderHost ?? "ipwho.is",
                  }),
                }[geoLookupState(version)]
              }
              tone={
                geoLookupState(version) === "default" ? "warning" : "success"
              }
            />
          )}
        </div>
      ) : isError ? (
        <QueryErrorRow
          message={t("admin.overview.snapshotLoadError")}
          onRetry={() => void refetch()}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Loader2
            className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="text-muted-foreground text-sm">
            {t("admin.overview.snapshotLoading")}
          </span>
        </div>
      )}
    </SettingsCard>
  );
}
