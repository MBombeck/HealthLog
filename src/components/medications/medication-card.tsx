"use client";

import { useState, useEffect, useReducer } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { MedicationCardHeader } from "@/components/medications/MedicationCardHeader";
import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import { MedicationComplianceBars } from "@/components/medications/card-parts/medication-compliance-bars";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { formatDateTime, formatTime } from "@/lib/format";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import {
  parseTimeToMinutes,
  reduceCurrentWindowStatus,
  toBerlinDate,
} from "@/lib/medications/window-status";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  /**
   * v1.4.25 W4d — Prisma treatment-class discriminator. When set to
   * "GLP1" the parent should render the {@link Glp1MedicationCard}
   * variant instead of this generic card. The field is optional for
   * backwards compatibility with mocks.
   */
  treatmentClass?: string;
  dosesPerUnit?: number | null;
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  todayEventCount?: number;
  schedules: Schedule[];
}

interface ComplianceData {
  compliance7: {
    totalExpected: number;
    taken: number;
    skipped: number;
    missed: number;
    rate: number;
    streak: number;
  };
  compliance30: {
    rate: number;
  };
}

interface MedicationCardProps {
  medication: Medication;
  onEdit: (med: Medication) => void;
  /**
   * v1.7.1 — routes to the medication's full intake-history view
   * (`/medications/{id}/history`), mirroring the detail-header History
   * button. The parent owns the navigation.
   */
  onOpenHistory: (med: Medication) => void;
  /**
   * v1.7.1 — opens the shared `<AdvancedSettingsSheet>` (mounted by the
   * list page) for this medication, mirroring the detail-header sliders
   * button.
   */
  onOpenAdvanced: (med: Medication) => void;
}

function getNextOccurrenceTimestamp(
  schedule: Schedule,
  nowBerlin: Date,
): number | null {
  const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
  const baseDay = new Date(nowBerlin);
  baseDay.setHours(0, 0, 0, 0);

  const nowMinutes = nowBerlin.getHours() * 60 + nowBerlin.getMinutes();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const baseWeekIndex = Math.floor(baseDay.getTime() / weekMs);
  const startMinutes = parseTimeToMinutes(schedule.windowStart);

  for (let offset = 0; offset <= 400; offset += 1) {
    const candidate = new Date(baseDay);
    candidate.setDate(baseDay.getDate() + offset);

    const candidateWeekIndex = Math.floor(candidate.getTime() / weekMs);
    const isAllowedWeek =
      recurrence.intervalWeeks <= 1 ||
      candidateWeekIndex % recurrence.intervalWeeks ===
        baseWeekIndex % recurrence.intervalWeeks;
    if (!isAllowedWeek) continue;

    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(candidate.getDay())
    ) {
      continue;
    }

    if (offset === 0 && startMinutes <= nowMinutes) {
      continue;
    }

    return candidate.getTime() + startMinutes * 60 * 1000;
  }

  return null;
}

