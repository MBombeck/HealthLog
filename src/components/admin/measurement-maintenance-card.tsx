"use client";

/**
 * `<MeasurementMaintenanceCard>` — start the measurement table maintenance
 * and follow it, from the admin console instead of a `curl` against the
 * route (runbook: `docs/ops/measurement-maintenance.md`).
 *
 * Calm on purpose. The button asks once, says what the run does and that it
 * can take a while, and then the card shows where the run stands: waiting,
 * running since when, finished, or stopped. It polls only while a run is
 * queued or running. It stays disabled while the compaction-tombstone purge
 * is still at work, because a run started then would refuse at once.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";

import { StatTile } from "@/components/admin/_stat-tile";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { formatBytes } from "@/lib/format/bytes";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { MeasurementMaintenanceStatus } from "@/lib/jobs/measurement-maintenance-status";
import { queryKeys } from "@/lib/query-keys";
import { getApiErrorMessage } from "./_shared";

const ENDPOINT = "/api/admin/maintenance/measurements";

/** How often the card asks while a run is waiting or working. */
const POLL_MS = 10_000;

const GIB = 1024 * 1024 * 1024;

function sizeLabel(
  bytes: number,
  fmt: ReturnType<typeof useFormatters>,
): string {
  // The shared formatter stops at MB; this table is routinely gigabytes.
  return bytes >= GIB
    ? `${fmt.number(bytes / GIB, 2)} GB`
    : formatBytes(bytes, fmt);
}

export function MeasurementMaintenanceCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: queryKeys.adminMeasurementMaintenance(),
    queryFn: () =>
      apiGet<MeasurementMaintenanceStatus>(ENDPOINT, {
        credentials: "include",
      }),
    refetchInterval: (query) => {
      const state = query.state.data?.run?.state;
      return state === "queued" || state === "running" ? POLL_MS : false;
    },
  });

  const start = useMutation({
    mutationFn: async (): Promise<{ enqueued: boolean }> => {
      const res = await apiFetchRaw(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vacuum: true, reindex: true }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res));
      return ((await res.json()) as { data: { enqueued: boolean } }).data;
    },
    onSuccess: ({ enqueued }) => {
      if (enqueued) toast.success(t("admin.section.maintenance.started"));
      else toast.info(t("admin.section.maintenance.alreadyQueued"));
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminMeasurementMaintenance(),
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || t("admin.section.maintenance.startFailed"));
    },
  });

  const header = (
    <SettingsCardHeader
      icon={Database}
      title={t("admin.section.maintenance.title")}
      description={t("admin.section.maintenance.description")}
    />
  );

  if (status.isError) {
    return (
      <QueryErrorCard
        title={t("admin.section.maintenance.loadError")}
        onRetry={() => void status.refetch()}
      />
    );
  }

  const s = status.data;
  const run = s?.run ?? null;
  const active = run?.state === "queued" || run?.state === "running";
  const blocked = !s || !s.available || s.purgePending || active;

  return (
    <SettingsCard data-testid="admin-measurement-maintenance">
      {header}
      <p className="text-sm">{t("admin.section.maintenance.body")}</p>

      {s?.sizes ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <StatTile
            label={t("admin.section.maintenance.tableSize")}
            value={sizeLabel(s.sizes.tableBytes, fmt)}
          />
          <StatTile
            label={t("admin.section.maintenance.indexSize")}
            value={sizeLabel(s.sizes.indexBytes, fmt)}
          />
        </div>
      ) : null}

      <div
        className="text-sm"
        role="status"
        aria-live="polite"
        data-slot="maintenance-state"
        data-state={status.isLoading ? "loading" : (run?.state ?? "idle")}
      >
        {status.isLoading ? (
          <span className="text-muted-foreground flex items-center gap-2">
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            {t("admin.section.maintenance.loading")}
          </span>
        ) : !s?.available ? (
          <span className="text-muted-foreground">
            {t("admin.section.maintenance.unavailable")}
          </span>
        ) : run?.state === "queued" ? (
          <span className="flex items-center gap-2">
            <Loader2
              className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            {t("admin.section.maintenance.state.queued")}
          </span>
        ) : run?.state === "running" ? (
          <span className="flex items-center gap-2">
            <Loader2
              className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            {t("admin.section.maintenance.state.running", {
              since: fmt.time(run.startedAt ?? run.requestedAt),
            })}
          </span>
        ) : run?.state === "completed" ? (
          <span>
            {run.outcome === "refused_purge_running"
              ? t("admin.section.maintenance.state.refusedPurge")
              : run.outcome === "already_running"
                ? t("admin.section.maintenance.state.alreadyRunning")
                : t("admin.section.maintenance.state.completed", {
                    at: fmt.dateTime(run.finishedAt ?? run.requestedAt),
                  })}
          </span>
        ) : run?.state === "failed" ? (
          <span className="text-destructive">
            {t("admin.section.maintenance.state.failed", {
              at: fmt.dateTime(run.finishedAt ?? run.requestedAt),
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {t("admin.section.maintenance.state.idle")}
          </span>
        )}
      </div>

      {s?.available && s.purgePending ? (
        <p className="text-muted-foreground text-xs">
          {t("admin.section.maintenance.purgePending")}
        </p>
      ) : null}

      <SettingsCardActions>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={blocked || start.isPending}
              data-testid="admin-maintenance-start"
            >
              {start.isPending ? (
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <Wrench className="size-3.5" aria-hidden />
              )}
              {t("admin.section.maintenance.start")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("admin.section.maintenance.confirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("admin.section.maintenance.confirmBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("admin.section.maintenance.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => start.mutate()}>
                {t("admin.section.maintenance.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingsCardActions>
    </SettingsCard>
  );
}
