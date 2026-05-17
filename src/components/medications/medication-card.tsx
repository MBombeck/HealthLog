"use client";

import { useState, useEffect, useReducer } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { MedicationCardHeader } from "@/components/medications/MedicationCardHeader";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { formatDateTime, formatTime } from "@/lib/format";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import {
  parseTimeToMinutes,
  reduceCurrentWindowStatus,
  toBerlinDate,
} from "@/lib/medications/window-status";
import {
  Check,
  SkipForward,
  Flame,
  Pencil,
  Loader2,
  History,
} from "lucide-react";
import Link from "next/link";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

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

export function MedicationCard({ medication, onEdit }: MedicationCardProps) {
  const queryClient = useQueryClient();
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);

  const { data: compliance } = useQuery({
    queryKey: ["medications", medication.id, "compliance"],
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
    queryKey: ["settings", "reminder-thresholds"],
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
    <>
      {!medication.notificationsEnabled && (
        <Badge variant="secondary" className="text-xs">
          {t("medications.withoutNotification")}
        </Badge>
      )}
      {!medication.active && (
        <Badge variant="secondary" className="text-xs">
          {medication.pausedAt
            ? `${t("medications.pausedSince")} ${formatDateTime(medication.pausedAt)}`
            : t("medications.inactive")}
        </Badge>
      )}
    </>
  );

  const headerActions = (
    <>
      {/* Phase A5: bumped from `h-8 w-8` (32px) to `min-h-11
          min-w-11` (44px) so these meet the WCAG 2.5.5 minimum
          tap-target on mobile without the icon glyph itself
          changing size. */}
      <Button
        variant="ghost"
        size="icon"
        className="min-h-11 min-w-11"
        asChild
        aria-label={t("medications.intakeHistory")}
      >
        <Link href={`/medications/${medication.id}/history`}>
          <History className="h-4 w-4" />
        </Link>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="min-h-11 min-w-11"
        onClick={() => onEdit(medication)}
        aria-label={t("common.edit")}
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </>
  );

  return (
    <Card className={medication.active ? "" : "opacity-60"}>
      <MedicationCardHeader
        name={medication.name}
        dose={medication.dose}
        categoryLabel={categoryLabel}
        stateBadges={stateBadges}
        actions={headerActions}
      />

      <CardContent className="space-y-3.5">
        {/* Status, last & next intake info */}
        {currentWindowStatus.status && (
          <p className="text-sm">
            <span
              className={
                currentWindowStatus.status === "in_window"
                  ? "text-success font-medium"
                  : currentWindowStatus.status === "late"
                    ? "text-dracula-yellow font-medium"
                    : "text-warning font-medium"
              }
            >
              {currentWindowStatus.status === "in_window"
                ? t("medications.takeNow")
                : currentWindowStatus.status === "late"
                  ? t("medications.overdue")
                  : t("medications.veryOverdue")}
            </span>
            <span className="text-muted-foreground hidden sm:inline">
              {" "}
              —{" "}
              {formatTimeWindowRange(
                currentWindowStatus.schedule!.windowStart,
                currentWindowStatus.schedule!.windowEnd,
                locale,
              )}
            </span>
          </p>
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
          <div className="space-y-2.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("medications.compliance7d")}
                </span>
                <span className="font-medium">{rate7}%</span>
              </div>
              {/* v1.4.33 IW9 — aria-label so the bar has an accessible name. */}
              <Progress
                value={rate7}
                className="h-2"
                aria-label={t("medications.compliance7d")}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("medications.compliance30d")}
                </span>
                <span className="font-medium">{rate30}%</span>
              </div>
              <Progress
                value={rate30}
                className="h-2"
                aria-label={t("medications.compliance30d")}
              />
            </div>

            <div className="flex items-center gap-4 text-xs">
              {streak > 0 && (
                <span className="flex items-center gap-1 font-medium text-orange-400">
                  <Flame className="h-3.5 w-3.5" />
                  {streak} {t("medications.dayStreak")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Quick actions — primary buttons of the medication card.
            Phase A5 mobile audit flagged the previous size="sm" / 32-px
            height as below the WCAG 44-px minimum. These are the most-
            tapped controls in HealthLog, so they get the full default
            button height. */}
        {medication.active && (
          <div className="flex gap-2">
            <Button
              className="min-h-11 flex-1"
              onClick={() => recordIntake(false)}
              disabled={!!intakeLoading}
            >
              {intakeLoading === "take" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Check className="mr-1 h-4 w-4" />
              )}
              {t("medications.taken")}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => recordIntake(true)}
              disabled={!!intakeLoading}
            >
              {intakeLoading === "skip" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <SkipForward className="mr-1 h-4 w-4" />
              )}
              {t("medications.skipped")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
