"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SmilePlus } from "lucide-react";

import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { readUpdatedAtToken, withBaseToken } from "@/lib/api/optimistic-token";

interface ProfileShape {
  moodReminderEnabled: boolean;
}

interface NotificationPrefsShape {
  mood: { reminderHour: number };
  // v1.32.22 (R5b) — optimistic-concurrency token, a sibling key on the
  // resolved prefs response, echoed on the reminder-hour PATCH.
  updatedAt?: string;
}

export function MoodReminderCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [optimisticHour, setOptimisticHour] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  // v1.4.49 — auto-clear the inline `<p role="status">` line 3 s after
  // the mutation settles so a Settings card the user scrolled past
  // minutes earlier doesn't keep echoing a stale "reminder enabled"
  // banner. Mirrors the `<DisableCoachCard>` pattern landed in v1.4.48
  // M2; the v1.4.48 docstring claimed this card already auto-cleared,
  // this commit backfills the actual behaviour. The ref tracks the
  // in-flight timer so we can clear it on unmount + on a follow-up
  // toggle (otherwise a rapid double-tap could leave a stray timer
  // pointing at a stale message).
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);

  function scheduleClear() {
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setMsg(null);
      setMsgType(null);
    }, 3000);
  }

  const { data: profile } = useQuery({
    queryKey: queryKeys.userProfile(),
    queryFn: async () => {
      return apiGet<ProfileShape>("/api/user/profile");
    },
    enabled: isAuthenticated,
  });

  // v1.7.0 — the per-user reminder hour lives in the roaming
  // notification-prefs blob so iOS + web share one source of truth.
  const { data: prefs } = useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: async () => {
      return apiGet<NotificationPrefsShape>("/api/auth/me/notification-prefs");
    },
    enabled: isAuthenticated,
  });

  const enabled = optimistic ?? profile?.moodReminderEnabled ?? false;
  const reminderHour = optimisticHour ?? prefs?.mood?.reminderHour ?? 22;

  async function handleToggle(next: boolean) {
    setOptimistic(next);
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    const res = await apiFetchRaw("/api/user/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moodReminderEnabled: next }),
    });

    if (res.ok) {
      setMsg(
        next
          ? t("notifications.moodReminder.enabledToast")
          : t("notifications.moodReminder.disabledToast"),
      );
      setMsgType("success");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.userProfile(),
      });
      setOptimistic(null);
      scheduleClear();
    } else {
      setOptimistic(null);
      setMsg(t("notifications.moodReminder.saveError"));
      setMsgType("error");
      scheduleClear();
    }
    setSaving(false);
  }

  async function handleHourChange(next: number) {
    setOptimisticHour(next);
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    // v1.32.22 (R5b) — echo the base token so a concurrent notification-prefs
    // write (the iOS client's `clientManaged` flag, another web card) 409s
    // instead of silently reverting a sibling category through the deep-merge.
    const res = await apiFetchRaw("/api/auth/me/notification-prefs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        withBaseToken(
          { mood: { reminderHour: next } },
          readUpdatedAtToken(queryClient, queryKeys.authNotificationPrefs()),
        ),
      ),
    });

    if (res.ok) {
      setMsg(t("notifications.moodReminder.hourSavedToast"));
      setMsgType("success");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setOptimisticHour(null);
      scheduleClear();
    } else if (res.status === 409) {
      // The prefs advanced since they were loaded. Revert the optimistic hour
      // and refetch (the active query reseeds a fresh token), then nudge — the
      // change did not persist, so ask the user to re-apply it.
      setOptimisticHour(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setMsg(t("common.conflictReloaded"));
      setMsgType("error");
      scheduleClear();
    } else {
      setOptimisticHour(null);
      setMsg(t("notifications.moodReminder.saveError"));
      setMsgType("error");
      scheduleClear();
    }
    setSaving(false);
  }

  return (
    <SettingsCard as="section" aria-labelledby="settings-mood-reminder-title">
      <SettingsCardHeader
        icon={SmilePlus}
        title={t("notifications.moodReminder.title")}
        titleId="settings-mood-reminder-title"
        description={t("notifications.moodReminder.description")}
        status={
          <label className="flex min-h-11 items-center gap-3">
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={!isAuthenticated || saving}
              aria-label={t("notifications.moodReminder.toggleAria")}
            />
            <span className="text-muted-foreground text-xs">
              {enabled
                ? t("notifications.moodReminder.statusOn")
                : t("notifications.moodReminder.statusOff")}
            </span>
          </label>
        }
      />
      <p className="text-sm">{t("notifications.moodReminder.detail")}</p>
      {enabled && (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <label htmlFor="mood-reminder-hour" className="text-sm font-medium">
            {t("notifications.moodReminder.hourLabel")}
          </label>
          <NativeSelect
            id="mood-reminder-hour"
            className="w-auto"
            value={reminderHour}
            disabled={!isAuthenticated || saving}
            onChange={(e) => handleHourChange(Number(e.target.value))}
            aria-label={t("notifications.moodReminder.hourAria")}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {`${h.toString().padStart(2, "0")}:00`}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
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
