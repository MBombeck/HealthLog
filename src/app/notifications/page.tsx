"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Bell, Loader2, Settings, AlertCircle } from "lucide-react";
import {
  EVENT_DEFAULT_ENABLED,
  type EventType,
} from "@/lib/notifications/types";

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
}

/** Maps SCREAMING_SNAKE event type to translation key, e.g. MEDICATION_REMINDER → eventMedicationReminder */
function eventTranslationKey(eventType: string): string {
  return (
    "notifications.event" +
    eventType
      .toLowerCase()
      .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      .replace(/^./, (c) => c.toUpperCase())
  );
}

export default function NotificationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["notifications", "preferences"],
    queryFn: async () => {
      const res = await fetch("/api/notifications/preferences");
      if (!res.ok) throw new Error("Failed to load preferences");
      const json = await res.json();
      return json.data as PreferencesData;
    },
    enabled: isAuthenticated,
  });

  const toggleMutation = useMutation({
    mutationFn: async (params: {
      channelId: string;
      eventType: string;
      enabled: boolean;
    }) => {
      const res = await fetch("/api/notifications/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error("Failed to update preference");
      return res.json();
    },
    onMutate: async ({ channelId, eventType, enabled }) => {
      await queryClient.cancelQueries({
        queryKey: ["notifications", "preferences"],
      });
      const prev = queryClient.getQueryData<PreferencesData>([
        "notifications",
        "preferences",
      ]);
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
          ["notifications", "preferences"],
          { ...prev, preferences: newPreferences },
        );
      }
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(
          ["notifications", "preferences"],
          context.prev,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["notifications", "preferences"],
      });
    },
  });

  function isEnabled(channelId: string, eventType: string): boolean {
    const pref = data?.preferences?.find(
      (p) => p.channelId === channelId && p.eventType === eventType,
    );
    if (pref) return pref.enabled;
    // v1.4.25 W16c — per-event default. Most events stay opt-out
    // (no row = ON); PERSONAL_RECORD flips to opt-in (no row = OFF)
    // so a backfill doesn't fire hundreds of pushes on first sync.
    return EVENT_DEFAULT_ENABLED[eventType as EventType] ?? true;
  }

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("notifications.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("bugreport.loginRequired")}
        </p>
      </div>
    );
  }

  const channels = data?.channels ?? [];
  const eventTypes = data?.eventTypes ?? [];
  const activeChannels = channels.filter((ch) => ch.globallyEnabled);

  if (isError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("notifications.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("notifications.subtitle")}
          </p>
        </div>
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border p-4 text-sm"
        >
          {t("notifications.loadError")}
        </div>
      </div>
    );
  }

  // No channels configured
  if (activeChannels.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("notifications.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("notifications.subtitle")}
          </p>
        </div>
        <div className="bg-card border-border max-w-2xl rounded-xl border p-6">
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <Bell className="text-muted-foreground h-12 w-12" />
            <p className="text-muted-foreground text-sm">
              {t("notifications.noChannels")}
            </p>
            <Button asChild variant="outline">
              <Link href="/settings/notifications">
                <Settings className="mr-2 h-4 w-4" />
                {t("notifications.goToSettings")}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("notifications.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("notifications.subtitle")}
        </p>
      </div>

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
                  <span
                    className={
                      ch.enabled
                        ? "text-muted-foreground"
                        : "text-muted-foreground/70"
                    }
                  >
                    {ch.label}
                  </span>
                  {!ch.enabled && (
                    <span className="text-muted-foreground/70 block text-[10px] normal-case">
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
              const descKey = nameKey + "Desc";
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
          const descKey = nameKey + "Desc";
          return (
            <div
              key={eventType}
              className="bg-card border-border rounded-xl border p-4"
            >
              <div className="mb-3">
                <div className="text-sm font-medium">{t(nameKey)}</div>
                <div className="text-muted-foreground text-xs">
                  {t(descKey)}
                </div>
              </div>
              <div className="space-y-2">
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
                        className={`text-sm ${disabled ? "text-muted-foreground/70" : ""}`}
                      >
                        {ch.label}
                        {disabled && (
                          <span className="text-muted-foreground/70 ml-1 text-xs">
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
              </div>
            </div>
          );
        })}
      </div>

      {/* Info hint about disabled channels */}
      {channels.some((ch) => !ch.globallyEnabled) && (
        <div className="flex items-start gap-2 rounded-lg p-3 text-sm">
          <AlertCircle className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-muted-foreground">
            {t("notifications.channelDisabled")}
          </p>
        </div>
      )}
    </div>
  );
}
