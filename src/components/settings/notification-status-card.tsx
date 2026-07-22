"use client";

/**
 * Per-channel reliability status surface (v1.4.15 Phase B3).
 *
 * Shows for each configured Telegram / ntfy / Web Push channel:
 *  - State badge (Active / Auto-disabled / Sending paused / Manually off)
 *  - Last successful send timestamp
 *  - Last failure + reason
 *  - Consecutive failure counter
 *  - "Re-enable" button when auto-disabled
 *  - "Send test" button (delegates to per-channel test endpoints that
 *    already exist for Telegram, ntfy, Web Push).
 *
 * Pulls data from `GET /api/notifications/status`. Re-enable hits
 * `POST /api/notifications/status`, which clears `disabledReason` +
 * `consecutiveFailures`, then the user can fire a test send via the
 * channel's existing test endpoint.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Clock,
  Loader2,
  RotateCw,
  Send,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet, apiPost } from "@/lib/api/api-fetch";

type ChannelType = "TELEGRAM" | "NTFY" | "WEB_PUSH" | "APNS";

type ChannelState =
  "active" | "auto_disabled" | "manually_disabled" | "sending_paused";

interface ChannelStatus {
  id: string;
  type: ChannelType;
  label: string;
  enabled: boolean;
  state: ChannelState;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  nextRetryAt: string | null;
}

const TEST_ENDPOINTS: Record<ChannelType, string> = {
  TELEGRAM: "/api/settings/telegram/test",
  NTFY: "/api/settings/ntfy/test",
  WEB_PUSH: "/api/notifications/web-push/test",
  APNS: "/api/notifications/apns/test",
};

export function NotificationStatusCard() {
  const hydrated = useMounted();
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.notificationsStatus(),
    queryFn: async () => {
      const data = await apiGet<{ channels: ChannelStatus[] }>(
        "/api/notifications/status",
      );
      return data.channels;
    },
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  });

  const reEnable = useMutation({
    mutationFn: async (channelId: string) => {
      await apiPost("/api/notifications/status", { channelId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.notificationsStatus(),
      });
    },
  });

  const test = useMutation({
    mutationFn: async (channel: ChannelStatus) => {
      const res = await apiFetchRaw(TEST_ENDPOINTS[channel.type], {
        method: "POST",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "test_failed");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.notificationsStatus(),
      });
    },
  });

  // SSR and the first client paint must render the SAME tree shape. `useAuth`
  // reads a client TanStack query, so `isAuthenticated` is `false` on the
  // server (renders `null`) but `true` on the hydrating client (would render
  // the loading card) — different shapes → React #418 hydration mismatch.
  // Gate every auth/loading-dependent branch behind the post-mount probe so
  // both passes render `null`; the real content lands as an ordinary
  // post-hydration client update, not a hydration-time branch.
  if (!hydrated || !isAuthenticated) return null;

  if (isLoading) {
    return (
      <SettingsCard>
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
      </SettingsCard>
    );
  }

  // Defensive: the status endpoint returns `{ channels, events }` where
  // `events` is an object map, not an array. A stale or shape-drifted
  // payload (or a cache read that kept the whole object instead of the
  // `.channels` slice) must never reach `.map` on a non-array — guard the
  // type here rather than white-screening the whole notifications panel.
  const channels = Array.isArray(data) ? data : [];
  if (channels.length === 0) {
    return (
      <SettingsCard data-testid="notification-status-empty">
        <SettingsCardHeader
          icon={Bell}
          title={t("settings.notificationStatus.title")}
          description={t("settings.notificationStatus.emptyDescription")}
        />
      </SettingsCard>
    );
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Bell}
        title={t("settings.notificationStatus.title")}
        description={t("settings.notificationStatus.description")}
      />

      <ul
        className="divide-border/60 mt-4 divide-y pl-7"
        data-testid="notification-status-list"
      >
        {channels.map((ch) => (
          <ChannelRow
            key={ch.id}
            channel={ch}
            formatDateTime={(iso) => fmt.dateTime(iso)}
            t={t}
            onReEnable={() => reEnable.mutate(ch.id)}
            onTest={() => test.mutate(ch)}
            reEnablePending={reEnable.isPending}
            testPending={test.isPending}
          />
        ))}
      </ul>
    </SettingsCard>
  );
}

function ChannelRow({
  channel,
  formatDateTime,
  t,
  onReEnable,
  onTest,
  reEnablePending,
  testPending,
}: {
  channel: ChannelStatus;
  formatDateTime: (iso: string | Date) => string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onReEnable: () => void;
  onTest: () => void;
  reEnablePending: boolean;
  testPending: boolean;
}) {
  const stateBadge = stateBadgeFor(channel.state, t);

  return (
    <li
      className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
      data-testid={`notification-status-row-${channel.type}`}
      data-state={channel.state}
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{channel.label}</span>
          <Badge
            variant={stateBadge.variant}
            className={stateBadge.className}
            data-testid={`notification-status-badge-${channel.type}`}
          >
            {stateBadge.icon}
            <span className="ml-1">{stateBadge.label}</span>
          </Badge>
        </div>
        <dl className="text-muted-foreground space-y-0.5 text-xs">
          {channel.lastSuccessAt && (
            <div>
              <dt className="inline">
                {t("settings.notificationStatus.lastSuccess")}:
              </dt>{" "}
              <dd className="inline" data-testid="last-success">
                {formatDateTime(channel.lastSuccessAt)}
              </dd>
            </div>
          )}
          {channel.lastFailureAt && (
            <div>
              <dt className="inline">
                {t("settings.notificationStatus.lastFailure")}:
              </dt>{" "}
              <dd className="inline" data-testid="last-failure">
                {formatDateTime(channel.lastFailureAt)}
                {channel.lastFailureReason
                  ? ` · ${channel.lastFailureReason}`
                  : ""}
              </dd>
            </div>
          )}
          {channel.consecutiveFailures > 0 && (
            <div>
              <dt className="inline">
                {t("settings.notificationStatus.consecutiveFailures")}:
              </dt>{" "}
              <dd className="inline" data-testid="consecutive-failures">
                {channel.consecutiveFailures}
              </dd>
            </div>
          )}
          {channel.disabledReason && (
            <div>
              <dt className="inline">
                {t("settings.notificationStatus.disabledReason")}:
              </dt>{" "}
              <dd className="inline" data-testid="disabled-reason">
                {channel.disabledReason}
              </dd>
            </div>
          )}
          {channel.state === "sending_paused" && channel.nextRetryAt && (
            <div>
              <dt className="inline">
                {t("settings.notificationStatus.nextRetry")}:
              </dt>{" "}
              <dd className="inline" data-testid="next-retry">
                {formatDateTime(channel.nextRetryAt)}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* v1.4.15 H4 design: action buttons hit the WCAG 2.5.5 44 px
          floor on mobile via `min-h-11`. Settings is the most-touched
          mobile surface; `size="sm"` here clips to ~32 px which the maintainer
          flagged as too small on the iPad/iPhone PWA shell. */}
      <div className="flex flex-wrap gap-2">
        {channel.state === "auto_disabled" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReEnable}
            disabled={reEnablePending}
            data-testid={`re-enable-${channel.type}`}
            className="min-h-11"
          >
            {reEnablePending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            {t("settings.notificationStatus.reEnable")}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onTest}
          disabled={testPending || channel.state === "auto_disabled"}
          data-testid={`send-test-${channel.type}`}
          className="min-h-11"
        >
          {testPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {t("settings.notificationStatus.sendTest")}
        </Button>
      </div>
    </li>
  );
}

function stateBadgeFor(
  state: ChannelState,
  t: (key: string) => string,
): {
  label: string;
  variant: "default" | "outline" | "destructive" | "secondary";
  className: string;
  icon: React.ReactNode;
} {
  switch (state) {
    case "active":
      return {
        label: t("settings.notificationStatus.stateActive"),
        variant: "default",
        className: "border-success/30 bg-success/15 text-success",
        icon: <CheckCircle2 className="h-3 w-3" aria-hidden />,
      };
    case "auto_disabled":
      return {
        label: t("settings.notificationStatus.stateAutoDisabled"),
        variant: "destructive",
        className: "",
        icon: <AlertCircle className="h-3 w-3" aria-hidden />,
      };
    case "sending_paused":
      return {
        label: t("settings.notificationStatus.stateSendingPaused"),
        variant: "outline",
        className: "border-warning/40 text-warning",
        icon: <Clock className="h-3 w-3" aria-hidden />,
      };
    case "manually_disabled":
      return {
        label: t("settings.notificationStatus.stateManuallyDisabled"),
        variant: "secondary",
        className: "",
        icon: <Clock className="h-3 w-3" aria-hidden />,
      };
  }
}
