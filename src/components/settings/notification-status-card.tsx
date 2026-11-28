"use client";

/**
 * Per-channel reliability status surface (v1.4.15).
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
import { Bell, Loader2, RotateCw, Send } from "lucide-react";

import { StatusChip, type StatusChipTone } from "@/components/ui/status-chip";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { CONFIRMS_INLINE } from "@/lib/api/mutation-feedback";
import { showErrorToast } from "@/lib/errors/error-toast";
import { translateCode } from "@/lib/i18n/translate-code";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { runConnectionTest } from "@/components/settings/test-connection-button";
import { useIntegrationOverview } from "@/lib/queries/use-integration-overview";
import type { OverviewChannelKey } from "@/lib/integrations/overview";

export type ChannelType = "TELEGRAM" | "NTFY" | "WEB_PUSH" | "APNS";

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

/**
 * The per-channel delivery state, shared by this card and the channel cards
 * below it (one query, one cache entry), so a channel card's status chip and
 * this list never disagree.
 */
export function useNotificationChannelStatuses(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.notificationsStatus(),
    queryFn: async () => {
      const data = await apiGet<{ channels: ChannelStatus[] }>(
        "/api/notifications/status",
      );
      return data.channels;
    },
    enabled,
    refetchInterval: 30_000,
  });
}

/** A delivery state as one of the three status words. */
export function channelStatusTone(state: ChannelState): StatusChipTone {
  switch (state) {
    case "active":
      return "active";
    case "auto_disabled":
    case "sending_paused":
      return "error";
    case "manually_disabled":
      return "off";
  }
}

/**
 * The chip a channel card shows in its header: off until the channel is set
 * up and switched on, otherwise the status the integrations overview resolved
 * for it (`resolveChannelState`, the one channel rule), read from the cache
 * the Integrations page already holds.
 */
export function useChannelStatusTone(
  key: OverviewChannelKey,
  isAuthenticated: boolean,
  live: boolean,
): StatusChipTone {
  const overview = useIntegrationOverview(isAuthenticated);
  if (!live) return "off";
  const item = overview.data?.items.find((entry) => entry.key === key);
  return item?.status === "error" ? "error" : "active";
}

export function NotificationStatusCard() {
  const hydrated = useMounted();
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const { data, isLoading } = useNotificationChannelStatuses(isAuthenticated);

  const reEnable = useMutation({
    // Confirms in place: the channel's badge turns back to "Active".
    meta: CONFIRMS_INLINE,
    mutationFn: async (channelId: string) => {
      await apiPost("/api/notifications/status", { channelId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.notificationsStatus(),
      });
    },
  });

  // A test send changes nothing on the row it was started from, so it says
  // how it went, the same words the channel card's own test button uses.
  const test = useMutation({
    mutationFn: (channel: ChannelStatus) =>
      runConnectionTest(TEST_ENDPOINTS[channel.type]),
    onSuccess: (result) => {
      if (result.kind === "ok") {
        toastWrittenOutcome(
          "success",
          t("settings.testConnection.ok", { latency: result.latency }),
        );
      } else {
        showErrorToast(
          translateCode(
            t,
            "settings.testConnection.errors",
            result.errorCode,
            "settings.testConnection.errors.generic",
          ),
        );
      }
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

  // The header paints in every state, so resolving the channel list does not
  // move the page under the cursor.
  if (isLoading) {
    return (
      <SettingsCard>
        <SettingsCardHeader
          anchor="delivery-status"
          icon={Bell}
          title={t("settings.notificationStatus.title")}
        />
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
  // No channel, no status: the channel cards right below are where one is
  // set up, so an empty status card only repeated that.
  if (channels.length === 0) return null;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Bell}
        title={t("settings.notificationStatus.title")}
      />

      <ul
        className="divide-border/60 divide-y"
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
  return (
    <li
      className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
      data-testid={`notification-status-row-${channel.type}`}
      data-state={channel.state}
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{channel.label}</span>
          <StatusChip
            tone={channelStatusTone(channel.state)}
            data-testid={`notification-status-badge-${channel.type}`}
            data-state={channel.state}
          />
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
                  ? `, ${channel.lastFailureReason}`
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
