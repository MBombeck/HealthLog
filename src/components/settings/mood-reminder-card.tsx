"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SmilePlus } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface ProfileShape {
  moodReminderEnabled: boolean;
}

interface NotificationPrefsShape {
  mood: { reminderHour: number };
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
      const res = await fetch("/api/user/profile");
      if (!res.ok) throw new Error("Failed to load profile");
      return (await res.json()).data as ProfileShape;
    },
    enabled: isAuthenticated,
  });

  // v1.7.0 — the per-user reminder hour lives in the roaming
  // notification-prefs blob so iOS + web share one source of truth.
  const { data: prefs } = useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: async () => {
      const res = await fetch("/api/auth/me/notification-prefs");
      if (!res.ok) throw new Error("Failed to load notification prefs");
      return (await res.json()).data as NotificationPrefsShape;
    },
    enabled: isAuthenticated,
  });

  const enabled = optimistic ?? profile?.moodReminderEnabled ?? false;
  const reminderHour = optimisticHour ?? prefs?.mood.reminderHour ?? 22;

  async function handleToggle(next: boolean) {
    setOptimistic(next);
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    const res = await fetch("/api/user/profile", {
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.userProfile() });
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

    const res = await fetch("/api/auth/me/notification-prefs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mood: { reminderHour: next } }),
    });

    if (res.ok) {
      setMsg(t("notifications.moodReminder.hourSavedToast"));
      setMsgType("success");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setOptimisticHour(null);
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
    <section
      aria-labelledby="settings-mood-reminder-title"
      className="bg-card rounded-lg border p-4 sm:p-6"
    >
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
      {enabled && (
        <div className="mt-4 flex min-h-11 items-center gap-3">
          <label
            htmlFor="mood-reminder-hour"
            className="text-sm font-medium"
          >
            {t("notifications.moodReminder.hourLabel")}
          </label>
          <select
            id="mood-reminder-hour"
            className="border-input bg-background h-11 rounded-md border px-3 text-sm"
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
          </select>
        </div>
      )}
      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={
            msgType === "error"
              ? "text-destructive mt-3 text-sm"
              : "text-muted-foreground mt-3 text-sm"
          }
        >
          {msg}
        </p>
      )}
    </section>
  );
}
