"use client";

/**
 * The scheduled doctor report: once a month, quarter or year has closed, the
 * report for it is filed into the documents on its own, with the selection
 * chosen in the export panel above. Off by default. No notification: the PDF
 * is simply there, which is the point.
 *
 * The card shows what the server stamped: the last period settled and how
 * it ended, and the period the next run files. It never computes a period
 * itself; the server answers from the record's clock.
 */
import { CONFIRM_SAVED } from "@/lib/api/mutation-feedback";
import { useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiDelete, apiGet, apiPut } from "@/lib/api/api-fetch";
import {
  REPORT_SCHEDULE_CADENCES,
  REPORT_SCHEDULE_WINDOWS,
  type ReportScheduleCadence,
  type ReportScheduleOutcome,
  type ReportScheduleWindow,
} from "@/lib/doctor-report/schedule-shape";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface ReportScheduleView {
  cadence: ReportScheduleCadence;
  window: ReportScheduleWindow;
  lastPeriod: string | null;
  lastOutcome: ReportScheduleOutcome | null;
  lastRunAt: string | null;
  duePeriod: string | null;
}

interface ReportScheduleStatus {
  schedule: ReportScheduleView | null;
}

const PATH = "/api/settings/report-schedule";
const KEY = queryKeys.settingsReportSchedule();

export function ReportScheduleCard() {
  const { t } = useTranslations();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: KEY,
    queryFn: () => apiGet<ReportScheduleStatus>(PATH),
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationKey: KEY,
    meta: CONFIRM_SAVED,
    mutationFn: (body: {
      cadence: ReportScheduleCadence;
      window: ReportScheduleWindow;
    }) => apiPut<ReportScheduleStatus>(PATH, body),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  const off = useMutation({
    mutationKey: KEY,
    meta: CONFIRM_SAVED,
    mutationFn: () => apiDelete(PATH),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  // The choice before the schedule exists; once on, the stored one is shown.
  const [draft, setDraft] = useState<{
    cadence: ReportScheduleCadence;
    window: ReportScheduleWindow;
  }>({ cadence: "MONTHLY", window: "PERIOD" });

  const schedule = status.data?.schedule ?? null;
  const shown = schedule
    ? { cadence: schedule.cadence, window: schedule.window }
    : draft;
  const change = (next: typeof shown) =>
    schedule ? save.mutate(next) : setDraft(next);
  const busy = save.isPending || off.isPending;

  return (
    <SettingsCard data-slot="report-schedule">
      <SettingsCardHeader
        anchor="report-schedule"
        icon={CalendarClock}
        title={t("reportSchedule.title")}
        description={t("reportSchedule.description")}
      />
      {status.isError ? (
        <QueryErrorCard
          error={status.error}
          title={t("reportSchedule.loadError")}
          onRetry={() => void status.refetch()}
        />
      ) : status.isLoading || !status.data ? (
        <div className="flex h-16 items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="report-schedule-cadence">
                {t("reportSchedule.cadenceLabel")}
              </Label>
              <NativeSelect
                id="report-schedule-cadence"
                value={shown.cadence}
                disabled={busy}
                onChange={(e) =>
                  change({
                    ...shown,
                    cadence: e.target.value as ReportScheduleCadence,
                  })
                }
              >
                {REPORT_SCHEDULE_CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {t(`reportSchedule.cadence.${c}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-schedule-window">
                {t("reportSchedule.windowLabel")}
              </Label>
              <NativeSelect
                id="report-schedule-window"
                value={shown.window}
                disabled={busy}
                onChange={(e) =>
                  change({
                    ...shown,
                    window: e.target.value as ReportScheduleWindow,
                  })
                }
              >
                {REPORT_SCHEDULE_WINDOWS.map((w) => (
                  <option key={w} value={w}>
                    {t(`reportSchedule.window.${w}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <p className="text-muted-foreground text-sm">
            {t("reportSchedule.usesSelection")}
          </p>
          {schedule ? <StatusLines schedule={schedule} /> : null}
          <SettingsCardActions>
            {schedule ? (
              <ConfirmButton
                label={t("reportSchedule.turnOff")}
                title={t("reportSchedule.turnOffTitle")}
                body={t("reportSchedule.turnOffBody")}
                confirmLabel={t("reportSchedule.turnOff")}
                onConfirm={() => off.mutate()}
                pending={off.isPending}
                size="sm"
              />
            ) : (
              <Button
                size="sm"
                onClick={() => save.mutate(draft)}
                disabled={busy}
              >
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : null}
                {t("reportSchedule.turnOn")}
              </Button>
            )}
          </SettingsCardActions>
        </>
      )}
      {save.isError || off.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {t("reportSchedule.saveError")}
        </p>
      ) : null}
    </SettingsCard>
  );
}

/** What the server stamped, and what it files next. */
function StatusLines({ schedule }: { schedule: ReportScheduleView }) {
  const { t } = useTranslations();
  return (
    <div className="space-y-1" data-slot="report-schedule-status">
      {schedule.lastOutcome && schedule.lastPeriod ? (
        <p className="text-sm">
          {t(`reportSchedule.outcome.${schedule.lastOutcome}`, {
            period: schedule.lastPeriod,
          })}
        </p>
      ) : schedule.lastOutcome ? (
        <p className="text-sm">
          {t(`reportSchedule.outcome.${schedule.lastOutcome}`, {
            period: schedule.duePeriod ?? "",
          })}
        </p>
      ) : null}
      <p className="text-muted-foreground text-sm">
        {schedule.duePeriod
          ? t("reportSchedule.due", { period: schedule.duePeriod })
          : t("reportSchedule.upToDate")}
      </p>
    </div>
  );
}
