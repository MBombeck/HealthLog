"use client";

/**
 * Admin > Push and channels: whether pushes are getting through, for every
 * channel and every account, and a test push to the admin's own channels.
 * It sat under Reminders, beside the medication reminder windows; push now
 * lives in one place (the channel switches, the Web Push keys, the relay and
 * this), and Reminders holds only the reminder rules.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, CheckCircle2, HeartPulse, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import {
  describeChannelTestFailures,
  type ChannelTestResult,
} from "./notification-test-failures";

interface NotificationHealth {
  windowHours: number;
  since: string;
  channels: Array<{
    channel: string;
    ok: number;
    error: number;
    skipped: number;
    total: number;
  }>;
  autoDisabledChannels: Array<{ type: string; count: number }>;
}

/**
 * Operator-wide notification delivery health. A single
 * `groupBy(channel, result)` over the trailing 24h of `push_attempts` plus the
 * count of auto-disabled channels across all users. Lets the operator answer
 * "are anyone's pushes failing?" without DB shell.
 */
export function NotificationHealthCard() {
  const { t } = useTranslations();
  const testNotification = useMutation({
    mutationFn: async () => {
      return apiPost<
        | {
            message?: string;
            results?: ChannelTestResult[];
          }
        | undefined
      >("/api/admin/notifications/test");
    },
    onSuccess: (data) => {
      const failures = describeChannelTestFailures(data?.results ?? [], t);
      if (failures.length > 0) {
        showErrorToast(data?.message ?? t("admin.notificationTestFailed"), {
          description: (
            <ul className="space-y-0.5">
              {failures.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ),
        });
      } else {
        toast.success(data?.message ?? t("admin.notificationTestSuccess"));
      }
    },
    onError: (error) => {
      showErrorToast(
        localizedApiError(error, t, "admin.notificationTestFailed"),
        { cause: error },
      );
    },
  });

  const windowHours = 24;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.adminNotificationHealth(windowHours),
    queryFn: async () =>
      apiGet<NotificationHealth>(
        `/api/admin/notifications/health?hours=${windowHours}`,
      ),
  });

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={HeartPulse}
        title={t("admin.notificationHealth.title")}
        description={t("admin.notificationHealth.description")}
      />

      <div>
        {isError ? (
          <QueryErrorRow
            inset
            error={error}
            message={t("admin.notificationHealth.loadError")}
            onRetry={() => void refetch()}
          />
        ) : null}
        {isLoading && (
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
        )}

        {data && data.channels.length === 0 && (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("admin.notificationHealth.empty")}
          />
        )}

        {data && data.channels.length > 0 && (
          <div className="space-y-2">
            {data.channels.map((c) => (
              <div
                key={c.channel}
                className="flex items-center justify-between text-sm"
              >
                <span className="font-medium">{c.channel}</span>
                <span className="flex items-center gap-3 text-xs">
                  <span className="text-success">
                    {t("admin.notificationHealth.ok")}: {c.ok}
                  </span>
                  <span className="text-destructive">
                    {t("admin.notificationHealth.error")}: {c.error}
                  </span>
                  <span className="text-muted-foreground">
                    {t("admin.notificationHealth.skipped")}: {c.skipped}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}

        {data && data.autoDisabledChannels.length > 0 && (
          <div className="mt-4 space-y-1">
            <h2 className="text-sm font-medium">
              {t("admin.notificationHealth.autoDisabled")}
            </h2>
            <div className="flex flex-wrap gap-2">
              {data.autoDisabledChannels.map((d) => (
                <Badge key={d.type} variant="secondary">
                  {d.type} ({d.count})
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
      {testNotification.data?.results &&
        testNotification.data.results.length > 0 && (
          <div className="space-y-1">
            {testNotification.data.results.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                {r.success ? (
                  <CheckCircle2 className="text-success h-3.5 w-3.5 shrink-0" />
                ) : (
                  <XCircle className="text-destructive h-3.5 w-3.5 shrink-0" />
                )}
                <span className="font-medium">{r.channel}</span>
                {r.error && (
                  <span className="text-muted-foreground">{r.error}</span>
                )}
              </div>
            ))}
          </div>
        )}

      <SettingsCardActions>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          onClick={() => testNotification.mutate()}
          disabled={testNotification.isPending}
        >
          {testNotification.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          <Bell className="h-3.5 w-3.5" />
          {t("admin.notificationTestSend")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