export function MedicationCard({
  medication,
  onEdit,
  onOpenHistory,
  onOpenAdvanced,
}: MedicationCardProps) {
  const queryClient = useQueryClient();
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);

  const { data: compliance } = useQuery({
    queryKey: queryKeys.medicationCompliance(medication.id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medication.id}/compliance`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ComplianceData;
    },
    staleTime: 30 * 1000,
  });

  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      const res = await fetch("/api/settings/reminder-thresholds");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as { lateMinutes: number; missedMinutes: number };
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const interval = setInterval(forceUpdate, 60_000);
    return () => clearInterval(interval);
  }, []);

  async function recordIntake(skipped: boolean) {
    const key = skipped ? "skip" : "take";
    setIntakeLoading(key);
    try {
      const res = await fetch(`/api/medications/${medication.id}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipped }),
      });
      if (res.ok) {
        await invalidateKeys(queryClient, medicationDependentKeys);
      }
    } finally {
      setIntakeLoading(null);
    }
  }

  const rate7 = compliance?.compliance7?.rate ?? 0;
  const rate30 = compliance?.compliance30?.rate ?? 0;
  const streak = compliance?.compliance7?.streak ?? 0;
  const categoryLabel = getMedicationCategoryLabel(medication.category, t);
  const sortedSchedules = [...medication.schedules].sort(
    (a, b) =>
      a.windowStart.localeCompare(b.windowStart) ||
      a.windowEnd.localeCompare(b.windowEnd),
  );
  const nowBerlin = toBerlinDate(new Date());
  const nextOccurrence =
    sortedSchedules.length > 0
      ? (sortedSchedules
          .map((schedule) => ({
            schedule,
            nextAt: getNextOccurrenceTimestamp(schedule, nowBerlin),
          }))
          .filter((entry): entry is { schedule: Schedule; nextAt: number } =>
            Number.isFinite(entry.nextAt),
          )
          .sort((a, b) => a.nextAt - b.nextAt)[0] ?? null)
      : null;
  const nextSchedule = nextOccurrence?.schedule ?? sortedSchedules[0] ?? null;

  const lateMinutes = thresholds?.lateMinutes ?? 120;
  const missedMinutes = thresholds?.missedMinutes ?? 240;

  const currentWindowStatus = reduceCurrentWindowStatus({
    schedules: sortedSchedules,
    nowBerlin,
    lateMinutes,
    missedMinutes,
    active: medication.active,
    lastTakenAt: medication.lastTakenAt,
    todayEventCount: medication.todayEventCount ?? 0,
  });

  function formatLastTakenAt(value: string): string {
    // Intentionally en-CA: gives YYYY-MM-DD which is locale-independent and
    // string-comparable for the today / yesterday / older bucketing below.
    // The actual user-facing display goes through formatTime / formatDateTime.
    const dayFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const intakeDay = dayFormatter.format(new Date(value));
    const todayDay = dayFormatter.format(now);
    const yesterdayDay = dayFormatter.format(yesterday);
    const time = formatTime(value);

    if (intakeDay === todayDay) return `${t("medications.today")}, ${time}`;
    if (intakeDay === yesterdayDay)
      return `${t("medications.yesterday")}, ${time}`;
    return formatDateTime(value);
  }

  const stateBadges = (
    <MedicationStateBadges
      notificationsEnabled={medication.notificationsEnabled}
      active={medication.active}
      pausedAt={medication.pausedAt}
    />
  );

  // v1.7.2 W3 — the four former header icon-buttons (open / edit /
  // history / advanced) collapse into a single overflow kebab. The card
  // header itself links to the detail page (the former chevron target).
  const headerActions = (
    <MedicationCardMenu
      onEdit={() => onEdit(medication)}
      onOpenHistory={() => onOpenHistory(medication)}
      onOpenAdvanced={() => onOpenAdvanced(medication)}
    />
  );

  return (
    <Card className={medication.active ? "" : "opacity-60"}>
      <MedicationCardHeader
        name={medication.name}
        dose={medication.dose}
        categoryLabel={categoryLabel}
        stateBadges={stateBadges}
        actions={headerActions}
        href={`/medications/${medication.id}`}
        linkLabel={t("medications.openDetailPage")}
      />

      <CardContent className="space-y-3.5">
        {/* Status, last & next intake info */}
        {currentWindowStatus.status && (
          <MedicationStatusPill
            status={currentWindowStatus.status}
            windowStart={currentWindowStatus.schedule!.windowStart}
            windowEnd={currentWindowStatus.schedule!.windowEnd}
          />
        )}

        {nextSchedule &&
          currentWindowStatus.status !== "in_window" &&
          (() => {
            const s = nextSchedule;
            const nextAt = nextOccurrence?.nextAt;

            // Format day label relative to today
            let dayLabel = "";
            if (nextAt) {
              const nextDate = toBerlinDate(new Date(nextAt));
              const todayStr = `${nowBerlin.getFullYear()}-${nowBerlin.getMonth()}-${nowBerlin.getDate()}`;
              const nextStr = `${nextDate.getFullYear()}-${nextDate.getMonth()}-${nextDate.getDate()}`;
              const tomorrow = new Date(nowBerlin);
              tomorrow.setDate(tomorrow.getDate() + 1);
              const tomorrowStr = `${tomorrow.getFullYear()}-${tomorrow.getMonth()}-${tomorrow.getDate()}`;

              const diffDays = Math.round(
                (nextDate.getTime() - nowBerlin.getTime()) /
                  (24 * 60 * 60 * 1000),
              );

              if (nextStr === todayStr) {
                dayLabel = t("medications.today");
              } else if (nextStr === tomorrowStr) {
                dayLabel = t("medications.tomorrow");
              } else if (diffDays <= 5) {
                const weekdayLabels = [
                  t("medications.weekdaySunday"),
                  t("medications.weekdayMonday"),
                  t("medications.weekdayTuesday"),
                  t("medications.weekdayWednesday"),
                  t("medications.weekdayThursday"),
                  t("medications.weekdayFriday"),
                  t("medications.weekdaySaturday"),
                ];
                dayLabel = weekdayLabels[nextDate.getDay()];
              } else {
                dayLabel = fmt.dateWithWeekday(nextDate);
              }
            }

            return (
              <p className="text-muted-foreground text-sm">
                <span className="font-medium">
                  {t("medications.nextIntake")}
                </span>{" "}
                {dayLabel && `${dayLabel}, `}
                {formatTimeWindowRange(s.windowStart, s.windowEnd, locale)}
                {s.label && (
                  <span className="hidden sm:inline"> ({s.label})</span>
                )}
                {s.dose && (
                  <span className="hidden font-medium text-purple-400 sm:inline">
                    {" "}
                    — {s.dose}
                  </span>
                )}
              </p>
            );
          })()}

        {medication.lastTakenAt && (
          <p className="text-muted-foreground text-sm">
            <span className="font-medium">{t("medications.lastIntake")}</span>{" "}
            {formatLastTakenAt(medication.lastTakenAt)}
          </p>
        )}

        {/* Compliance bar */}
        {medication.active && compliance && (
          <MedicationComplianceBars
            rate7={rate7}
            rate30={rate30}
            streak={streak}
          />
        )}

        {/* Quick actions — primary buttons of the medication card. */}
        {medication.active && (
          <MedicationIntakeActions
            intakeLoading={intakeLoading}
            onRecordIntake={recordIntake}
          />
        )}
      </CardContent>
    </Card>
  );
}
