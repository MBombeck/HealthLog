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
  GitCommit,
  Globe,
  Loader2,
  Server,
  Tag,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { StatusItem, useSystemStatus } from "./_shared";

interface VersionResponse {
  version: string;
  buildSha: string | null;
  builtAt: string | null;
  offlineGeoEnabled?: boolean;
}

function useVersion() {
  return useQuery({
    queryKey: ["public", "version"],
    queryFn: async () => {
      const res = await fetch("/api/version");
      if (!res.ok) throw new Error("Failed to load version");
      return (await res.json()).data as VersionResponse;
    },
    staleTime: 5 * 60_000,
  });
}

export function SystemStatusSummary() {
  const { t } = useTranslations();
  const { data: status, isError } = useSystemStatus();
  const { data: version } = useVersion();

  return (
    <section
      aria-labelledby="admin-overview-snapshot-heading"
      className="bg-card border-border rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Server className="text-primary h-5 w-5" aria-hidden="true" />
        <h2
          id="admin-overview-snapshot-heading"
          className="text-lg font-semibold"
        >
          {t("admin.overview.snapshotTitle")}
        </h2>
      </div>

      {status ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatusItem
            icon={Tag}
            label={t("admin.overview.snapshotVersion")}
            value={version?.version ?? status.version}
          />
          <StatusItem
            icon={Database}
            label={t("admin.overview.snapshotDatabase")}
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
            icon={Cog}
            label={t("admin.overview.snapshotWorker")}
            value={
              status.worker.running
                ? t("admin.workerRunning")
                : t("admin.workerStopped")
            }
            className={
              status.worker.running ? "text-dracula-green" : "text-destructive"
            }
          />
          <StatusItem
            icon={Clock}
            label={t("admin.overview.snapshotStarted")}
            value={formatDateTime(status.startTime)}
          />
          {(version?.buildSha ?? status.gitCommit) && (
            <StatusItem
              icon={GitCommit}
              label={t("admin.overview.snapshotBuildSha")}
              value={version?.buildSha ?? status.gitCommit}
            />
          )}
          {version?.builtAt && (
            <StatusItem
              icon={Clock}
              label={t("admin.overview.snapshotBuiltAt")}
              value={formatDateTime(version.builtAt)}
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
                version.offlineGeoEnabled
                  ? t("admin.overview.snapshotOfflineGeoOn")
                  : t("admin.overview.snapshotOfflineGeoOff")
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
        <div
          role="alert"
          className="text-destructive bg-destructive/10 border-destructive/30 mt-4 rounded-md border px-3 py-2 text-sm"
        >
          {t("admin.overview.snapshotLoadError")}
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <Loader2
            className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="text-muted-foreground text-sm">
            {t("admin.overview.snapshotLoading")}
          </span>
        </div>
      )}
    </section>
  );
}
