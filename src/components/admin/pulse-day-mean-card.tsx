"use client";

/**
 * `<PulseDayMeanCard>` — switch the pulse day mean to weigh sparse hours, with
 * a dry run first (#1107 follow-up).
 *
 * The card shows the active method, starts a dry run, shows what it found
 * (how many days would move by more than 1 bpm, the largest move, the spread,
 * and the same per account under an ordinal), and applies the new method once
 * a dry run from the last seven days has finished. It polls only while a dry
 * run is queued or running. The route enforces every rule the buttons mirror.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, HeartPulse, Loader2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import {
  ApiError,
  apiFetchRaw,
  apiGet,
  throwApiError,
} from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  hasFreshDryRun,
  type PulseDayMeanActionInput,
  type PulseDayMeanStatus,
} from "@/lib/validations/pulse-day-mean";

const ENDPOINT = "/api/admin/maintenance/pulse-day-mean";

/** How often the card asks while a dry run is waiting or working. */
const POLL_MS = 10_000;

export function PulseDayMeanCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: queryKeys.adminPulseDayMean(),
    queryFn: () =>
      apiGet<PulseDayMeanStatus>(ENDPOINT, { credentials: "include" }),
    refetchInterval: (query) => {
      const states = [
        query.state.data?.lastDryRun?.status,
        query.state.data?.lastRebuild?.status,
      ];
      return states.some((state) => state === "queued" || state === "running")
        ? POLL_MS
        : false;
    },
  });

  const run = useMutation({
    mutationFn: async (
      action: PulseDayMeanActionInput["action"],
    ): Promise<{ action: typeof action; enqueued: boolean }> => {
      const res = await apiFetchRaw(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) await throwApiError(res);
      const { enqueued } = (
        (await res.json()) as { data: { enqueued: boolean } }
      ).data;
      return { action, enqueued };
    },
    onSuccess: ({ action, enqueued }) => {
      if (action === "apply") {
        toast.success(
          enqueued
            ? t("admin.section.pulseDayMean.applied")
            : t("admin.section.pulseDayMean.appliedNoRebuild"),
        );
      } else {
        toast.success(
          action === "rebuild"
            ? t("admin.section.pulseDayMean.rebuildStarted")
            : t("admin.section.pulseDayMean.dryRunStarted"),
        );
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminPulseDayMean(),
      });
    },
    // The route's two refusals each have their own message.
    onError: (err) => {
      const code = err instanceof ApiError ? err.meta?.errorCode : undefined;
      showErrorToast(
        code === "maintenance.pulseDayMean.busy"
          ? t("admin.section.pulseDayMean.error.busy")
          : code === "maintenance.pulseDayMean.dryRunRequired"
            ? t("admin.section.pulseDayMean.error.dryRunRequired")
            : localizedApiError(
                err,
                t,
                "admin.section.pulseDayMean.error.generic",
              ),
        { cause: err },
      );
    },
  });

  if (status.isError) {
    return (
      <QueryErrorCard
        error={status.error}
        title={t("admin.section.pulseDayMean.loadError")}
        onRetry={() => void status.refetch()}
      />
    );
  }

  const s = status.data;
  const dryRun = s?.lastDryRun ?? null;
  const result = dryRun?.status === "done" ? dryRun.result : null;
  const rebuild = s?.lastRebuild ?? null;
  const rebuilding =
    rebuild?.status === "queued" || rebuild?.status === "running";
  const active =
    dryRun?.status === "queued" || dryRun?.status === "running" || rebuilding;
  const weighted = s?.method === "weighted_hour_mean_v2";
  const canApply = !!s && !active && hasFreshDryRun(s);
  // A stopped recalculation is run again from here; the method is already
  // switched, so it needs no new dry run.
  const canRebuild = !!s?.appliedAt && rebuild?.status === "failed";

  return (
    <SettingsCard data-testid="admin-pulse-day-mean">
      <SettingsCardHeader
        icon={HeartPulse}
        title={t("admin.section.pulseDayMean.title")}
        description={t("admin.section.pulseDayMean.description")}
        status={
          s ? (
            <Badge variant="secondary" data-slot="pulse-day-mean-method">
              {weighted
                ? t("admin.section.pulseDayMean.method.weighted")
                : t("admin.section.pulseDayMean.method.hourly")}
            </Badge>
          ) : null
        }
      />
      <p className="text-sm">{t("admin.section.pulseDayMean.body")}</p>

      <div
        className="text-sm"
        role="status"
        aria-live="polite"
        data-slot="pulse-day-mean-state"
        data-state={status.isLoading ? "loading" : (dryRun?.status ?? "idle")}
      >
        {status.isLoading ? (
          <span className="text-muted-foreground flex items-center gap-2">
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            {t("admin.section.pulseDayMean.loading")}
          </span>
        ) : active ? (
          <span className="flex items-center gap-2">
            <Loader2
              className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            {dryRun?.status === "queued"
              ? t("admin.section.pulseDayMean.state.queued")
              : t("admin.section.pulseDayMean.state.running")}
          </span>
        ) : dryRun?.status === "done" ? (
          <span>
            {t("admin.section.pulseDayMean.state.done", {
              at: fmt.dateTime(dryRun.finishedAt ?? dryRun.startedAt),
            })}
          </span>
        ) : dryRun?.status === "failed" ? (
          <span className="text-destructive">
            {t("admin.section.pulseDayMean.state.failed")}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {t("admin.section.pulseDayMean.state.idle")}
          </span>
        )}
      </div>

      {result ? (
        <div className="space-y-3" data-slot="pulse-day-mean-result">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              label={t("admin.section.pulseDayMean.result.days")}
              value={fmt.number(result.daysCompared)}
            />
            <StatTile
              label={t("admin.section.pulseDayMean.result.changed")}
              value={fmt.number(result.daysChangedOver1Bpm)}
            />
            <StatTile
              label={t("admin.section.pulseDayMean.result.max")}
              value={t("admin.section.pulseDayMean.result.maxValue", {
                value: fmt.number(result.maxChangeBpm, 1),
              })}
            />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm sm:grid-cols-4">
            {result.distribution.map((d) => (
              <div key={d.bucket}>
                <dt className="text-muted-foreground text-xs">
                  {t("admin.section.pulseDayMean.result.bucket", {
                    range: d.bucket,
                  })}
                </dt>
                <dd className="tabular-nums">{fmt.number(d.days)}</dd>
              </div>
            ))}
          </dl>
          {result.perAccount.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {result.perAccount.map((a) => (
                <li
                  key={a.account}
                  className="flex items-center justify-between gap-3"
                >
                  <span>
                    {t("admin.section.pulseDayMean.result.account", {
                      account: a.account,
                    })}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {t("admin.section.pulseDayMean.result.accountDays", {
                      changed: fmt.number(a.changedOver1Bpm),
                      days: fmt.number(a.days),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {s?.appliedAt ? (
        <p className="text-muted-foreground text-xs">
          {t("admin.section.pulseDayMean.appliedAt", {
            at: fmt.dateTime(s.appliedAt),
          })}
        </p>
      ) : null}

      {rebuild ? (
        <p
          className={
            rebuild.status === "failed"
              ? "text-destructive text-sm"
              : "text-muted-foreground text-xs"
          }
          data-slot="pulse-day-mean-rebuild"
          data-state={rebuild.status}
        >
          {rebuild.status === "done"
            ? t("admin.section.pulseDayMean.rebuild.done", {
                at: fmt.dateTime(rebuild.finishedAt ?? rebuild.startedAt),
                accounts: fmt.number(rebuild.accounts ?? 0),
              })
            : t(`admin.section.pulseDayMean.rebuild.${rebuild.status}`)}
        </p>
      ) : null}

      <SettingsCardActions>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          disabled={!s || active || run.isPending}
          onClick={() => run.mutate("dry_run")}
          data-testid="admin-pulse-day-mean-dry-run"
        >
          <FlaskConical className="size-3.5" aria-hidden />
          {t("admin.section.pulseDayMean.dryRun")}
        </Button>
        {canRebuild ? (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={run.isPending}
            onClick={() => run.mutate("rebuild")}
            data-testid="admin-pulse-day-mean-rebuild"
          >
            {t("admin.section.pulseDayMean.rebuildAgain")}
          </Button>
        ) : null}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={!canApply || run.isPending}
              data-testid="admin-pulse-day-mean-apply"
            >
              {run.isPending ? (
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : null}
              {t("admin.section.pulseDayMean.apply")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("admin.section.pulseDayMean.confirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("admin.section.pulseDayMean.confirmBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("admin.section.pulseDayMean.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => run.mutate("apply")}>
                {t("admin.section.pulseDayMean.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingsCardActions>
    </SettingsCard>
  );
}
