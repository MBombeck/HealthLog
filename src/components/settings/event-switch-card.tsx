"use client";

/**
 * One notification kind as a card in Settings > Notifications: its name, what
 * it is for, and one switch for every delivery channel at once.
 *
 * The matrix under "Notifications per channel" holds the same answer per
 * channel; this card writes the same rows (`PUT /api/notifications/
 * preferences`, one per active channel) and reads the same payload, so the two
 * cannot disagree. It exists so a kind that matters on its own (a new sign-in,
 * a lasting change in a vital) can be found and switched where people look for
 * notifications, and so it is visible before any channel is set up: then the
 * switch waits, and the one note above the group (`AlertsNoChannelNote`) says
 * where channels are added, once for every card rather than on each.
 */
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { CONFIRM_SAVED } from "@/lib/api/mutation-feedback";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { preferenceCellEnabled } from "@/lib/notifications/event-default-rule";
import {
  eventDescriptionTranslationKey,
  eventTranslationKey,
} from "@/lib/notifications/event-labels";
import { queryKeys } from "@/lib/query-keys";

interface PreferencesPayload {
  channels: Array<{
    id: string;
    enabled: boolean;
    globallyEnabled: boolean;
  }>;
  preferences: Array<{
    channelId: string;
    eventType: string;
    enabled: boolean;
  }>;
  eventTypes: string[];
  eventDefaults?: Record<string, boolean>;
}

/** Where delivery channels are set up. */
export const CHANNELS_HREF = "/settings/integrations#channels";

function usePreferences(isAuthenticated: boolean) {
  return useQuery({
    queryKey: queryKeys.notificationsPreferences(),
    queryFn: () => apiGet<PreferencesPayload>("/api/notifications/preferences"),
    enabled: isAuthenticated,
  });
}

function activeChannels(data: PreferencesPayload | undefined) {
  // A channel the person switched off, or the operator turned off for the
  // server, takes no write: the matrix shows its cell disabled too.
  return (data?.channels ?? []).filter(
    (ch) => ch.enabled && ch.globallyEnabled,
  );
}

/**
 * The one line an alerts group shows while no delivery channel exists: why
 * its switches wait, and where a channel is added.
 */
export function AlertsNoChannelNote({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const prefs = usePreferences(isAuthenticated);
  if (!prefs.isSuccess || activeChannels(prefs.data).length > 0) return null;
  return (
    <p className="text-sm" data-slot="event-switch-no-channel">
      {t("settings.sections.notifications.alerts.noChannel")}{" "}
      <InlineAction size="sm" asChild>
        <Link href={CHANNELS_HREF}>
          {t("settings.sections.notifications.alerts.setUpChannel")}
        </Link>
      </InlineAction>
    </p>
  );
}

export function EventSwitchCard({
  eventType,
  anchor,
  icon,
  isAuthenticated,
}: {
  eventType: string;
  anchor: string;
  icon: LucideIcon;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const prefs = usePreferences(isAuthenticated);
  const channels = activeChannels(prefs.data);
  const offered = prefs.data?.eventTypes.includes(eventType) ?? true;
  const on = channels.some((ch) =>
    preferenceCellEnabled(prefs.data, ch.id, eventType),
  );

  const write = useMutation({
    meta: CONFIRM_SAVED,
    mutationFn: async (enabled: boolean) => {
      for (const ch of channels) {
        await apiPut("/api/notifications/preferences", {
          channelId: ch.id,
          eventType,
          enabled,
        });
      }
    },
    onError: (error) => {
      showErrorToast(t("settings.sections.notifications.alerts.saveError"), {
        cause: error,
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.notificationsPreferences(),
      }),
  });

  if (!offered) return null;
  const name = t(eventTranslationKey(eventType));
  const noChannel = prefs.isSuccess && channels.length === 0;

  return (
    <SettingsCard data-slot={`event-switch-${anchor}`}>
      <SettingsCardHeader
        anchor={anchor}
        icon={icon}
        title={name}
        description={t(eventDescriptionTranslationKey(eventType))}
        status={
          <Switch
            aria-label={name}
            checked={on && !noChannel}
            disabled={
              !prefs.isSuccess ||
              noChannel ||
              write.isPending ||
              !isAuthenticated
            }
            onCheckedChange={(checked: boolean) => write.mutate(checked)}
          />
        }
      />
      {prefs.isError ? (
        <QueryErrorRow
          inset
          error={prefs.error}
          message={t("notifications.loadError")}
          onRetry={() => void prefs.refetch()}
        />
      ) : null}
    </SettingsCard>
  );
}
