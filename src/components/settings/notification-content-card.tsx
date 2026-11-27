"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { readUpdatedAtToken, withBaseToken } from "@/lib/api/optimistic-token";

interface NotificationPrefsShape {
  content?: { detail: "generic" | "detailed" };
  updatedAt?: string;
}

/**
 * Settings → Notifications: what a notification may show on a lock screen.
 *
 * Off (the default) keeps every notification to what it is about ("Your
 * morning briefing"); on adds the health figures a notification has, today
 * the morning score. Stored as `notificationPrefs.content.detail` through
 * the same PATCH the iOS app uses, with the optimistic-concurrency token, so
 * a stale web write cannot revert a sibling category.
 */
export function NotificationContentCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    };
  }, []);

  function scheduleClear() {
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setMsg(null);
      setMsgType(null);
    }, 3000);
  }

  const { data: prefs } = useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: async () =>
      apiGet<NotificationPrefsShape>("/api/auth/me/notification-prefs"),
    enabled: isAuthenticated,
  });

  const detailed = optimistic ?? prefs?.content?.detail === "detailed";

  async function handleToggle(next: boolean) {
    setOptimistic(next);
    setSaving(true);
    setMsg(null);
    setMsgType(null);

    try {
      // A request that never reaches the server (offline, a dropped
      // connection) is a failed save like any other, not a stuck one: it
      // falls through to the error branch, and `finally` lowers the flag.
      const res = await apiFetchRaw("/api/auth/me/notification-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withBaseToken(
            { content: { detail: next ? "detailed" : "generic" } },
            readUpdatedAtToken(queryClient, queryKeys.authNotificationPrefs()),
          ),
        ),
      }).catch(() => null);

      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setOptimistic(null);
      if (res?.ok) {
        setMsg(
          next
            ? t("notifications.content.detailedToast")
            : t("notifications.content.genericToast"),
        );
        setMsgType("success");
      } else if (res?.status === 409) {
        setMsg(t("common.conflictReloaded"));
        setMsgType("error");
      } else {
        setMsg(t("notifications.content.saveError"));
        setMsgType("error");
      }
      scheduleClear();
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-notification-content-title"
    >
      <SettingsCardHeader
        icon={LockKeyhole}
        title={t("notifications.content.title")}
        titleId="settings-notification-content-title"
        description={t("notifications.content.description")}
        status={
          <label className="flex min-h-11 items-center gap-3">
            <Switch
              checked={detailed}
              onCheckedChange={handleToggle}
              disabled={!isAuthenticated || saving}
              aria-label={t("notifications.content.toggleAria")}
            />
            <span className="text-muted-foreground text-xs">
              {detailed
                ? t("notifications.content.statusDetailed")
                : t("notifications.content.statusGeneric")}
            </span>
          </label>
        }
      />
      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={
            msgType === "error"
              ? "text-destructive text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {msg}
        </p>
      )}
    </SettingsCard>
  );
}
