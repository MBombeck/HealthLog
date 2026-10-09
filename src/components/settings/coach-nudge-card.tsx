"use client";

/**
 * v1.15.20 — Settings → Notifications opt-out for the proactive Coach
 * nudge (the daily 05:15 cron that points the user at /coach
 * when a deterministic trigger fires). Default ON; the toggle writes
 * `notificationPrefs.coach.nudgesEnabled` through the roaming
 * notification-prefs blob so web + iOS share one source of truth.
 *
 * v1.16.5 — per-group toggles (medication / vitals / routine) plus the
 * frequency pref (weekly / biweekly) underneath the master switch. All
 * of it rides the same `coach` sub-object of the prefs blob; the cron
 * resolves it via `resolveCoachNudgePrefs`.
 *
 * Mirrors `<MoodReminderCard>` (optimistic switch, auto-clearing inline
 * status line, NativeSelect for the enum pref).
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircleHeart } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { NativeSelect } from "@/components/ui/native-select";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { readUpdatedAtToken, withBaseToken } from "@/lib/api/optimistic-token";

interface CoachPrefsShape {
  nudgesEnabled: boolean;
  nudgeMedication: boolean;
  nudgeVitals: boolean;
  nudgeRoutine: boolean;
  nudgeFrequency: "weekly" | "biweekly";
  nudgeAiComposed: boolean;
}

interface NotificationPrefsShape {
  coach: CoachPrefsShape;
  // v1.32.22 (R5b) — optimistic-concurrency token, a sibling key on the
  // resolved prefs response, echoed on every PATCH from this card.
  updatedAt?: string;
}

const COACH_PREF_DEFAULTS: CoachPrefsShape = {
  nudgesEnabled: true,
  nudgeMedication: true,
  nudgeVitals: true,
  nudgeRoutine: true,
  nudgeFrequency: "weekly",
  nudgeAiComposed: false,
};

const GROUP_FIELDS = [
  "nudgeMedication",
  "nudgeVitals",
  "nudgeRoutine",
] as const;
type GroupField = (typeof GROUP_FIELDS)[number];

const GROUP_I18N: Record<GroupField, { label: string; desc: string }> = {
  nudgeMedication: {
    label: "notifications.coachNudge.groupMedication",
    desc: "notifications.coachNudge.groupMedicationDesc",
  },
  nudgeVitals: {
    label: "notifications.coachNudge.groupVitals",
    desc: "notifications.coachNudge.groupVitalsDesc",
  },
  nudgeRoutine: {
    label: "notifications.coachNudge.groupRoutine",
    desc: "notifications.coachNudge.groupRoutineDesc",
  },
};

export function CoachNudgeCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<Partial<CoachPrefsShape>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

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

  const { data: prefs } = useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: async () => {
      return apiGet<NotificationPrefsShape>("/api/auth/me/notification-prefs");
    },
    enabled: isAuthenticated,
  });

  const resolved: CoachPrefsShape = {
    ...COACH_PREF_DEFAULTS,
    ...(prefs?.coach ?? {}),
    ...optimistic,
  };
  const enabled = resolved.nudgesEnabled;

  /**
   * One PATCH path for every knob on the card. `toast` carries the
   * success line for the master toggle; the sub-prefs pass null and
   * stay silent on success — the control itself shows the new state.
   */
  async function patchCoach(
    partial: Partial<CoachPrefsShape>,
    toast: string | null,
  ) {
    setOptimistic((prev) => ({ ...prev, ...partial }));
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    // v1.32.22 (R5b) — echo the base token so a concurrent notification-prefs
    // write (the iOS client, another web card) 409s instead of reverting a
    // sibling category through the server-side deep-merge.
    const res = await apiFetchRaw("/api/auth/me/notification-prefs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        withBaseToken(
          { coach: partial },
          readUpdatedAtToken(queryClient, queryKeys.authNotificationPrefs()),
        ),
      ),
    });

    if (res.ok) {
      if (toast) {
        setMsg(toast);
        setMsgType("success");
        scheduleClear();
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setOptimistic({});
    } else if (res.status === 409) {
      // The prefs advanced since they were loaded. Revert the optimistic knob
      // and refetch (the active query reseeds a fresh token), then nudge — the
      // change did not persist, so ask the user to re-apply it.
      setOptimistic({});
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setMsg(t("common.conflictReloaded"));
      setMsgType("error");
      scheduleClear();
    } else {
      setOptimistic({});
      setMsg(t("notifications.coachNudge.saveError"));
      setMsgType("error");
      scheduleClear();
    }
    setSaving(false);
  }

  async function handleToggle(next: boolean) {
    await patchCoach(
      { nudgesEnabled: next },
      next
        ? t("notifications.coachNudge.enabledToast")
        : t("notifications.coachNudge.disabledToast"),
    );
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-coach-nudge-title"
      data-testid="settings-coach-nudge-card"
    >
      <SettingsCardHeader
        icon={MessageCircleHeart}
        title={t("notifications.coachNudge.title")}
        titleId="settings-coach-nudge-title"
        description={t("notifications.coachNudge.description")}
        status={
          <label className="flex min-h-11 items-center gap-3">
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={!isAuthenticated || saving}
              aria-label={t("notifications.coachNudge.toggleAria")}
            />
            <span className="text-muted-foreground text-xs">
              {enabled
                ? t("notifications.coachNudge.statusOn")
                : t("notifications.coachNudge.statusOff")}
            </span>
          </label>
        }
      />
      {enabled && (
        <div className="space-y-3">
          <p className="text-sm font-medium">
            {t("notifications.coachNudge.groupsLabel")}
          </p>
          {GROUP_FIELDS.map((field) => (
            <div
              key={field}
              className="flex min-h-11 items-center justify-between gap-3"
              data-testid={`coach-nudge-group-${field}`}
            >
              <div className="min-w-0">
                <p className="text-sm">{t(GROUP_I18N[field].label)}</p>
                <p className="text-muted-foreground text-xs">
                  {t(GROUP_I18N[field].desc)}
                </p>
              </div>
              <Switch
                checked={resolved[field]}
                onCheckedChange={(next) => patchCoach({ [field]: next }, null)}
                disabled={!isAuthenticated || saving}
                aria-label={t(GROUP_I18N[field].label)}
              />
            </div>
          ))}
          {/* Stacked on a phone: at 16 px touch type the longest option
              ("At most every two weeks") plus the label no longer fits one
              row inside a 390 px card. */}
          <div className="flex min-h-11 flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
            <label
              htmlFor="coach-nudge-frequency"
              className="text-sm font-medium"
            >
              {t("notifications.coachNudge.frequencyLabel")}
            </label>
            <NativeSelect
              id="coach-nudge-frequency"
              className="sm:w-auto"
              value={resolved.nudgeFrequency}
              disabled={!isAuthenticated || saving}
              onChange={(e) =>
                patchCoach(
                  {
                    nudgeFrequency: e.target.value as "weekly" | "biweekly",
                  },
                  null,
                )
              }
              aria-label={t("notifications.coachNudge.frequencyAria")}
            >
              <option value="weekly">
                {t("notifications.coachNudge.frequencyWeekly")}
              </option>
              <option value="biweekly">
                {t("notifications.coachNudge.frequencyBiweekly")}
              </option>
            </NativeSelect>
          </div>
          {/* v1.25.0 — opt-in for AI-composed nudge copy. Off by default: the
              deterministic warm template is the baseline and the fail-closed
              fallback; this only lets the model phrase the nudge when a
              provider is healthy. */}
          <div className="flex min-h-11 items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">
                {t("notifications.coachNudge.aiComposedLabel")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("notifications.coachNudge.aiComposedDesc")}
              </p>
            </div>
            <Switch
              checked={resolved.nudgeAiComposed}
              onCheckedChange={(next) =>
                patchCoach({ nudgeAiComposed: next }, null)
              }
              disabled={!isAuthenticated || saving}
              aria-label={t("notifications.coachNudge.aiComposedAria")}
            />
          </div>
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
    </SettingsCard>
  );
}
