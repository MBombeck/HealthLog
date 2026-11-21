"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";

import { NativeSelect } from "@/components/ui/native-select";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { readUpdatedAtToken, withBaseToken } from "@/lib/api/optimistic-token";
import { useSnoozeMinutes } from "@/lib/queries/use-snooze-minutes";
import { SNOOZE_MINUTE_CHOICES } from "@/lib/medications/snooze-length";

/**
 * Settings → Notifications: how long "Remind me later" pushes a dose
 * reminder back. One value per person
 * (`notificationPrefs.medication.snoozeMinutes`, default 30) that the
 * medication card, Telegram's reminder button and the app's notification
 * action all use, so "later" means the same everywhere. Saves on change.
 */
export function DoseSnoozeCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const stored = useSnoozeMinutes(isAuthenticated);
  const [optimistic, setOptimistic] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minutes = optimistic ?? stored;
  // A stored length outside the offered list (set by another client) stays
  // selectable instead of silently reading as a different value.
  const choices = (SNOOZE_MINUTE_CHOICES as readonly number[]).includes(minutes)
    ? SNOOZE_MINUTE_CHOICES
    : [...SNOOZE_MINUTE_CHOICES, minutes].sort((a, b) => a - b);

  async function save(next: number) {
    setOptimistic(next);
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetchRaw("/api/auth/me/notification-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withBaseToken(
            { medication: { snoozeMinutes: next } },
            readUpdatedAtToken(queryClient, queryKeys.authNotificationPrefs()),
          ),
        ),
      }).catch(() => null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      if (!res?.ok) {
        setError(
          res?.status === 409
            ? t("common.conflictReloaded")
            : t("settings.sections.notifications.snooze.saveError"),
        );
      }
      setOptimistic(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard as="section" aria-labelledby="settings-dose-snooze-title">
      <SettingsCardHeader
        icon={BellRing}
        title={t("settings.sections.notifications.snooze.title")}
        titleId="settings-dose-snooze-title"
        description={t("settings.sections.notifications.snooze.description")}
      />
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor="dose-snooze-minutes" className="text-sm font-medium">
          {t("settings.sections.notifications.snooze.label")}
        </label>
        <NativeSelect
          id="dose-snooze-minutes"
          className="w-auto"
          value={minutes}
          disabled={!isAuthenticated || saving}
          onChange={(e) => void save(Number(e.target.value))}
          data-slot="dose-snooze-minutes"
        >
          {choices.map((m) => (
            <option key={m} value={m}>
              {t("settings.sections.notifications.snooze.option", {
                minutes: m,
              })}
            </option>
          ))}
        </NativeSelect>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
