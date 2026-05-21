"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SmilePlus } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface ProfileShape {
  moodReminderEnabled: boolean;
}

export function MoodReminderCard({
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

  const { data: profile } = useQuery({
    queryKey: queryKeys.userProfile(),
    queryFn: async () => {
      const res = await fetch("/api/user/profile");
      if (!res.ok) throw new Error("Failed to load profile");
      return (await res.json()).data as ProfileShape;
    },
    enabled: isAuthenticated,
  });

  const enabled = optimistic ?? profile?.moodReminderEnabled ?? false;

  async function handleToggle(next: boolean) {
    setOptimistic(next);
    setSaving(true);
    setMsg(null);
    setMsgType(null);

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
    } else {
      setOptimistic(null);
      setMsg(t("notifications.moodReminder.saveError"));
      setMsgType("error");
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
