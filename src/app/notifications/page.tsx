"use client";

import type { ReactNode } from "react";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import Link from "next/link";
import { Bell, Settings, AlertCircle } from "lucide-react";
import {
  eventDescriptionTranslationKey,
  eventTranslationKey,
} from "@/lib/notifications/event-labels";
import { queryKeys } from "@/lib/query-keys";
import { preferenceCellEnabled } from "@/lib/notifications/event-default-rule";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface ChannelInfo {
  id: string;
  type: string;
  label: string;
  enabled: boolean;
  globallyEnabled: boolean;
}

interface Preference {
  channelId: string;
  eventType: string;
  enabled: boolean;
}

interface PreferencesData {
  channels: ChannelInfo[];
  preferences: Preference[];
  eventTypes: string[];
  /**
   * What each event does on a channel with no stored row, resolved by the
   * server for this account with the function the dispatcher uses.
   */
  /** Absent on a response cached by a build before the field. */
  eventDefaults?: Record<string, boolean>;
}

export default function NotificationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.notificationsPreferences(),
    queryFn: async () => {
      return apiGet<PreferencesData>("/api/notifications/preferences");
    },
    enabled: isAuthenticated,
  });

  const toggleMutation = useMutation({
    mutationFn: async (params: {
      channelId: string;
      eventType: string;
      enabled: boolean;
    }) => {
      return apiPut("/api/notifications/preferences", params);
    },
    onMutate: async ({ channelId, eventType, enabled }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.notificationsPreferences(),
      });
      const prev = queryClient.getQueryData<PreferencesData>(
        queryKeys.notificationsPreferences(),
      );
      if (prev) {
        const existing = prev.preferences.find(
          (p) => p.channelId === channelId && p.eventType === eventType,
        );
        const newPreferences = existing
          ? prev.preferences.map((p) =>
              p.channelId === channelId && p.eventType === eventType
                ? { ...p, enabled }
                : p,
            )
          : [...prev.preferences, { channelId, eventType, enabled }];
        queryClient.setQueryData<PreferencesData>(
          queryKeys.notificationsPreferences(),
          { ...prev, preferences: newPreferences },
        );
      }
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(
          queryKeys.notificationsPreferences(),
          context.prev,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.notificationsPreferences(),
      });
    },
  });

  function isEnabled(channelId: string, eventType: string): boolean {
    // No row: the server's resolved default for this account. Read, never
    // recomputed here: the mood reminder's follows the reminder card, and a
    // copy of the constant table showed it off while it was being delivered.
    // A cached payload without the map falls back to the shared rule.
    return preferenceCellEnabled(data, channelId, eventType);
  }

  // Cross-links to the other two notification surfaces (reminder types +
  // delivery channels) so the matrix never reads as the only place to manage
  // notifications. Mirrored by back-links on those two settings screens.
  const headerActions = (
    <>
      <Button asChild variant="outline" size="sm">
        <Link href="/settings/notifications">
          {t("notifications.reminderSettingsLink")}
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm">
        <Link href="/settings/integrations#channels">
          {t("notifications.channelsLink")}
        </Link>
      </Button>
    </>
  );

  if (authLoading || isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t("notifications.title")}
          description={t("notifications.subtitle")}
        />
        {/* Skeleton mirrors the event-row matrix so the auth-resolving frame
            reserves layout instead of flashing a lone spinner. */}
        <div
          data-slot="notifications-loading"
          className="bg-card border-border overflow-hidden rounded-xl border"
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="border-border flex items-center justify-between gap-4 border-b p-4 last:border-b-0"
            >
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40 rounded" />
                <Skeleton className="h-3 w-56 rounded" />
              </div>
              <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t("notifications.title")}
          description={t("notifications.loginRequired")}
        />
      </div>
    );
  }

  const channels = data?.channels ?? [];
  const eventTypes = data?.eventTypes ?? [];
  const activeChannels = channels.filter((ch) => ch.globallyEnabled);

  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t("notifications.title")}
          description={t("notifications.subtitle")}
        />
        <QueryErrorCard
          error={error}
          description={t("notifications.loadError")}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  if (activeChannels.length === 0) {
    return (
      <NoChannelPage eventTypes={eventTypes} headerActions={headerActions} />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("notifications.title")}
        description={t("notifications.subtitle")}
        actions={headerActions}
        stackActionsOnPhone
      />

      {/* Desktop: table layout */}
      <div className="bg-card border-border hidden overflow-hidden rounded-xl border md:block">
        <table className="w-full">
          <thead>
            <tr className="border-border border-b">
              <th className="text-muted-foreground px-4 py-3 text-left text-xs font-medium tracking-wider uppercase">
                {t("notifications.eventColumn")}
              </th>
              {activeChannels.map((ch) => (
                <th
                  key={ch.id}
                  className="px-4 py-3 text-center text-xs font-medium tracking-wider uppercase"
                >
                  {/* Disabled state reads through the note + the disabled
                      switches below — never through sub-AA opacity dimming
                      on the label or the note itself. */}
                  <span className="text-muted-foreground">{ch.label}</span>
                  {!ch.enabled && (
                    <span className="text-muted-foreground block text-xs normal-case">
                      {t("notifications.channelDisabled")}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {eventTypes.map((eventType, idx) => {
              const nameKey = eventTranslationKey(eventType);
              const descKey = eventDescriptionTranslationKey(eventType);
              return (
                <tr
                  key={eventType}
                  className={
                    idx < eventTypes.length - 1 ? "border-border border-b" : ""
                  }
                >
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium">{t(nameKey)}</div>
                    <div className="text-muted-foreground text-xs">
                      {t(descKey)}
                    </div>
                  </td>
                  {activeChannels.map((ch) => {
                    const enabled = isEnabled(ch.id, eventType);
                    const disabled = !ch.enabled;
                    const switchLabel = `${t(nameKey)} - ${ch.label}`;
                    return (
                      <td key={ch.id} className="px-4 py-3 text-center">
                        <Switch
                          aria-label={switchLabel}
                          checked={enabled && !disabled}
                          disabled={disabled || toggleMutation.isPending}
                          onCheckedChange={(checked: boolean) =>
                            toggleMutation.mutate({
                              channelId: ch.id,
                              eventType,
                              enabled: checked,
                            })
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-4 md:hidden">
        {eventTypes.map((eventType) => {
          const nameKey = eventTranslationKey(eventType);
          const descKey = eventDescriptionTranslationKey(eventType);
          return (
            <Card key={eventType} className="gap-3">
              <CardHeader className="gap-1">
                <CardTitle className="text-sm font-medium">
                  {t(nameKey)}
                </CardTitle>
                <CardDescription className="text-xs">
                  {t(descKey)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {activeChannels.map((ch) => {
                  const enabled = isEnabled(ch.id, eventType);
                  const disabled = !ch.enabled;
                  const switchId = `notification-${eventType}-${ch.id}`;
                  return (
                    <div
                      key={ch.id}
                      className="flex items-center justify-between"
                    >
                      <Label
                        htmlFor={switchId}
                        className={`text-sm ${disabled ? "text-muted-foreground" : ""}`}
                      >
                        {ch.label}
                        {disabled && (
                          <span className="text-muted-foreground ml-1 text-xs">
                            ({t("notifications.channelDisabled")})
                          </span>
                        )}
                      </Label>
                      <Switch
                        id={switchId}
                        checked={enabled && !disabled}
                        disabled={disabled || toggleMutation.isPending}
                        onCheckedChange={(checked: boolean) =>
                          toggleMutation.mutate({
                            channelId: ch.id,
                            eventType,
                            enabled: checked,
                          })
                        }
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Info hint about globally-disabled channels — a full sentence that
          explains the state, not the bare "(Disabled)" inline tag. */}
      {channels.some((ch) => !ch.globallyEnabled) && (
        <div className="flex items-start gap-2 rounded-lg p-3 text-sm">
          <AlertCircle className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-muted-foreground">
            {t("notifications.someChannelsGloballyDisabled")}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * No channel configured yet. The kinds are still listed: a notification that
 * is off by default (a lasting change in a vital) has to be findable before
 * anything can deliver it, and an empty page said nothing about what there is
 * to receive.
 */
function NoChannelPage({
  eventTypes,
  headerActions,
}: {
  eventTypes: string[];
  headerActions: ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("notifications.title")}
        description={t("notifications.subtitle")}
        actions={headerActions}
        stackActionsOnPhone
      />
      <EmptyState
        className="max-w-2xl"
        icon={<Bell className="size-6" />}
        title={t("notifications.noChannels")}
        /* Channel setup lives in Settings → Integrations since v1.25.7;
           point the CTA at that anchor, not the reminder-types screen. */
        action={
          <Button asChild variant="outline">
            <Link href="/settings/integrations#channels">
              <Settings className="h-4 w-4" />
              {t("notifications.goToSettings")}
            </Link>
          </Button>
        }
      />
      <div
        data-slot="notifications-kinds-without-channel"
        className="bg-card border-border overflow-hidden rounded-xl border"
      >
        <ul className="divide-border divide-y">
          {eventTypes.map((eventType) => (
            <li key={eventType} className="px-4 py-3">
              <div className="text-sm font-medium">
                {t(eventTranslationKey(eventType))}
              </div>
              <div className="text-muted-foreground text-xs">
                {t(eventDescriptionTranslationKey(eventType))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
