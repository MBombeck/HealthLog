"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, Bell, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";
import { Badge } from "@/components/ui/badge";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { useAdminSettings, useUpdateSettings } from "./_shared";
import { apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";

export function RemindersSection() {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [reminderLateDraft, setReminderLateDraft] = useState<number | null>(
    null,
  );
  const [reminderMissedDraft, setReminderMissedDraft] = useState<number | null>(
    null,
  );

  const reminderCheck = useMutation({
    mutationFn: async () => {
      return apiPost<
        | {
            message?: string;
            medications?: Array<{
              name: string;
              dose: string;
              user: string;
              localTime: string;
              dayOfWeek: string;
              notificationsEnabled: boolean;
              schedules: Array<{
                window: string;
                days: string;
                status: string;
                label: string;
                notificationSent?: boolean;
              }>;
              eventsToday: number;
            }>;
            notificationsSent?: number;
          }
        | undefined
      >("/api/admin/notifications/reminder-check");
    },
    onSuccess: (data) => {
      toast.success(data?.message ?? t("admin.reminderCheckSuccess"));
    },
    onError: (error) => {
      showErrorToast(localizedApiError(error, t, "admin.reminderCheckFailed"), {
        cause: error,
      });
    },
  });

  return (
    <>
      <SettingsCard>
        {/* v1.4.22 — icon swap so the section header matches
          the admin-shell nav tile (Bell). Clock now lives on the
          timing chips inline instead of competing as the page icon. */}
        <SettingsCardHeader
          icon={Bell}
          title={t("admin.medicationReminders")}
          description={t("admin.medicationRemindersDescription")}
        />

        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-reminder-late">
                {t("admin.reminderLateMinutes")}
              </Label>
              <Input
                id="admin-reminder-late"
                aria-describedby="admin-reminder-late-hint"
                type="number"
                inputMode="numeric"
                enterKeyHint="next"
                min={15}
                max={480}
                value={
                  reminderLateDraft ?? settings?.reminderLateMinutes ?? 120
                }
                onChange={(e) => setReminderLateDraft(Number(e.target.value))}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                disabled={updateSettings.isPending}
                className="w-32"
              />
              <p
                id="admin-reminder-late-hint"
                className="text-muted-foreground text-xs"
              >
                {t("admin.reminderLateMinutesDescription")}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-reminder-missed">
                {t("admin.reminderMissedMinutes")}
              </Label>
              <Input
                id="admin-reminder-missed"
                aria-describedby="admin-reminder-missed-hint"
                type="number"
                inputMode="numeric"
                enterKeyHint="done"
                min={30}
                max={720}
                value={
                  reminderMissedDraft ?? settings?.reminderMissedMinutes ?? 240
                }
                onChange={(e) => setReminderMissedDraft(Number(e.target.value))}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                disabled={updateSettings.isPending}
                className="w-32"
              />
              <p
                id="admin-reminder-missed-hint"
                className="text-muted-foreground text-xs"
              >
                {t("admin.reminderMissedMinutesDescription")}
              </p>
            </div>
          </div>
        </div>

        {reminderCheck.data?.medications &&
          reminderCheck.data.medications.length > 0 && (
            <div className="space-y-2">
              {/* v1.4.33 — h4 -> h2 so the page outline stays
                sequential (parent admin SectionFrame ships <h1>). */}
              <h2 className="text-sm font-medium">
                {t("admin.reminderCheckResults")}
              </h2>
              <div className="space-y-2">
                {reminderCheck.data.medications.map((med, i) => (
                  <div
                    key={i}
                    className="bg-muted/50 space-y-1.5 rounded-lg p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        {med.name} ({med.dose})
                      </span>
                      <Badge
                        variant={
                          med.notificationsEnabled ? "default" : "secondary"
                        }
                      >
                        {med.notificationsEnabled
                          ? t("admin.reminderCheckNotifOn")
                          : t("admin.reminderCheckNotifOff")}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {med.user} — {med.dayOfWeek} {med.localTime} —{" "}
                      {t("admin.reminderCheckEventsToday")}: {med.eventsToday}
                    </p>
                    {med.schedules.map((sched, j) => {
                      const statusColor =
                        sched.status === "open"
                          ? "text-success"
                          : sched.status === "threshold"
                            ? "text-warning"
                            : sched.status === "missed"
                              ? "text-destructive"
                              : sched.status === "skipped"
                                ? "text-muted-foreground"
                                : "";
                      return (
                        <div
                          key={j}
                          className="flex items-start gap-1.5 text-xs"
                        >
                          <span className="text-muted-foreground shrink-0">
                            {sched.window}
                          </span>
                          <span className="text-muted-foreground shrink-0">
                            [{sched.days}]
                          </span>
                          <span className={statusColor}>{sched.label}</span>
                          {sched.notificationSent && (
                            <span className="text-success flex shrink-0 items-center gap-0.5">
                              <Bell className="h-3 w-3" />
                              {t("admin.reminderCheckNotifSent")}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}

        <SettingsCardActions>
          <Button
            size="sm"
            variant="outline"
            onClick={() => reminderCheck.mutate()}
            disabled={reminderCheck.isPending}
          >
            {reminderCheck.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            <Activity className="h-3.5 w-3.5" />
            {t("admin.reminderCheckRun")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              updateSettings.mutate(
                {
                  ...(reminderLateDraft != null && {
                    reminderLateMinutes: reminderLateDraft,
                  }),
                  ...(reminderMissedDraft != null && {
                    reminderMissedMinutes: reminderMissedDraft,
                  }),
                },
                {
                  onSuccess: () => {
                    setReminderLateDraft(null);
                    setReminderMissedDraft(null);
                  },
                },
              );
            }}
            disabled={
              updateSettings.isPending ||
              (reminderLateDraft == null && reminderMissedDraft == null)
            }
          >
            {updateSettings.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </SettingsCardActions>
      </SettingsCard>
    </>
  );
}
