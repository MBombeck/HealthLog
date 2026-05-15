"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, Bell, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import {
  getApiErrorMessage,
  useAdminSettings,
  useUpdateSettings,
} from "./_shared";

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

  const testNotification = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/notifications/test", {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      const json = (await res.json()) as {
        data?: {
          message?: string;
          results?: Array<{
            channel: string;
            success: boolean;
            error?: string;
          }>;
        };
      };
      return json.data;
    },
    onSuccess: (data) => {
      const hasFailures = data?.results?.some((r) => !r.success);
      if (hasFailures) {
        toast.error(data?.message ?? t("admin.notificationTestFailed"));
      } else {
        toast.success(data?.message ?? t("admin.notificationTestSuccess"));
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.notificationTestFailed"),
      );
    },
  });

  const reminderCheck = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/notifications/reminder-check", {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      const json = (await res.json()) as {
        data?: {
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
        };
      };
      return json.data;
    },
    onSuccess: (data) => {
      toast.success(data?.message ?? t("admin.reminderCheckSuccess"));
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("admin.reminderCheckFailed"),
      );
    },
  });

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        {/* v1.4.22 D / F-58 — icon swap so the section header matches
            the admin-shell nav tile (Bell). Clock now lives on the
            timing chips inline instead of competing as the page icon. */}
        <Bell className="text-primary h-5 w-5" />
        <div className="text-lg font-semibold">
          {t("admin.medicationReminders")}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("admin.medicationRemindersDescription")}
      </p>

      <div className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="admin-reminder-late" className="text-xs">
              {t("admin.reminderLateMinutes")}
            </Label>
            <p className="text-muted-foreground text-xs">
              {t("admin.reminderLateMinutesDescription")}
            </p>
            <Input
              id="admin-reminder-late"
              type="number"
              inputMode="numeric"
              enterKeyHint="next"
              min={15}
              max={480}
              value={reminderLateDraft ?? settings?.reminderLateMinutes ?? 120}
              onChange={(e) => setReminderLateDraft(Number(e.target.value))}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              disabled={updateSettings.isPending}
              className="w-32"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-reminder-missed" className="text-xs">
              {t("admin.reminderMissedMinutes")}
            </Label>
            <p className="text-muted-foreground text-xs">
              {t("admin.reminderMissedMinutesDescription")}
            </p>
            <Input
              id="admin-reminder-missed"
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
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => testNotification.mutate()}
          disabled={testNotification.isPending}
        >
          {testNotification.isPending && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          <Bell className="mr-1.5 h-3.5 w-3.5" />
          {t("admin.notificationTestSend")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => reminderCheck.mutate()}
          disabled={reminderCheck.isPending}
        >
          {reminderCheck.isPending && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          <Activity className="mr-1.5 h-3.5 w-3.5" />
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
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.save")}
        </Button>
      </div>

      {testNotification.data?.results &&
        testNotification.data.results.length > 0 && (
          <div className="mt-4 space-y-1">
            {testNotification.data.results.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                {r.success ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-400" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                )}
                <span className="font-medium">{r.channel}</span>
                {r.error && (
                  <span className="text-muted-foreground">— {r.error}</span>
                )}
              </div>
            ))}
          </div>
        )}

      {reminderCheck.data?.medications &&
        reminderCheck.data.medications.length > 0 && (
          <div className="mt-4 space-y-2">
            <h4 className="text-sm font-medium">
              {t("admin.reminderCheckResults")}
            </h4>
            <div className="space-y-2">
              {reminderCheck.data.medications.map((med, i) => (
                <div key={i} className="bg-muted/50 space-y-1.5 rounded-lg p-3">
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
                        ? "text-green-400"
                        : sched.status === "threshold"
                          ? "text-yellow-400"
                          : sched.status === "missed"
                            ? "text-red-400"
                            : sched.status === "skipped"
                              ? "text-muted-foreground"
                              : "";
                    return (
                      <div key={j} className="flex items-start gap-1.5 text-xs">
                        <span className="text-muted-foreground shrink-0">
                          {sched.window}
                        </span>
                        <span className="text-muted-foreground shrink-0">
                          [{sched.days}]
                        </span>
                        <span className={statusColor}>{sched.label}</span>
                        {sched.notificationSent && (
                          <span className="flex shrink-0 items-center gap-0.5 text-green-400">
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
    </div>
  );
}
